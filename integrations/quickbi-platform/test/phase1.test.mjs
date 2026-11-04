import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {openDatabase} from '../src/db.mjs';
import {compileExternalQuery} from '../src/query-external.mjs';
import {decryptCredentials} from '../src/connectors.mjs';

const oldKey=process.env.DATASOURCE_MASTER_KEY,oldHosts=process.env.DATASOURCE_ALLOWED_HOSTS;
process.env.DATASOURCE_MASTER_KEY=randomBytes(32).toString('hex');
process.env.DATASOURCE_ALLOWED_HOSTS='db.example.internal,pg.example.internal';
const queries=[];
const fakeMysql=async options=>{
  assert.equal(options.host,'db.example.internal');
  assert.equal(options.multipleStatements,false);
  return {
    async execute(q){
      const sql=typeof q==='string'?q:q.sql;
      queries.push({sql,params:q.values});
      if(sql.includes('information_schema.columns'))return [[
        {schema_name:'analytics',table_name:'orders',column_name:'region',data_type:'varchar'},
        {schema_name:'analytics',table_name:'orders',column_name:'amount',data_type:'decimal'},
        {schema_name:'analytics',table_name:'orders',column_name:'order_id',data_type:'bigint'},
        {schema_name:'analytics',table_name:'orders;DROP',column_name:'bad',data_type:'varchar'},
      ]];
      if(sql.startsWith('SELECT 1'))return [[{connected:1}]];
      if(sql.includes('GROUP BY'))return [[{region:'华东',sum_amount:3500}]];
      return [[{region:'华东',amount:3500,order_id:99}]];
    },
    async end(){}
  };
};
const fakePgClass=class {
  async connect(){}
  async end(){}
  async query(q){
    const sql=typeof q==='string'?q:q.text;
    queries.push({sql,params:q.values});
    if(sql.includes('information_schema.columns'))return {rows:[
      {schema_name:'public',table_name:'orders',column_name:'region',data_type:'text'},
      {schema_name:'public',table_name:'orders',column_name:'amount',data_type:'numeric'}]};
    if(sql.startsWith('SELECT 1'))return {rows:[{connected:1}]};
    if(sql.includes('GROUP BY'))return {rows:[{region:'华东',sum_amount:'800.90'}]};
    return {rows:[{region:'华东',amount:800.90}]};
  }
};
const app=createApp({demoMode:true,drivers:{mysql:fakeMysql,postgres:fakePgClass},planner:async({catalog,datasetId,question,history})=>{
  assert.ok(catalog.metrics.sum_amount);
  return {datasetId:'untrusted spoof',dimensions:['region'],metrics:['sum_amount'],filters:question.includes('华东')?[{field:'region',op:'eq',value:'华东'}]:[]};
}});
await new Promise(res=>app.server.listen(0,'127.0.0.1',res));
const base=`http://127.0.0.1:${app.server.address().port}`;
async function request(path,method='GET',body=null,who=null){
  const response=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(who?{Cookie:who.cookie,'x-csrf-token':who.csrf}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
let admin;
test('external connectors, persistent AIPro, isolation and safety',async t=>{
  const l=await request('/api/login','POST',{email:'admin@demo.local',password:'DemoOnly!2026'});
  admin={cookie:l.cookie,csrf:l.data.user.csrf};
  const work=(await request('/api/workspaces','GET',null,admin)).data.items[0];
  await t.test('host allowlist and encrypted credentials',async()=>{
    const denied=await request('/api/datasources','POST',{kind:'mysql',name:'blocked',workspaceId:work.id,host:'localhost',port:3306,database:'analytics',user:'readonly',password:'nope'},admin);
    assert.equal(denied.status,403);
    const created=await request('/api/datasources','POST',{kind:'mysql',name:'live mock',workspaceId:work.id,host:'db.example.internal',port:3306,database:'analytics',user:'readonly',password:'SensitiveSecret!'},admin);
    assert.equal(created.status,201);app.mysqlSourceId=created.data.id;
    const sealed=app.db.prepare('SELECT connection_json FROM datasources WHERE id=?').get(app.mysqlSourceId).connection_json;
    assert.ok(!sealed.includes('SensitiveSecret!'));
    assert.equal(decryptCredentials(sealed).password,'SensitiveSecret!');
    const sources=(await request('/api/datasources','GET',null,admin)).data.items;
    assert.ok(!JSON.stringify(sources).includes('SensitiveSecret!'));
  });
  await t.test('metadata, preview, dataset, bound SQL and agent-planned chat',async()=>{
    const metadata=await request(`/api/datasources/${app.mysqlSourceId}/schema`,'GET',null,admin);
    assert.equal(metadata.status,200);
    assert.equal(metadata.data.tables.length,1);
    const preview=await request(`/api/datasources/${app.mysqlSourceId}/preview`,'GET',null,admin);
    assert.equal(preview.status,200);assert.equal(preview.data.rows.length,1);
    const ds=await request('/api/datasets','POST',{name:'real order model',datasourceId:app.mysqlSourceId,schema:'analytics',table:'orders'},admin);
    assert.equal(ds.status,201);app.datasetId=ds.data.id;
    const spec={datasetId:app.datasetId,dimensions:['region'],metrics:['sum_amount'],filters:[{field:'region',op:'eq',value:"' OR 1=1 --"}]};
    const q=await request('/api/query','POST',spec,admin);
    assert.equal(q.status,200);assert.ok(q.data.sql.includes('`analytics`.`orders`'));
    assert.ok(!q.data.sql.includes('OR 1=1'));
    assert.ok(queries.at(-1).params.includes("' OR 1=1 --"));
    assert.equal((await request('/api/query','POST',{...spec,dimensions:['evil;DROP']},admin)).status,400);
    assert.equal((await request('/api/query','POST',{...spec,metrics:['sum_fake']},admin)).status,400);
    const sess=await request('/api/ai/sessions','POST',{datasetId:app.datasetId,title:'经营分析'},admin);
    assert.equal(sess.status,201);app.sessionId=sess.data.id;
    const ask=await request(`/api/ai/sessions/${app.sessionId}/ask`,'POST',{question:'华东销售额多少'},admin);
    assert.equal(ask.status,200);assert.equal(ask.data.mode,'agent-planned');assert.equal(ask.data.result.rows.length,1);assert.equal(ask.data.spec.datasetId,app.datasetId);
    const ask2=await request(`/api/ai/sessions/${app.sessionId}/ask`,'POST',{question:'再看一次'},admin);
    assert.equal(ask2.status,200);
    const session=await request(`/api/ai/sessions/${app.sessionId}`,'GET',null,admin);
    assert.equal(session.data.messages.length,4);
    const saved=await request('/api/ai/artifacts','POST',{sessionId:app.sessionId,name:'华东分析图',kind:'chart',chart:'bar'},admin);
    assert.equal(saved.status,201);
    const art=await request(`/api/ai/artifacts/${saved.data.id}`,'GET',null,admin);
    assert.equal(art.status,200);assert.equal(art.data.item.content.spec.datasetId,app.datasetId);
  });
  await t.test('Postgres placeholders and read-only transaction',async()=>{
    const pg=await request('/api/datasources','POST',{kind:'postgres',name:'PG source',workspaceId:work.id,host:'pg.example.internal',database:'analytics',user:'readonly',password:'password'},admin);
    assert.equal(pg.status,201);const ds=await request('/api/datasets','POST',{name:'PG model',datasourceId:pg.data.id,schema:'public',table:'orders'},admin);
    assert.equal(ds.status,201);
    const spec={datasetId:ds.data.id,dimensions:['region'],metrics:['sum_amount'],filters:[{field:'region',op:'eq',value:'华东'}]};
    const result=await request('/api/query','POST',spec,admin);
    assert.equal(result.status,200);assert.ok(result.data.sql.includes('"public"."orders"'));
    assert.ok(result.data.sql.includes('"region" = $1'));assert.ok(result.data.sql.includes('LIMIT $2'));
    assert.ok(queries.some(x=>x.sql==='BEGIN TRANSACTION READ ONLY'));
  });
  await t.test('no foreign tenant session or artifact leakage',async()=>{
    const tenant=app.db.prepare('SELECT id FROM tenants WHERE name=?').get('隔离测试企业').id;
    const userId='test-tenant-external';
    const {hashPassword}=await import('../src/db.mjs');
    app.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(userId,'external.viewer@local',hashPassword('SomeLongPassword!'),'viewer');
    app.db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(tenant,userId,'viewer');
    const login=await request('/api/login','POST',{email:'external.viewer@local',password:'SomeLongPassword!'});
    const other={cookie:login.cookie,csrf:login.data.user.csrf};
    assert.equal((await request(`/api/ai/sessions/${app.sessionId}`,'GET',null,other)).status,404);
    assert.equal((await request('/api/ai/sessions','POST',{datasetId:app.datasetId},other)).status,404);
    assert.equal((await request('/api/ai/artifacts','GET',null,other)).data.items.length,0);
  });
});
test('legacy datasource schema migration retains dataset FK',()=>{
  const dir=mkdtempSync(join(tmpdir(),'qbi-migrate-'));
  try{
    const db=openDatabase(join(dir,'app.sqlite'),{demoMode:true});
    db.exec('PRAGMA foreign_keys=OFF;BEGIN;CREATE TABLE old_datasources AS SELECT * FROM datasources;DROP TABLE datasources;CREATE TABLE datasources(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind=\'demo-sqlite\'),created_at TEXT DEFAULT CURRENT_TIMESTAMP);INSERT INTO datasources SELECT id,tenant_id,workspace_id,name,kind,created_at FROM old_datasources;DROP TABLE old_datasources;COMMIT;PRAGMA foreign_keys=ON;');
    db.close();
    const opened=openDatabase(join(dir,'app.sqlite'));
    assert.ok(opened.prepare('PRAGMA table_info(datasources)').all().some(x=>x.name==='connection_json'));
    assert.equal(opened.prepare('PRAGMA foreign_key_check').all().length,0);
    opened.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test.after(async()=>{
  await new Promise(resolve=>app.server.close(resolve));
  if(oldKey===undefined)delete process.env.DATASOURCE_MASTER_KEY;else process.env.DATASOURCE_MASTER_KEY=oldKey;
  if(oldHosts===undefined)delete process.env.DATASOURCE_ALLOWED_HOSTS;else process.env.DATASOURCE_ALLOWED_HOSTS=oldHosts;
});

test('AI topics and canvases are versioned and private',async()=>{
  const user=admin;
  const topic=await request('/api/ai/topics','POST',{datasetId:app.datasetId,name:'销售主题',description:'以各区域销售额为准'},user);
  assert.equal(topic.status,201);
  const publish=await request(`/api/ai/topics/${topic.data.id}/publish`,'POST',{version:1},user);
  assert.equal(publish.status,200);assert.equal(publish.data.status,'published');
  assert.equal((await request(`/api/ai/topics/${topic.data.id}/publish`,'POST',{version:1},user)).status,409);
  const session=await request('/api/ai/sessions','POST',{datasetId:app.datasetId,topicId:topic.data.id},user);
  assert.equal(session.status,201);
  await request(`/api/ai/sessions/${session.data.id}/ask`,'POST',{question:'按地区查询金额'},user);
  const saved=await request('/api/ai/artifacts','POST',{sessionId:session.data.id,name:'主题产物'},user);
  assert.equal(saved.status,201);
  const canvas=await request('/api/ai/canvases','POST',{sessionId:session.data.id,name:'销售分析画布'},user);
  assert.equal(canvas.status,201);
  const layout=[{artifactId:saved.data.id,x:0,y:0,w:12,h:4}];
  const update=await request(`/api/ai/canvases/${canvas.data.id}`,'PATCH',{version:1,layout},user);
  assert.equal(update.status,200);assert.equal(update.data.version,2);
  assert.equal((await request(`/api/ai/canvases/${canvas.data.id}`,'PATCH',{version:1,layout},user)).status,409);
  const read=await request(`/api/ai/canvases/${canvas.data.id}`,'GET',null,user);
  assert.equal(read.data.item.layout.length,1);
  assert.equal((await request(`/api/ai/canvases/${canvas.data.id}`,'PATCH',{version:2,layout:[{artifactId:saved.data.id,x:23,y:0,w:12,h:4}]},user)).status,400);
});
