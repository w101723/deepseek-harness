import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { randomBytes } from 'node:crypto';

const previousKey=process.env.DATASOURCE_MASTER_KEY;
const previousHosts=process.env.DATASOURCE_ALLOWED_HOSTS;
process.env.DATASOURCE_MASTER_KEY=randomBytes(32).toString('hex');
process.env.DATASOURCE_ALLOWED_HOSTS='db.example.internal';
let suspended=null;
const fakeMySQL=async()=>({
  async execute({sql}){
    if(sql.startsWith('SELECT 1'))return [[{connected:1}]];
    if(sql.includes('information_schema.columns'))return [[
      {schema_name:'analytics',table_name:'orders',column_name:'region',data_type:'text'},
      {schema_name:'analytics',table_name:'orders',column_name:'amount',data_type:'numeric'}
    ]];
    if(suspended && sql.includes('SUM(')){
      const current=suspended;suspended=null;current.started();await current.hold;
    }
    return [[{region:'华东',sum_amount:100}]];
  },
  async end(){}
});
const app=createApp({demoMode:true,drivers:{mysql:fakeMySQL}});
await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
const base='http://127.0.0.1:'+app.server.address().port;
async function request(path,method='GET',body,auth){
  const response=await fetch(base+path,{method,
    headers:{...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
function gate(){
  let started,release;
  const entry={ready:new Promise(resolve=>{started=resolve;}),hold:new Promise(resolve=>{release=resolve;})};
  suspended={started,hold:entry.hold};
  return {...entry,release};
}
test('an in-flight external query is rejected after role or policy revocation',async()=>{
  const login=await request('/api/login','POST',{email:'admin@demo.local',password:'DemoOnly!2026'});
  const auth={cookie:login.cookie,csrf:login.data.user.csrf},tenant=login.data.user.tenantId,user=login.data.user.id;
  const workspace=(await request('/api/workspaces','GET',undefined,auth)).data.items[0];
  const source=await request('/api/datasources','POST',{workspaceId:workspace.id,name:'secured',kind:'mysql',host:'db.example.internal',database:'analytics',user:'readonly',password:'test'},auth);
  assert.equal(source.status,201,JSON.stringify(source.data));
  const dataset=await request('/api/datasets','POST',{name:'orders',datasourceId:source.data.id,schema:'analytics',table:'orders'},auth);
  assert.equal(dataset.status,201);
  const spec={datasetId:dataset.data.id,dimensions:['region'],metrics:['sum_amount']};
  const g1=gate(),running=request('/api/query','POST',spec,auth);
  await g1.ready;
  app.db.prepare('UPDATE memberships SET role=? WHERE tenant_id=? AND user_id=?').run('viewer',tenant,user);
  g1.release();
  const blocked=await running;
  assert.equal(blocked.status,403);
  assert.ok(!JSON.stringify(blocked.data).includes('sum_amount'));
  app.db.prepare('UPDATE memberships SET role=? WHERE tenant_id=? AND user_id=?').run('admin',tenant,user);
  const g2=gate(),second=request('/api/query','POST',spec,auth);
  await g2.ready;
  const change=await request('/api/datasets/'+dataset.data.id+'/policies','PATCH',{
    role:'admin',version:0,canQuery:true,dimensions:null,metrics:null,
    rowFilters:[{field:'region',op:'eq',value:'华北'}]
  },auth);
  assert.equal(change.status,200);
  g2.release();
  assert.equal((await second).status,409);
});
test.after(async()=>{
  await new Promise(resolve=>app.server.close(resolve));
  if(previousKey===undefined)delete process.env.DATASOURCE_MASTER_KEY;else process.env.DATASOURCE_MASTER_KEY=previousKey;
  if(previousHosts===undefined)delete process.env.DATASOURCE_ALLOWED_HOSTS;else process.env.DATASOURCE_ALLOWED_HOSTS=previousHosts;
});
