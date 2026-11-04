import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/db.mjs';

let seenTopic;
const app=createApp({demoMode:true,planner:async ({catalog,datasetId})=>{
  seenTopic=catalog.topic;
  const metric=Object.keys(catalog.metrics)[0];
  return {datasetId,dimensions:catalog.dimensions.slice(0,1),metrics:[metric],limit:5};
}});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${app.server.address().port}`;
async function req(path,method='GET',payload,who){
  const r=await fetch(base+path,{method,headers:{...(payload!==undefined?{'Content-Type':'application/json'}:{}),...(who?{Cookie:who.cookie,'x-csrf-token':who.csrf}:{})},body:payload!==undefined?JSON.stringify(payload):undefined});
  return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function login(email,password){const l=await req('/api/login','POST',{email,password});assert.equal(l.status,200);return {cookie:l.cookie,csrf:l.data.user.csrf};}

test('AIPro business topic knowledge is owner-scoped, versioned, and pinned to sessions',async t=>{
  const admin=await login('admin@demo.local','DemoOnly!2026');
  const ds=(await req('/api/datasets','GET',undefined,admin)).data.items[0];
  const topic=await req('/api/ai/topics','POST',{datasetId:ds.id,name:'经营口径',description:'不推测因果'},admin);
  assert.equal(topic.status,201);
  const tid=topic.data.id;
  await t.test('knowledge add requires current version and valid kind',async()=>{
    assert.equal((await req(`/api/ai/topics/${tid}/knowledge`,'POST',{kind:'shell',title:'bad',content:'cmd',version:1},admin)).status,400);
    assert.equal((await req(`/api/ai/topics/${tid}/knowledge`,'POST',{kind:'glossary',title:'销售额',content:'只使用已授权的 revenue 指标',version:0},admin)).status,409);
    const k=await req(`/api/ai/topics/${tid}/knowledge`,'POST',{kind:'glossary',title:'销售额',content:'只使用已授权的 revenue 指标',version:1},admin);
    assert.equal(k.status,201);assert.equal(k.data.version,2);
    assert.equal((await req(`/api/ai/topics/${tid}`,'GET',undefined,admin)).data.item.knowledge.length,1);
    assert.equal((await req(`/api/ai/topics/${tid}/publish`,'POST',{version:2},admin)).status,200);
  });
  let sid;
  await t.test('published topic enriches model planner and locks session revision',async()=>{
    const s=await req('/api/ai/sessions','POST',{datasetId:ds.id,topicId:tid,title:'口径分析'},admin);
    assert.equal(s.status,201);sid=s.data.id;
    const answer=await req(`/api/ai/sessions/${sid}/ask`,'POST',{question:'地区销售如何'},admin);
    assert.equal(answer.status,200,JSON.stringify(answer.data));
    assert.equal(seenTopic.knowledge[0].kind,'glossary');
    assert.match(seenTopic.knowledge[0].content,/revenue/);
    const edited=await req(`/api/ai/topics/${tid}`,'PATCH',{name:'经营口径2026',description:'变更口径',version:3},admin);
    assert.equal(edited.status,200);assert.equal(edited.data.status,'draft');
    assert.equal((await req(`/api/ai/sessions/${sid}/ask`,'POST',{question:'继续'},admin)).status,409);
    assert.equal((await req(`/api/ai/topics/${tid}/publish`,'POST',{version:4},admin)).status,200);
    assert.equal((await req(`/api/ai/sessions/${sid}/ask`,'POST',{question:'继续'},admin)).status,409);
  });
  await t.test('viewer cannot modify and tenant cannot inspect knowledge',async()=>{
    const otherId='topic-viewer-'+Date.now();
    const tenantId=app.db.prepare('SELECT id FROM tenants WHERE name=?').get('演示企业').id;
    app.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(otherId,'topic.viewer@local',hashPassword('LongPassword-for-Viewers!'),'Viewer');
    app.db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(tenantId,otherId,'viewer');
    const viewer=await login('topic.viewer@local','LongPassword-for-Viewers!');
    const denied=await req(`/api/ai/topics/${tid}/knowledge`,'POST',{kind:'example',title:'A',content:'B',version:5},viewer);
    assert.equal(denied.status,403);
    const foreign='topic-other-'+Date.now();
    const foreignTenant=app.db.prepare('SELECT id FROM tenants WHERE name=?').get('隔离测试企业').id;
    app.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(foreign,'topic.foreign@local',hashPassword('LongPassword-for-Foreign!'),'Outside');
    app.db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(foreignTenant,foreign,'admin');
    const stranger=await login('topic.foreign@local','LongPassword-for-Foreign!');
    assert.equal((await req(`/api/ai/topics/${tid}`,'GET',undefined,stranger)).status,404);
    assert.equal((await req(`/api/ai/topics/${tid}/knowledge`,'GET',undefined,stranger)).status,404);
  });
  await t.test('published knowledge deletion invalidates prior topic version',async()=>{
    const info=(await req(`/api/ai/topics/${tid}`,'GET',undefined,admin)).data.item;
    const k=info.knowledge[0];
    assert.equal((await req(`/api/ai/topics/${tid}/knowledge/${k.id}`,'DELETE',{version:4},admin)).status,409);
    const del=await req(`/api/ai/topics/${tid}/knowledge/${k.id}`,'DELETE',{version:5},admin);
    assert.equal(del.status,200);assert.equal(del.data.status,'draft');
    assert.equal((await req(`/api/ai/topics/${tid}/knowledge`,'GET',undefined,admin)).data.items.length,0);
  });
});
test.after(async()=>{await new Promise(resolve=>app.server.close(resolve));});
