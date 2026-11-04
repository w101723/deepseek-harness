import test from 'node:test';
import assert from 'node:assert/strict';
import { exportArtifact } from '../src/artifact-export.mjs';
import { createApp } from '../src/server.mjs';

const sample={id:'id-test',name:'经营分析',content:{summary:'数据只表明相关性，不代表因果。',spec:{datasetId:'ds1'},result:{columns:['region','revenue'],rows:[{region:'=HYPERLINK("https://evil.invalid")',revenue:50},{region:'华东|上海',revenue:30}]}}};
test('artifact export escapes CSV formulas and Markdown pipes',()=>{
  const csv=exportArtifact(sample,'csv');
  assert.equal(csv.type,'text/csv; charset=utf-8');
  assert.ok(csv.text.includes("'=HYPERLINK"));
  assert.ok(csv.text.includes('""https://evil.invalid""'));
  const markdown=exportArtifact(sample,'md');
  assert.ok(markdown.text.includes('华东\\|上海'));
  assert.ok(markdown.text.includes('数据只表明相关性'));
  const json=JSON.parse(exportArtifact(sample,'json').text);
  assert.equal(json.content.result.rows.length,2);
  assert.throws(()=>exportArtifact(sample,'html'),{status:400});
});

test('artifact exports require session authorization and are invalidated after policy change',async()=>{
  const app=createApp({demoMode:true});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const fetchApi=async(path,method='GET',data,auth)=>fetch(origin+path,{method,headers:{...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  try{
    const login=await fetchApi('/api/login','POST',{email:'admin@demo.local',password:'DemoOnly!2026'});
    const auth={cookie:login.headers.get('set-cookie').split(';')[0],csrf:(await login.json()).user.csrf};
    const dataset=(await (await fetchApi('/api/datasets','GET',null,auth)).json()).items[0];
    const session=await (await fetchApi('/api/ai/sessions','POST',{datasetId:dataset.id},auth)).json();
    assert.equal((await fetchApi(`/api/ai/sessions/${session.id}/ask`,'POST',{question:'销售额'},auth)).status,200);
    const create=await fetchApi('/api/ai/artifacts','POST',{sessionId:session.id,name:'区域销售报告',kind:'report',chart:'table'},auth);
    assert.equal(create.status,201);
    const a=await create.json();
    const path=`/api/ai/artifacts/${a.id}/export?format=md`;
    assert.equal((await fetchApi(path)).status,401);
    const exportRes=await fetchApi(path,'GET',null,auth);
    assert.equal(exportRes.status,200);
    assert.match(exportRes.headers.get('content-disposition'),/attachment; filename="analysis-/);
    const body=await exportRes.text();
    assert.ok(body.includes('区域销售报告'));
    assert.equal((await fetchApi(`/api/ai/artifacts/${a.id}/export?format=html`,'GET',null,auth)).status,400);
    const policy=await fetchApi(`/api/datasets/${dataset.id}/policies`,'PATCH',{role:'viewer',version:0,canQuery:false},auth);
    assert.equal(policy.status,200);
    assert.equal((await fetchApi(path,'GET',null,auth)).status,409);
  }finally{await new Promise(r=>app.server.close(r));}
});
