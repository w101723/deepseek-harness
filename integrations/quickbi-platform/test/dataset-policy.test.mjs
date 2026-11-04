import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/db.mjs';
import { createAgentBridge } from '../src/agent-bridge.mjs';

const oldKey=process.env.DATASOURCE_MASTER_KEY;
const oldHosts=process.env.DATASOURCE_ALLOWED_HOSTS;
process.env.DATASOURCE_MASTER_KEY=randomBytes(32).toString('hex');
process.env.DATASOURCE_ALLOWED_HOSTS='db.example.internal';

const executed=[];
const mysqlFactory=async()=>({
  async execute({sql,values=[]}){
    executed.push({sql,values});
    if(sql.includes('information_schema.columns'))return [[
      {schema_name:'analytics',table_name:'orders',column_name:'region',data_type:'text'},
      {schema_name:'analytics',table_name:'orders',column_name:'secret',data_type:'text'},
      {schema_name:'analytics',table_name:'orders',column_name:'amount',data_type:'decimal'},
    ]];
    if(sql.startsWith('SELECT 1'))return [[{connected:1}]];
    if(sql.includes('GROUP BY'))return [[{region:'华东',sum_amount:120}]];
    return [[{rows:1}]];
  },async end(){}
});
const app=createApp({demoMode:true,drivers:{mysql:mysqlFactory}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}`;
async function api(path,method='GET',body,auth){
  const response=await fetch(base+path,{method,headers:{...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
let admin,viewer,datasetId,viewerId,viewerSessionId;
test('row/column policy flows through UI query, AIPro, and Harness tool bridge',async t=>{
  const logged=await api('/api/login','POST',{email:'admin@demo.local',password:'DemoOnly!2026'});
  admin={cookie:logged.cookie,csrf:logged.body.user.csrf};
  const tenantId=logged.body.user.tenantId;
  const space=(await api('/api/workspaces','GET',undefined,admin)).body.items[0];
  const src=await api('/api/datasources','POST',{kind:'mysql',name:'Scoped orders',workspaceId:space.id,host:'db.example.internal',database:'analytics',user:'read_only',password:'hidden'},admin);
  assert.equal(src.status,201);
  const dataset=await api('/api/datasets','POST',{datasourceId:src.body.id,name:'Controlled model',schema:'analytics',table:'orders'},admin);
  assert.equal(dataset.status,201);datasetId=dataset.body.id;
  viewerId='viewer-role-policy-test';
  app.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(viewerId,'scoped.viewer@local',hashPassword('ViewerLongPassword!'),'Viewer');
  app.db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(tenantId,viewerId,'viewer');
  const vlogin=await api('/api/login','POST',{email:'scoped.viewer@local',password:'ViewerLongPassword!'});
  viewer={cookie:vlogin.cookie,csrf:vlogin.body.user.csrf};

  await t.test('viewer denied by default; no field metadata leakage',async()=>{
    assert.equal((await api('/api/query','POST',{datasetId,dimensions:['region'],metrics:['sum_amount']},viewer)).status,403);
    const catalog=await api('/api/datasets','GET',undefined,viewer);
    assert.equal(catalog.status,200);
    assert.ok(!catalog.body.items.some(x=>x.id===datasetId));
  });

  await t.test('admin can grant viewer and constrain rows and columns',async()=>{
    const patch={role:'viewer',version:0,canQuery:true,dimensions:['region'],metrics:['sum_amount'],rowFilters:[{field:'region',op:'eq',value:'华东'}]};
    const r=await api(`/api/datasets/${datasetId}/policies`,'PATCH',patch,admin);
    assert.equal(r.status,200);
    assert.equal(r.body.item.version,1);
    const listed=(await api('/api/datasets','GET',undefined,viewer)).body.items.find(x=>x.id===datasetId);
    assert.deepEqual(listed.dimensions,['region']);assert.deepEqual(listed.metrics,['sum_amount']);
    assert.equal(listed.dimensions_json,undefined);
    const q=await api('/api/query','POST',{datasetId,dimensions:['region'],metrics:['sum_amount'],filters:[{field:'region',op:'ne',value:'华东'}]},viewer);
    assert.equal(q.status,200);
    const bound=executed.at(-1);
    assert.ok(bound.sql.includes('`region` <> ? AND `region` = ?'),bound.sql);
    assert.deepEqual(bound.values.slice(0,2),['华东','华东']);
    assert.equal((await api('/api/query','POST',{datasetId,dimensions:['secret'],metrics:['sum_amount']},viewer)).status,403);
    assert.equal((await api('/api/query','POST',{datasetId,dimensions:['region'],metrics:['sum_amount'],filters:[{field:'secret',op:'eq',value:'anything'}]},viewer)).status,403);
    assert.equal((await api('/api/query','POST',{datasetId,dimensions:['region'],metrics:['rows']},viewer)).status,403);
    const sess=await api('/api/ai/sessions','POST',{datasetId,title:'Viewer scoped'},viewer);
    assert.equal(sess.status,201);viewerSessionId=sess.body.id;
    const asked=await api(`/api/ai/sessions/${sess.body.id}/ask`,'POST',{question:'region sum_amount'},viewer);
    assert.equal(asked.status,200);
    assert.ok(executed.at(-1).values.includes('华东'));
    assert.equal((await api(`/api/datasets/${datasetId}/policies`,'GET',undefined,viewer)).status,403);
    assert.equal((await api(`/api/datasets/${datasetId}/policies`,'PATCH',patch,viewer)).status,403);
  });

  await t.test('revocation and optimistic version reject old capabilities',async()=>{
    const tenant=app.db.prepare('SELECT tenant_id FROM memberships WHERE user_id=?').get(viewerId).tenant_id;
    const bridge=createAgentBridge(app.db,{drivers:{mysql:mysqlFactory}});
    const handle=bridge.open({tenantId:tenant,userId:viewerId,role:'viewer'},datasetId);
    assert.equal((await bridge.dispatch(handle.token,{action:'catalog'})).dimensions.includes('secret'),false);
    assert.deepEqual(Object.keys((await bridge.dispatch(handle.token,{action:'catalog'})).metrics),['sum_amount']);
    const blocked=await api(`/api/datasets/${datasetId}/policies`,'PATCH',{role:'viewer',version:1,canQuery:false},admin);
    assert.equal(blocked.status,200);
    assert.equal((await api(`/api/datasets/${datasetId}/policies`,'PATCH',{role:'viewer',version:1,canQuery:true},admin)).status,409);
    await assert.rejects(bridge.dispatch(handle.token,{action:'query',spec:{dimensions:['region'],metrics:['sum_amount']}}),{status:403});
    handle.close();
    assert.equal((await api('/api/query','POST',{datasetId,dimensions:['region'],metrics:['sum_amount']},viewer)).status,403);
    const restored=await api(`/api/datasets/${datasetId}/policies`,'PATCH',{role:'viewer',version:2,canQuery:true,dimensions:['region'],metrics:['sum_amount'],rowFilters:[{field:'region',op:'eq',value:'华东'}]},admin);
    assert.equal(restored.status,200);
    const history=await api(`/api/ai/sessions/${viewerSessionId}`,'GET',undefined,viewer);
    assert.equal(history.status,200);
    assert.ok(history.body.messages.some(m=>m.role==='assistant'&&m.redacted&&m.result===null));
  });

  await t.test('artifact evidence becomes inaccessible after policy revision',async()=>{
    const s=await api('/api/ai/sessions','POST',{datasetId,title:'Administrator report'},admin);
    assert.equal(s.status,201);
    assert.equal((await api(`/api/ai/sessions/${s.body.id}/ask`,'POST',{question:'sum_amount region'},admin)).status,200);
    const a=await api('/api/ai/artifacts','POST',{sessionId:s.body.id,name:'Stored report'},admin);
    assert.equal(a.status,201);
    assert.equal((await api(`/api/ai/artifacts/${a.body.id}`,'GET',undefined,admin)).status,200);
    const changed=await api(`/api/datasets/${datasetId}/policies`,'PATCH',{role:'editor',version:0,canQuery:true,dimensions:['region'],metrics:['sum_amount']},admin);
    assert.equal(changed.status,200);
    assert.equal((await api(`/api/ai/artifacts/${a.body.id}`,'GET',undefined,admin)).status,409);
    assert.ok(!(await api('/api/ai/artifacts','GET',undefined,admin)).body.items.some(x=>x.id===a.body.id));
    assert.equal((await api('/api/ai/artifacts','POST',{sessionId:s.body.id,name:'Should fail'},admin)).status,409);
  });

  await t.test('invalid policies and cross-tenant datasets are rejected',async()=>{
    const malicious=await api(`/api/datasets/${datasetId}/policies`,'PATCH',{role:'viewer',version:3,canQuery:true,rowFilters:[{field:'region` OR TRUE --',op:'eq',value:'华东'}]},admin);
    assert.equal(malicious.status,400);
    const tenant2=app.db.prepare("SELECT id FROM tenants WHERE name='隔离测试企业'").get().id;
    const space2=app.db.prepare('SELECT id FROM workspaces WHERE tenant_id=?').get(tenant2).id;
    app.db.prepare('INSERT INTO datasources(id,tenant_id,workspace_id,name,kind) VALUES (?,?,?,?,?)').run('source-foreign',tenant2,space2,'foreign source','demo-sqlite');
    app.db.prepare('INSERT INTO datasets(id,tenant_id,workspace_id,datasource_id,name,dimensions_json,metrics_json) VALUES (?,?,?,?,?,?,?)').run('dataset-foreign',tenant2,space2,'source-foreign','foreign dataset','["region"]','["revenue"]');
    assert.equal((await api('/api/datasets/dataset-foreign/policies','GET',undefined,admin)).status,404);
  });
});
test.after(async()=>{
  await new Promise(r=>app.server.close(r));
  if(oldKey===undefined)delete process.env.DATASOURCE_MASTER_KEY;else process.env.DATASOURCE_MASTER_KEY=oldKey;
  if(oldHosts===undefined)delete process.env.DATASOURCE_ALLOWED_HOSTS;else process.env.DATASOURCE_ALLOWED_HOSTS=oldHosts;
});

test('downgrading the creator role hides old AI analysis evidence and artifacts',async()=>{
  const instance=createApp({demoMode:true});
  await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${instance.server.address().port}`;
  async function request(path,method='GET',data,auth){
    const response=await fetch(origin+path,{method,headers:{...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  try{
    const login=await request('/api/login','POST',{email:'admin@demo.local',password:'DemoOnly!2026'});
    const auth={cookie:login.cookie,csrf:login.body.user.csrf};
    const dataset=(await request('/api/datasets','GET',undefined,auth)).body.items[0];
    const session=await request('/api/ai/sessions','POST',{datasetId:dataset.id},auth);
    assert.equal((await request(`/api/ai/sessions/${session.body.id}/ask`,'POST',{question:'区域销售额'},auth)).status,200);
    const art=await request('/api/ai/artifacts','POST',{sessionId:session.body.id,name:'Old report'},auth);
    assert.equal(art.status,201);
    instance.db.prepare("UPDATE memberships SET role='viewer' WHERE tenant_id=? AND user_id=?").run(login.body.user.tenantId,login.body.user.id);
    const read=await request(`/api/ai/sessions/${session.body.id}`,'GET',undefined,auth);
    assert.equal(read.status,200);
    assert.ok(read.body.messages.some(x=>x.role==='assistant'&&x.redacted&&x.result===null));
    assert.equal((await request(`/api/ai/artifacts/${art.body.id}`,'GET',undefined,auth)).status,409);
    assert.equal((await request('/api/ai/artifacts','GET',undefined,auth)).body.items.length,0);
  }finally{await new Promise(r=>instance.server.close(r));}
});
