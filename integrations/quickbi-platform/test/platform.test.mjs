import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { id, hashPassword } from '../src/db.mjs';

const app=createApp({demoMode:true});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${app.server.address().port}`;
const request=async(path,options={})=>{
  const r=await fetch(base+path,{...options,headers:{...options.headers,...(options.body?{'Content-Type':'application/json'}:{})},body:options.body?JSON.stringify(options.body):undefined});
  const value=await r.json();return {status:r.status,value,cookie:r.headers.get('set-cookie')?.split(';')[0]};
};
const login=async(email,password)=>{
  const r=await request('/api/login',{method:'POST',body:{email,password}});assert.equal(r.status,200);return {cookie:r.cookie,csrf:r.value.user.csrf,user:r.value.user};
};
const as=(user,method='GET',body)=>({method,headers:{Cookie:user.cookie,'x-csrf-token':user.csrf},...(body?{body}:{} )});

test('full foundation lifecycle with isolation, CSRF and query allowlists',async t=>{
  await t.test('health, unauthenticated denial and login',async()=>{
    assert.equal((await request('/api/health')).status,200);
    assert.equal((await request('/api/workspaces')).status,401);
    assert.equal((await request('/api/login',{method:'POST',body:{email:'admin@demo.local',password:'wrong'}})).status,401);
  });
  const admin=await login('admin@demo.local','DemoOnly!2026');
  const workspace=(await request('/api/workspaces',as(admin))).value.items[0];
  const datasource=(await request('/api/datasources',as(admin))).value.items[0];
  const dataset=(await request('/api/datasets',as(admin))).value.items[0];
  await t.test('writes demand matching CSRF, editor role, and scoped workspace',async()=>{
    assert.equal((await request('/api/workspaces',{method:'POST',headers:{Cookie:admin.cookie},body:{name:'Not allowed'}})).status,403);
    assert.equal((await request('/api/workspaces',as(admin,'POST',{name:'Sales Expansion'}))).status,201);
    assert.equal((await request('/api/datasources',as(admin,'POST',{name:'No remote DB',kind:'mysql',workspaceId:workspace.id}))).status,422);
    assert.equal((await request('/api/datasources',as(admin,'POST',{name:'新演示源',kind:'demo-sqlite',workspaceId:workspace.id}))).status,201);
    assert.equal((await request(`/api/datasources/${datasource.id}/test`,as(admin))).value.ok,true);
    assert.equal((await request('/api/datasets',as(admin,'POST',{name:'新建模型',datasourceId:datasource.id}))).status,201);
  });
  await t.test('query compiles allowlisted identifiers and binds filters',async()=>{
    const r=await request('/api/query',as(admin,'POST',{datasetId:dataset.id,dimensions:['region'],metrics:['revenue'],filters:[{field:'region',op:'eq',value:'华东'}]}));
    assert.equal(r.status,200);assert.equal(r.value.rows.length,1);assert.equal(r.value.rows[0].region,'华东');
    assert.ok(r.value.sql.includes('tenant_id=?'));assert.ok(r.value.sql.includes('workspace_id=?'));
    assert.equal((await request('/api/query',as(admin,'POST',{datasetId:dataset.id,dimensions:['region;DROP TABLE users'],metrics:['revenue']}))).status,400);
    assert.equal((await request('/api/query',as(admin,'POST',{datasetId:dataset.id,dimensions:['region'],metrics:['revenue'],filters:[{field:'region',op:'eq',value:"' OR 1=1 --"}]}))).value.rows.length,0);
  });
  await t.test('dashboard editing uses version conflict guard',async()=>{
    const created=await request('/api/dashboards',as(admin,'POST',{name:'运营视图',workspaceId:workspace.id,widgets:[{title:'订单量',datasetId:dataset.id,dimension:'category',metric:'orders',chart:'bar'}]}));
    assert.equal(created.status,201);const path=`/api/dashboards/${created.value.id}`;
    const first=await request(path,as(admin,'PATCH',{version:1,name:'运营视图V2'}));assert.equal(first.value.version,2);
    assert.equal((await request(path,as(admin,'PATCH',{version:1,name:'过期提交'}))).status,409);
  });
  await t.test('deterministic analysis has true query evidence',async()=>{
    const r=await request('/api/ai/ask',as(admin,'POST',{question:'按地区分析销售额'}));
    assert.equal(r.status,200);assert.equal(r.value.mode,'deterministic-preview');assert.ok(r.value.result.rows.length>=3);
    assert.equal(r.value.spec.dimensions[0],'region');
  });
  await t.test('server rejects tenant crossing and prevents leakage',async()=>{
    const tenant2=app.db.prepare('SELECT id FROM tenants WHERE name=?').get('隔离测试企业').id;
    const otherId=id();app.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(otherId,'viewer@other.local',hashPassword('SecureTestPass!42'),'另一个租户');
    app.db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(tenant2,otherId,'viewer');
    const viewer=await login('viewer@other.local','SecureTestPass!42');
    assert.equal((await request(`/api/datasets/${dataset.id}/preview`,as(viewer))).status,404);
    assert.equal((await request('/api/query',as(viewer,'POST',{datasetId:dataset.id,dimensions:[],metrics:['revenue']}))).status,404);
    assert.equal((await request('/api/tenant/switch',as(viewer,'POST',{tenantId:admin.user.tenantId}))).status,403);
    assert.equal((await request('/api/workspaces',as(viewer,'POST',{name:'bad'}))).status,403);
    const visible=(await request('/api/workspaces',as(viewer))).value.items;
    assert.ok(visible.every(w=>w.tenant_id===tenant2));
    assert.equal((await request('/api/audit',as(viewer))).status,403);
  });
  await t.test('login/logout expires session on server',async()=>{
    assert.equal((await request('/api/logout',as(admin,'POST',{}))).status,200);
    assert.equal((await request('/api/me',as(admin))).status,401);
  });
});

test.after(async()=>{await new Promise(resolve=>app.server.close(resolve));});