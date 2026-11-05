import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/db.mjs';
import { randomUUID, randomBytes } from 'node:crypto';

process.env.DATASOURCE_MASTER_KEY=randomBytes(32).toString('hex');
process.env.DATASOURCE_ALLOWED_HOSTS='mock.internal';
const driver=async(config)=>{if(config?.password==='REJECT')throw Object.assign(new Error('bad credentials'),{code:'1045'});return ({
  async execute(o){const sql=typeof o==='string'?o:o.sql;
    if(sql.includes('information_schema.tables')){if(sql.includes('COUNT(*)'))return [[{total_count:42}]];return [[{schema_name:'analytics',table_name:'orders'},{schema_name:'analytics',table_name:'orders_2026'}]];}
    if(sql.includes('information_schema.columns'))return [[
      {schema_name:'analytics',table_name:'orders',column_name:'region',data_type:'varchar'},
      {schema_name:'analytics',table_name:'orders',column_name:'amount',data_type:'decimal'},
      {schema_name:'analytics',table_name:'orders',column_name:'id',data_type:'int'}
    ]];
    if(sql.startsWith('SELECT 1'))return [[{connected:1}]];
    return [[{region:'华东',sum_amount:21,rows:2}]];
  }, async end(){}
});};
const {server,db}=createApp({demoMode:true,drivers:{mysql:driver}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function call(path,method='GET',payload,identity){const r=await fetch(base+path,{method,headers:{...(payload?{'Content-Type':'application/json'}:{}),...(identity?{Cookie:identity.cookie,'x-csrf-token':identity.csrf}:{})},body:payload?JSON.stringify(payload):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function signIn(email,password){const r=await call('/api/login','POST',{email,password});assert.equal(r.status,200);return {cookie:r.cookie,csrf:r.body.user.csrf,user:r.body.user};}
const admin=await signIn('admin@demo.local','DemoOnly!2026');
const workspace=(await call('/api/workspaces','GET',undefined,admin)).body.items[0];

// Existing foundation may leave data sourced by previous migrations. This suite runs on an isolated in-memory DB.
test('workspace folders + nested moves + cycle and nonempty-delete guards',async()=>{
  const a=await call('/api/assets/folders','POST',{workspaceId:workspace.id,name:'财务'},admin);assert.equal(a.status,201);
  const b=await call('/api/assets/folders','POST',{workspaceId:workspace.id,parentId:a.body.id,name:'明细'},admin);assert.equal(b.status,201);
  const folders=(await call('/api/assets/folders','GET',undefined,admin)).body.items;
  assert.ok(folders.some(x=>x.id===b.body.id&&x.parent_id===a.body.id));
  assert.equal((await call(`/api/assets/folders/${a.body.id}`,'PATCH',{parentId:b.body.id},admin)).status,400);
  assert.equal((await call(`/api/assets/folders/${a.body.id}`,'DELETE',undefined,admin)).status,409);
  assert.equal((await call(`/api/assets/folders/${b.body.id}`,'DELETE',undefined,admin)).status,200);
  assert.equal((await call(`/api/assets/folders/${a.body.id}`,'DELETE',undefined,admin)).status,200);
});

test('dataset rename, folder assignment, duplicate and reference-protected deletion',async()=>{
  const src=await call('/api/datasources','POST',{workspaceId:workspace.id,name:'示例连接',kind:'demo-sqlite'},admin);
  assert.equal(src.status,201);
  const dataset=await call('/api/datasets','POST',{datasourceId:src.body.id,name:'销售订单'},admin);
  assert.equal(dataset.status,201);
  const f=await call('/api/assets/folders','POST',{workspaceId:workspace.id,name:'销售分析'},admin);
  const update=await call(`/api/assets/datasets/${dataset.body.id}`,'PATCH',{version:1,name:'销售统计',folderId:f.body.id},admin);
  assert.equal(update.status,200);assert.equal(update.body.version,2);
  assert.equal((await call(`/api/assets/datasets/${dataset.body.id}`,'PATCH',{version:1,name:'stale'},admin)).status,409);
  const listed=(await call('/api/assets/datasets','GET',undefined,admin)).body.items;
  assert.equal(listed.find(x=>x.id===dataset.body.id).folder_id,f.body.id);
  const copied=await call(`/api/assets/datasets/${dataset.body.id}/duplicate`,'POST',{name:'销售复制版',folderId:f.body.id},admin);
  assert.equal(copied.status,201);
  assert.equal((await call(`/api/assets/folders/${f.body.id}`,'DELETE',undefined,admin)).status,409);
  assert.equal((await call(`/api/assets/datasets/${copied.body.id}`,'DELETE',undefined,admin)).status,200);
  const session=await call('/api/ai/sessions','POST',{datasetId:dataset.body.id},admin);assert.equal(session.status,201);
  assert.equal((await call(`/api/assets/datasets/${dataset.body.id}`,'DELETE',undefined,admin)).status,409);
  assert.equal((await call(`/api/assets/sources/${src.body.id}`,'DELETE',undefined,admin)).status,409);
});

test('real-source metadata browser + constrained SQL creation and bound query',async()=>{
  const src=await call('/api/datasources','POST',{workspaceId:workspace.id,name:'经营库',kind:'mysql',host:'mock.internal',database:'analytics',user:'ro',password:'SECRET'},admin);
  assert.equal(src.status,201);
  const rid=src.body.id;
  const paged=await call(`/api/assets/sources/${rid}/tables?page=2&pageSize=15&q=orders_2026`,'GET',undefined,admin);
  assert.equal(paged.status,200);assert.equal(paged.body.page,2);assert.equal(paged.body.total,42);
  assert.ok(paged.body.items.some(x=>x.name==='orders_2026'));
  assert.equal((await call(`/api/assets/sources/${rid}/tables?page=-1`,'GET',undefined,admin)).status,400);
  const specific=await call(`/api/assets/sources/${rid}/preview?schema=analytics&table=orders`,'GET',undefined,admin);
  assert.equal(specific.status,200);assert.ok(specific.body.rows.length);
  assert.equal((await call(`/api/assets/sources/${rid}/preview?schema=analytics&table=unknown`,'GET',undefined,admin)).status,404);
  const made=await call('/api/assets/datasets/table','POST',{datasourceId:rid,name:'表模式数据集',schema:'analytics',table:'orders'},admin);
  assert.equal(made.status,201);

  const update=await call(`/api/assets/sources/${rid}`,'PATCH',{name:'运营库',remark:'仅供分析',version:1},admin);
  assert.equal(update.status,200);assert.equal(update.body.version,2);
  const listed=(await call('/api/assets/sources','GET',undefined,admin)).body.items.find(x=>x.id===rid);
  assert.equal(listed.name,'运营库');assert.equal(listed.remark,'仅供分析');
  assert.ok(!JSON.stringify(listed).includes('SECRET'));
  assert.equal((await call(`/api/assets/sources/${rid}`,'PATCH',{version:1,name:'stale'},admin)).status,409);
  const denied=['SELECT * FROM analytics.orders','SELECT amount FROM analytics.orders WHERE 1=1','SELECT amount FROM analytics.orders; DROP TABLE x','SELECT amount FROM analytics.missing','SELECT secret FROM analytics.orders'];
  for(const sql of denied){const result=await call('/api/assets/datasets/sql','POST',{name:'恶意',datasourceId:rid,sql},admin);assert.ok(result.status>=400,`${sql} => ${result.status}`);}
  const saved=await call('/api/assets/datasets/sql','POST',{name:'指定字段分析',datasourceId:rid,sql:'SELECT region, amount FROM analytics.orders'},admin);
  assert.equal(saved.status,201);
  const found=(await call('/api/assets/datasets','GET',undefined,admin)).body.items.find(x=>x.id===saved.body.id);
  assert.equal(found.model_kind,'sql');assert.deepEqual(found.dimensions,['region','amount']);assert.ok(found.metrics.includes('sum_amount'));
  const q=await call('/api/query','POST',{datasetId:saved.body.id,dimensions:['region'],metrics:['sum_amount'],limit:5},admin);assert.equal(q.status,200);assert.equal(q.body.count,1);
  const dupe=await call(`/api/assets/datasets/${saved.body.id}/duplicate`,'POST',{name:'SQL 副本'},admin);assert.equal(dupe.status,201);
  assert.equal((await call('/api/assets/datasets','GET',undefined,admin)).body.items.find(x=>x.id===dupe.body.id).model_kind,'sql');
});

test('tenant boundaries and viewer writes are denied',async()=>{
  const tenant=randomUUID(),otherUser=randomUUID();
  db.prepare('INSERT INTO tenants(id,name) VALUES(?,?)').run(tenant,'另一个租户');
  db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)').run(otherUser,'viewer@other.local','Viewer',hashPassword('strong-password'));
  db.prepare('INSERT INTO memberships(tenant_id,user_id,role) VALUES(?,?,?)').run(tenant,otherUser,'viewer');
  db.prepare('INSERT INTO workspaces(id,tenant_id,name) VALUES(?,?,?)').run(randomUUID(),tenant,'Other');
  const other=await signIn('viewer@other.local','strong-password');
  assert.equal((await call('/api/assets/folders','POST',{workspaceId:workspace.id,name:'越权'},other)).status,403);
  assert.equal((await call('/api/assets/datasets','GET',undefined,other)).body.items.length,0);
  const folders=await call('/api/assets/folders','GET',undefined,other);
  assert.equal(folders.status,200);assert.ok(folders.body.items.every(x=>x.tenant_id===tenant));
  const ds=(await call('/api/assets/datasets','GET',undefined,admin)).body.items[0];
  assert.equal((await call(`/api/assets/datasets/${ds.id}`,'DELETE',undefined,other)).status,403);
  assert.equal((await call('/api/assets/datasets/sql','POST',{name:'XX',datasourceId:'bad',sql:'SELECT x FROM public.x'},other)).status,403);
});

test.after(async()=>{await new Promise(r=>server.close(r));});
test('data source credentials only change after successful connection test; datasets stay bound',async()=>{
  const created=await call('/api/datasources','POST',{workspaceId:workspace.id,name:'Credential rotation',kind:'mysql',host:'mock.internal',database:'analytics',user:'ro',password:'OLD'},admin);
  assert.equal(created.status,201);
  const id=created.body.id;
  const dataset=await call('/api/assets/datasets/table','POST',{datasourceId:id,name:'Reference',schema:'analytics',table:'orders'},admin);
  assert.equal(dataset.status,201);
  const original=db.prepare('SELECT connection_json FROM datasources WHERE id=?').get(id).connection_json;
  const updated=await call('/api/assets/sources/'+id,'PATCH',{version:1,connection:{host:'mock.internal',port:3306,database:'analytics',user:'analyst',password:'NEW-SECRET',ssl:false}},admin);
  assert.equal(updated.status,200,JSON.stringify(updated.body));
  assert.equal(updated.body.connectionUpdated,true);
  const encrypted=db.prepare('SELECT connection_json FROM datasources WHERE id=?').get(id).connection_json;
  assert.notEqual(encrypted,original);assert.ok(!encrypted.includes('NEW-SECRET'));
  const {decryptCredentials}=await import('../src/connectors.mjs');
  assert.equal(decryptCredentials(encrypted).password,'NEW-SECRET');
  assert.ok(db.prepare('SELECT revision FROM dataset_policy_generations WHERE dataset_id=?').get(dataset.body.id).revision>=1,'rotation must invalidate existing query evidence');
  assert.equal((await call('/api/assets/sources','GET',undefined,admin)).body.items.find(x=>x.id===id).version,2);
  const bad={host:'mock.internal',port:3306,database:'analytics',user:'ro',password:'REJECT',ssl:false};
  const rejected=await call('/api/assets/sources/'+id,'PATCH',{version:2,name:'invalid-name',connection:bad},admin);
  assert.equal(rejected.status,502);
  assert.equal(db.prepare('SELECT connection_json FROM datasources WHERE id=?').get(id).connection_json,encrypted);
  assert.notEqual(db.prepare('SELECT name FROM datasources WHERE id=?').get(id).name,'invalid-name');
  assert.equal((await call('/api/assets/sources/'+id,'PATCH',{version:2,connection:{...bad,port:3307,password:'valid'}},admin)).status,409);
  assert.equal((await call('/api/assets/sources/'+id,'PATCH',{version:1,name:'stale'},admin)).status,409);
});
