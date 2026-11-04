/** Persisted, permission-aware recurring BI analysis. This is intentionally NOT
 * a data movement/ETL system; runs execute the existing read-only QuerySpec.
 * Runs are stored locally and never delivered to an unverified email/webhook.
 */
import { randomUUID } from 'node:crypto';
import { audit } from './db.mjs';
import { InputError, getDataset } from './query.mjs';
import { executeAnyQuery } from './query-external.mjs';
import { readableCatalog, datasetPolicyRevision, validateQueryPolicy } from './dataset-policy.mjs';

const INTERVALS = new Set([15,30,60,180,360,720,1440,10080]);
const MAX_RESULT_BYTES = 100_000;
const ROLES = new Set(['admin','editor']);
const label = (v,kind) => {
  if (typeof v!=='string' || !v.trim() || v.length>80) throw new InputError(`${kind}必须为 1–80 个字符`);
  return v.trim();
};
const requireEditor = ctx => { if(!ROLES.has(ctx.role))throw new InputError('只有编辑者可以管理定时分析',403); };
function normalizeInterval(v){if(!INTERVALS.has(v))throw new InputError('请选择受支持的执行周期（15 分钟至 7 天）');return v;}
function parseSpec(datasetId,value){
  if(!value || typeof value!=='object' || Array.isArray(value))throw new InputError('缺少分析查询配置');
  const dimensions=value.dimensions??[],metrics=value.metrics??[],filters=value.filters??[];
  if(!Array.isArray(dimensions)||dimensions.length>3||!Array.isArray(metrics)||metrics.length<1||metrics.length>4||!Array.isArray(filters)||filters.length>8)throw new InputError('查询参数数量无效');
  const limit=Number.isInteger(value.limit)?value.limit:30;
  if(limit<1||limit>100)throw new InputError('定时分析结果行数超限');
  // Reject extra fields at the boundary. Tenant/source/user identities are never client-provided.
  if(Object.keys(value).some(k=>!['datasetId','dimensions','metrics','filters','limit'].includes(k)))throw new InputError('查询配置存在不支持的字段');
  if(value.datasetId!==undefined && value.datasetId!==datasetId)throw new InputError('定时任务数据集不匹配',403);
  return {datasetId,dimensions,metrics,filters,limit};
}
function owned(db,ctx,id){
  const s=db.prepare('SELECT * FROM analysis_schedules WHERE id=? AND tenant_id=? AND user_id=?').get(id,ctx.tenantId,ctx.userId);
  if(!s)throw new InputError('定时分析任务不存在或没有权限',404);
  return s;
}
function activeContext(db,s){
  const membership=db.prepare('SELECT role FROM memberships WHERE tenant_id=? AND user_id=?').get(s.tenant_id,s.user_id);
  if(!membership || !ROLES.has(membership.role))throw new InputError('定时任务执行者不再拥有编辑权限',403);
  return {tenantId:s.tenant_id,userId:s.user_id,role:membership.role};
}
function safeRow(s){return {id:s.id,title:s.title,datasetId:s.dataset_id,intervalMinutes:s.interval_minutes,enabled:s.enabled===1,version:s.version,nextRunAt:s.next_run_at,lastRunAt:s.last_run_at,createdAt:s.created_at,spec:JSON.parse(s.spec_json)};}

export function listSchedules(db,ctx){
  return db.prepare('SELECT * FROM analysis_schedules WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100').all(ctx.tenantId,ctx.userId)
    .flatMap(s=>{try{readableCatalog(db,ctx,getDataset(db,ctx,s.dataset_id));return [safeRow(s)];}catch(e){if(e instanceof InputError && (e.status===403 || e.status===404))return [];throw e;}});
}
export function getSchedule(db,ctx,id){
  const s=owned(db,ctx,id);readableCatalog(db,ctx,getDataset(db,ctx,s.dataset_id));return safeRow(s);
}
export async function createSchedule(db,ctx,input,options={}){
  requireEditor(ctx);
  const dataset=getDataset(db,ctx,input?.datasetId);
  const title=label(input?.title,'任务名称'),interval=normalizeInterval(input?.intervalMinutes);
  const spec=parseSpec(dataset.id,input.spec);
  validateQueryPolicy(db,ctx,dataset,spec);
  // A real query is the executable, typed-query preflight, including source metadata.
  await executeAnyQuery(db,ctx,spec,{...options,record:false});
  const now=Date.now(),id=randomUUID();
  db.prepare(`INSERT INTO analysis_schedules(id,tenant_id,workspace_id,user_id,dataset_id,title,spec_json,interval_minutes,enabled,next_run_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`).run(id,ctx.tenantId,dataset.workspace_id,ctx.userId,dataset.id,title,JSON.stringify(spec),interval,now+interval*60_000,now,now);
  audit(db,ctx,'analysis.schedule.create','schedule',id);
  return getSchedule(db,ctx,id);
}
export async function updateSchedule(db,ctx,id,input,options={}){
  requireEditor(ctx);const current=owned(db,ctx,id);
  if(!input||!Number.isInteger(input.version)||input.version!==current.version)throw new InputError('任务版本冲突',409);
  const title=input.title===undefined?current.title:label(input.title,'任务名称');
  const interval=input.intervalMinutes===undefined?current.interval_minutes:normalizeInterval(input.intervalMinutes);
  const enabled=input.enabled===undefined?current.enabled===1:input.enabled;
  if(typeof enabled!=='boolean')throw new InputError('enabled 必须为布尔值');
  const dataset=getDataset(db,ctx,current.dataset_id);
  let spec=JSON.parse(current.spec_json);
  if(input.spec!==undefined){spec=parseSpec(dataset.id,input.spec);validateQueryPolicy(db,ctx,dataset,spec);await executeAnyQuery(db,ctx,spec,{...options,record:false});}
  else validateQueryPolicy(db,ctx,dataset,spec);
  const now=Date.now(),nextRun=enabled && (!current.enabled || interval!==current.interval_minutes)?now+interval*60_000:current.next_run_at;
  const result=db.prepare(`UPDATE analysis_schedules SET title=?,spec_json=?,interval_minutes=?,enabled=?,next_run_at=?,version=version+1,updated_at=?
    WHERE id=? AND tenant_id=? AND user_id=? AND version=?`).run(title,JSON.stringify(spec),interval,Number(enabled),nextRun,now,id,ctx.tenantId,ctx.userId,input.version);
  if(result.changes!==1)throw new InputError('任务版本冲突',409);
  audit(db,ctx,'analysis.schedule.update','schedule',id);
  return getSchedule(db,ctx,id);
}

/** One lease protects manual and automatic execution from concurrent duplicate runs. */
export async function executeSchedule(db,scheduleId,{drivers,manual=false,now=Date.now()}={}){
  const s=db.prepare('SELECT * FROM analysis_schedules WHERE id=?').get(scheduleId);
  if(!s)throw new InputError('定时任务不存在',404);
  if(!manual && (!s.enabled || s.next_run_at>now))return null;
  const lease=randomUUID();
  const next=now+s.interval_minutes*60_000;
  const claim=db.prepare(`UPDATE analysis_schedules SET lease_token=?,lease_until=?,last_run_at=?,next_run_at=?
    WHERE id=? AND lease_until<=? AND (?=1 OR (enabled=1 AND next_run_at<=?))`)
    .run(lease,now+120_000,now,manual?s.next_run_at:next,s.id,now,Number(manual),now);
  if(claim.changes!==1)throw new InputError('定时任务正在执行或尚未到期',409);
  let runId=randomUUID(),result,summary=null,policyRevision=0,policyRole=null,error=null,status='failed',datasetId=s.dataset_id;
  try {
    const ctx=activeContext(db,s),dataset=getDataset(db,ctx,datasetId),spec=JSON.parse(s.spec_json);
    readableCatalog(db,ctx,dataset);
    policyRevision=datasetPolicyRevision(db,ctx,datasetId);policyRole=ctx.role;
    const output=await executeAnyQuery(db,ctx,spec,{drivers});
    // Fail closed if authorization changed while the database query was pending.
    const updated=activeContext(db,s);
    if(updated.role!==policyRole || datasetPolicyRevision(db,updated,datasetId)!==policyRevision)
      throw new InputError('任务执行期间数据权限发生变化，请重新运行',409);
    validateQueryPolicy(db,updated,dataset,spec);
    const trimmed={queryId:output.queryId,datasetId,columns:output.columns,rows:output.rows.slice(0,30),count:output.count};
    if(Buffer.byteLength(JSON.stringify(trimmed))>MAX_RESULT_BYTES)throw new InputError('分析结果超过保存限制（100 KB）',422);
    result=trimmed;
    summary=`定时分析返回 ${output.count} 行结果，指标：${spec.metrics.join('、')}。结果是查询统计，不能直接作为因果结论。`;
    status='success';
    audit(db,updated,'analysis.schedule.run','schedule',scheduleId);
  }catch(e){error=e instanceof InputError?e.message:'定时查询失败；请检查受控数据库日志';}
  finally{
    db.prepare(`INSERT INTO analysis_schedule_runs(id,schedule_id,tenant_id,user_id,status,result_json,summary,error,policy_revision,policy_role,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId,s.id,s.tenant_id,s.user_id,status,result?JSON.stringify(result):null,summary,error,policyRevision,policyRole,now,Date.now());
    db.prepare('UPDATE analysis_schedules SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').run(s.id,lease);
    // Avoid unbounded retention when the worker runs for months.
    db.prepare(`DELETE FROM analysis_schedule_runs WHERE schedule_id=? AND id NOT IN (
      SELECT id FROM analysis_schedule_runs WHERE schedule_id=? ORDER BY started_at DESC, rowid DESC LIMIT 50)`).run(s.id,s.id);
  }
  return {id:runId,status,summary,error,result};
}
export function listScheduleRuns(db,ctx,scheduleId){
  const s=owned(db,ctx,scheduleId),ds=getDataset(db,ctx,s.dataset_id);
  const p=readableCatalog(db,ctx,ds),revision=datasetPolicyRevision(db,ctx,ds.id);
  const runs=db.prepare('SELECT * FROM analysis_schedule_runs WHERE schedule_id=? AND tenant_id=? AND user_id=? ORDER BY started_at DESC,rowid DESC LIMIT 50').all(s.id,ctx.tenantId,ctx.userId);
  return runs.map(r=>{
    const permitted = r.status==='success' && r.policy_revision===revision && r.policy_role===ctx.role;
    const base={id:r.id,status:r.status,startedAt:r.started_at,finishedAt:r.finished_at,dataAvailable:permitted,error:r.error};
    if(!permitted)return base;
    // Permission narrowing to a *different* set can have a restored revision only
    // in impossible DB-manipulation cases; revision is always monotonic on updates.
    return {...base,summary:r.summary,result:JSON.parse(r.result_json)};
  });
}
/** A process-local poller. Deliberately not advertised as distributed scheduling. */
export function startScheduleWorker(db,{drivers,intervalMs=30_000,startImmediately=true,onError=()=>{}}={}){
  let stopped=false,busy=false;
  async function tick(){
    if(stopped||busy)return;
    busy=true;
    try{
      const due=db.prepare('SELECT id FROM analysis_schedules WHERE enabled=1 AND next_run_at<=? AND lease_until<=? ORDER BY next_run_at LIMIT 5').all(Date.now(),Date.now());
      for(const item of due){if(stopped)break;try{await executeSchedule(db,item.id,{drivers});}catch(e){onError(e);}}
    }finally{busy=false;}
  }
  const timer=setInterval(()=>{void tick().catch(onError);},intervalMs);timer.unref?.();
  if(startImmediately)void tick().catch(onError);
  return {stop(){stopped=true;clearInterval(timer);},tick};
}