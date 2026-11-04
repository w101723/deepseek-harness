import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { createAgentBridge } from '../src/agent-bridge.mjs';
import { openDatabase } from '../src/db.mjs';

function makeFetcher(url, who) {
  return async (path, method='GET', body) => {
    const response=await fetch(url+path,{method,headers:{
      ...(who?.cookie?{cookie:who.cookie,'x-csrf-token':who.csrf}:{}),
      ...(body?{'Content-Type':'application/json'}:{}),
    },body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
}

test('native Harness tool bridge: scoped auth, positive execution, revocation',async()=>{
  let oldCapability;
  const app=createApp({demoMode:true,nativeAgentEnabled:true,nativeAgentRunner:async ({url,capability,question,history})=>{
    oldCapability=capability;
    const call=async(action,spec,auth=capability)=>{
      const response=await fetch(url+'/api/internal/agent-tool',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${auth}`},body:JSON.stringify({action,spec})});
      return {status:response.status,body:await response.json()};
    };
    assert.equal((await call('catalog',undefined,'0'.repeat(64))).status,401);
    const catalog=await call('catalog');
    assert.equal(catalog.status,200);
    assert.ok(catalog.body.dimensions.includes('region'));
    assert.deepEqual(catalog.body.metrics.revenue,{kind:'builtin'});
    const queried=await call('query',{datasetId:'attacker-dataset',dimensions:['region'],metrics:['revenue'],filters:[{field:'region',op:'eq',value:'华东'}]});
    assert.equal(queried.status,200);
    assert.equal(queried.body.columns[0],'region');
    assert.ok(queried.body.rows.length);
    assert.ok(!JSON.stringify(queried.body).includes('password'));
    // Model may attempt to switch scope; server always substitutes the bound dataset.
    assert.equal((await call('query',{dimensions:['malicious'],metrics:['revenue']})).status,400);
    assert.equal((await call('unknown')).status,404);
    assert.equal(question,'华东的销售额是多少');
    return '华东销售额已按真实查询统计；不能据此断言因果。';
  }});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const req=makeFetcher(url);
  try{
    const login=await req('/api/login','POST',{email:'admin@demo.local',password:'DemoOnly!2026'});
    const admin={cookie:login.cookie,csrf:login.body.user.csrf};
    const api=makeFetcher(url,admin);
    const dataset=(await api('/api/datasets')).body.items[0];
    const session=await api('/api/ai/sessions','POST',{datasetId:dataset.id,title:'原生工具测试'});
    assert.equal(session.status,201);
    const asked=await api(`/api/ai/sessions/${session.body.id}/ask`,'POST',{question:'华东的销售额是多少'});
    assert.equal(asked.status,200);
    assert.equal(asked.body.mode,'native-agent-tools');
    assert.equal(asked.body.result.datasetId,dataset.id);
    assert.equal(asked.body.toolTrace.length,2);
    assert.equal((await api(`/api/ai/sessions/${session.body.id}`)).body.messages.length,2);
    assert.equal((await fetch(url+'/api/internal/agent-tool',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${oldCapability}`},body:JSON.stringify({action:'catalog'})})).status,401);
    // HTTP cookie and CSRF alone cannot call the internal bridge.
    assert.equal((await api('/api/internal/agent-tool','POST',{action:'catalog'})).status,401);
    assert.ok(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='agent.query'").get().n>=1);
  }finally{await new Promise(resolve=>app.server.close(resolve));}
});

test('agent tool bridge enforces expiration, bounded queries and principal binding',async()=>{
  const db=openDatabase(':memory:',{demoMode:true});
  const user=db.prepare("SELECT u.id, m.tenant_id, m.role FROM users u JOIN memberships m ON u.id=m.user_id WHERE u.email='admin@demo.local'").get();
  const dataset=db.prepare('SELECT id FROM datasets WHERE tenant_id=?').get(user.tenant_id);
  const ctx={tenantId:user.tenant_id,userId:user.id,role:user.role};
  const bridge=createAgentBridge(db,{lifetimeMs:100});
  const scope=bridge.open(ctx,dataset.id);
  try{
    assert.equal((await bridge.dispatch(scope.token,{action:'catalog'})).datasetId,dataset.id);
    await assert.rejects(bridge.dispatch('e'.repeat(64),{action:'catalog'}),{status:401});
    const query=await bridge.dispatch(scope.token,{action:'query',spec:{datasetId:'not-real',dimensions:['region'],metrics:['revenue'],limit:10000}});
    assert.equal(query.rows.length,4);
    assert.ok(scope.last.spec.limit<=30);
    for(let i=0;i<7;i++)await bridge.dispatch(scope.token,{action:'query',spec:{dimensions:['region'],metrics:['revenue']}});
    await assert.rejects(bridge.dispatch(scope.token,{action:'query',spec:{dimensions:['region'],metrics:['revenue']}}),{status:429});
  }finally{scope.close();db.close();}
  await assert.rejects(bridge.dispatch(scope.token,{action:'catalog'}),{status:401});
});

test('analysis artwork supports safe editing and taller canvas without changing query evidence',async()=>{
  const app=createApp({demoMode:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const req=makeFetcher(`http://127.0.0.1:${app.server.address().port}`);
  try {
    const login=await req('/api/login','POST',{email:'admin@demo.local',password:'DemoOnly!2026'});
    const api=makeFetcher(`http://127.0.0.1:${app.server.address().port}`,{cookie:login.cookie,csrf:login.body.user.csrf});
    const ds=(await api('/api/datasets')).body.items[0];
    const session=(await api('/api/ai/sessions','POST',{datasetId:ds.id})).body;
    assert.equal((await api(`/api/ai/sessions/${session.id}/ask`,'POST',{question:'销售额'})).status,200);
    const created=await api('/api/ai/artifacts','POST',{sessionId:session.id,name:'第一版'});
    const original=(await api(`/api/ai/artifacts/${created.body.id}`)).body.item;
    const edit=await api(`/api/ai/artifacts/${created.body.id}`,'PATCH',{version:1,name:'已编辑',chart:'line'});
    assert.equal(edit.status,200);
    assert.equal((await api(`/api/ai/artifacts/${created.body.id}`,'PATCH',{version:1,chart:'table'})).status,409);
    assert.equal((await api(`/api/ai/artifacts/${created.body.id}`,'PATCH',{version:2,chart:'shell'})).status,400);
    const updated=(await api(`/api/ai/artifacts/${created.body.id}`)).body.item;
    assert.equal(updated.name,'已编辑');
    assert.equal(updated.content.chart,'line');
    assert.deepEqual(updated.content.result,original.content.result);
    const canvas=(await api('/api/ai/canvases','POST',{sessionId:session.id,name:'可滚动画布'})).body;
    assert.equal((await api(`/api/ai/canvases/${canvas.id}`,'PATCH',{version:1,layout:[{artifactId:created.body.id,x:12,y:250,w:12,h:5}]})).status,200);
    assert.equal((await api(`/api/ai/canvases/${canvas.id}`,'PATCH',{version:2,layout:[{artifactId:created.body.id,x:12,y:10001,w:12,h:5}]})).status,400);
  } finally {await new Promise(resolve=>app.server.close(resolve));}
});
