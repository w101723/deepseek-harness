import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { executeSchedule, startScheduleWorker } from '../src/scheduler.mjs';

function serve(app) { return new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); }
function close(app) { return new Promise(resolve => app.server.close(resolve)); }
function client(app) {
  const base = 'http://127.0.0.1:' + app.server.address().port;
  return async function request(path, method='GET', body, who) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who ? { Cookie: who.cookie, 'x-csrf-token': who.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
}
test('scheduled analyses persist verified evidence, preserve lease, and react to policy changes', async () => {
  const app = createApp({demoMode:true});
  await serve(app);
  try {
    const api = client(app);
    const login=await api('/api/login','POST',{email:'admin@demo.local',password:'DemoOnly!2026'});
    const who={cookie:login.cookie,csrf:login.data.user.csrf};
    const ds=(await api('/api/datasets','GET',undefined,who)).data.items[0];
    const spec={datasetId:ds.id,dimensions:[],metrics:[ds.metrics[0]],limit:10};
    assert.equal((await api('/api/ai/schedules','POST',{datasetId:ds.id,title:'invalid',intervalMinutes:5,spec},who)).status,400);
    const created=await api('/api/ai/schedules','POST',{datasetId:ds.id,title:'recurring',intervalMinutes:15,spec},who);
    assert.equal(created.status,201,JSON.stringify(created.data));
    const id=created.data.item.id;
    assert.equal((await api('/api/ai/schedules/'+id+'/run','POST',{},who)).data.run.status,'success');
    const runs=(await api('/api/ai/schedules/'+id+'/runs','GET',undefined,who)).data.items;
    assert.equal(runs[0].dataAvailable,true);
    assert.ok(runs[0].result.rows.length);
    assert.equal((await api('/api/ai/schedules/'+id,'PATCH',{version:1,enabled:false},who)).status,200);
    assert.equal((await api('/api/ai/schedules/'+id,'PATCH',{version:1,enabled:true},who)).status,409);
    assert.equal((await api('/api/ai/schedules/'+id,'PATCH',{version:2,enabled:true},who)).status,200);
    app.db.prepare('UPDATE analysis_schedules SET next_run_at=0 WHERE id=?').run(id);
    const worker=startScheduleWorker(app.db,{startImmediately:false,intervalMs:100000});
    try { await worker.tick(); } finally { worker.stop(); }
    assert.equal((await api('/api/ai/schedules/'+id+'/runs','GET',undefined,who)).data.items.length,2);
    const overlap=await Promise.allSettled([executeSchedule(app.db,id,{manual:true}),executeSchedule(app.db,id,{manual:true})]);
    assert.equal(overlap.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(overlap.filter(x=>x.status==='rejected').length,1);
    const policies=(await api('/api/datasets/'+ds.id+'/policies','GET',undefined,who)).data.items;
    const admin=policies.find(x=>x.role==='admin');
    const changed=await api('/api/datasets/'+ds.id+'/policies','PATCH',{
      role:'admin',version:admin.version,canQuery:true,dimensions:null,metrics:null,rowFilters:[{field:'region',op:'eq',value:'impossible-region'}]
    },who);
    assert.equal(changed.status,200);
    const stale=(await api('/api/ai/schedules/'+id+'/runs','GET',undefined,who)).data.items;
    assert.ok(stale.every(x=>!x.result && !x.dataAvailable));
    const after=await api('/api/ai/schedules/'+id+'/run','POST',{},who);
    assert.equal(after.data.run.status,'success');
    assert.equal(after.data.run.result.rows.length,1); // aggregate with no GROUP BY returns 1 row
    const fresh=(await api('/api/ai/schedules/'+id+'/runs','GET',undefined,who)).data.items;
    assert.equal(fresh[0].dataAvailable,true);
    assert.equal(fresh[1].dataAvailable,false);
    const me=(await api('/api/me','GET',undefined,who)).data.user;
    app.db.prepare('UPDATE memberships SET role=? WHERE tenant_id=? AND user_id=?').run('viewer',me.tenantId,me.id);
    assert.equal((await api('/api/ai/schedules/'+id+'/run','POST',{},who)).status,403);
    assert.equal((await executeSchedule(app.db,id,{manual:true})).status,'failed');
    assert.ok((await api('/api/ai/schedules/'+id+'/runs','GET',undefined,who)).data.items.every(x=>!x.result));
  } finally { await close(app); }
});

test('automatic worker executes a due persisted task after service restart', async () => {
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'qbi-recurring-')),dbPath=join(dir,'app.sqlite');
  let a,b;
  try {
    a=createApp({dbPath,demoMode:true});await serve(a);
    const first=client(a);
    const l=await first('/api/login','POST',{email:'admin@demo.local',password:'DemoOnly!2026'});
    const who={cookie:l.cookie,csrf:l.data.user.csrf};
    const ds=(await first('/api/datasets','GET',undefined,who)).data.items[0];
    const schedule=await first('/api/ai/schedules','POST',{datasetId:ds.id,title:'recoverable',intervalMinutes:15,spec:{datasetId:ds.id,dimensions:[],metrics:[ds.metrics[0]]}},who);
    assert.equal(schedule.status,201);
    a.db.prepare('UPDATE analysis_schedules SET next_run_at=0 WHERE id=?').run(schedule.data.item.id);
    await close(a);a=null;
    b=createApp({dbPath,autoSchedules:true});await serve(b);
    const second=client(b);
    let found=false;
    for(let i=0;i<80;i++){
      const history=await second('/api/ai/schedules/'+schedule.data.item.id+'/runs','GET',undefined,who);
      if(history.data.items?.length===1){found=history.data.items[0].status==='success';break;}
      await new Promise(ok=>setTimeout(ok,10));
    }
    assert.equal(found,true);
  } finally {
    if(a)await close(a);
    if(b)await close(b);
    rmSync(dir,{recursive:true,force:true});
  }
});
