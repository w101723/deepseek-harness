/** Role-scoped dataset policies. The stored row filter is a trusted administrator
 * constraint, never a request-side SQL fragment. All policy fields are resolved
 * against the immutable dataset model and compiled with bound parameters.
 */
import { InputError } from './query.mjs';
import { audit } from './db.mjs';

const ROLES = new Set(['viewer','editor','admin']);
const OPS = new Set(['eq','ne','gt','gte','lt','lte']);

function fields(dataset) {
  return {dimensions: JSON.parse(dataset.dimensions_json), metrics: JSON.parse(dataset.metrics_json)};
}
function validateSubset(input, known, label) {
  if(input === null || input === undefined) return null;
  if(!Array.isArray(input) || input.length>100 || input.some(f=>typeof f!=='string'||!known.includes(f)) || new Set(input).size!==input.length)
    throw new InputError(`${label} 不合法`);
  return input;
}
function validateRows(input, dimensions) {
  if(input === null || input === undefined) return [];
  if(!Array.isArray(input)||input.length>8)throw new InputError('行级过滤条件数量无效');
  return input.map(f=>{
    if(!f || typeof f!=='object' || Array.isArray(f) || !dimensions.includes(f.field) || !OPS.has(f.op) ||
      !['number','string'].includes(typeof f.value) || !Number.isFinite(typeof f.value==='number'?f.value:0) || String(f.value).length>80)
      throw new InputError('行级策略条件无效');
    return {field:f.field,op:f.op,value:f.value};
  });
}
function readPolicy(db,ctx,dataset,role=ctx.role) {
  if(!ROLES.has(role))throw new InputError('无效角色',400);
  const record=db.prepare('SELECT * FROM dataset_role_policies WHERE tenant_id=? AND dataset_id=? AND role=?').get(ctx.tenantId,dataset.id,role);
  if(record){
    return { role, canQuery:record.can_query===1,
      dimensions: JSON.parse(record.dimensions_json), metrics:JSON.parse(record.metrics_json),
      rowFilters:JSON.parse(record.row_filters_json), version: record.version,explicit:true};
  }
  const source=db.prepare('SELECT kind FROM datasources WHERE id=? AND tenant_id=?').get(dataset.datasource_id,ctx.tenantId);
  return {role,canQuery:role!=='viewer'||source?.kind==='demo-sqlite',dimensions:null,metrics:null,rowFilters:[],version:0,explicit:false};
}
export function datasetPolicyRevision(db,ctx,datasetId){
  return db.prepare('SELECT revision FROM dataset_policy_generations WHERE tenant_id=? AND dataset_id=?').get(ctx.tenantId,datasetId)?.revision??0;
}
export function effectivePolicy(db,ctx,dataset){
  const p=readPolicy(db,ctx,dataset);
  if(!p.canQuery)throw new InputError('无权查询当前数据集',403);
  return p;
}
export function readableCatalog(db,ctx,dataset){
  const p=effectivePolicy(db,ctx,dataset),f=fields(dataset);
  const dimensions=f.dimensions.filter(k=>p.dimensions===null||p.dimensions.includes(k));
  const metrics=f.metrics.filter(k=>p.metrics===null||p.metrics.includes(k));
  return {dimensions,metrics};
}
export function validateQueryPolicy(db,ctx,dataset,spec){
  const p=effectivePolicy(db,ctx,dataset);
  const dimensionAccess=p.dimensions;
  const metricAccess=p.metrics;
  if(dimensionAccess!==null && (spec.dimensions??[]).some(d=>!dimensionAccess.includes(d)))throw new InputError('无权访问请求的维度',403);
  if(metricAccess!==null && (spec.metrics??[]).some(m=>!metricAccess.includes(m)))throw new InputError('无权访问请求的指标',403);
  if(dimensionAccess!==null && (spec.filters??[]).some(f=>!f || !dimensionAccess.includes(f.field)))throw new InputError('无权使用受限字段过滤',403);
  // Every caller, including AI native tools and scheduled jobs, receives the
  // same policy predicate; user-supplied filters can only narrow results.
  return p.rowFilters;
}
export function listDatasetPolicies(db,ctx,dataset){
  if(ctx.role!=='admin')throw new InputError('仅管理员可查看数据策略',403);
  return [...ROLES].map(role=>readPolicy(db,ctx,dataset,role));
}
export function setDatasetPolicy(db,ctx,dataset,input={}){
  if(ctx.role!=='admin')throw new InputError('仅管理员可变更数据权限',403);
  if(!input || typeof input!=='object' || Array.isArray(input) || !ROLES.has(input.role))throw new InputError('无效策略角色');
  if(typeof input.canQuery!=='boolean')throw new InputError('canQuery 必须为布尔值');
  if(!Number.isInteger(input.version)||input.version<0)throw new InputError('必须指定当前策略版本');
  const f=fields(dataset);
  const dimensions=validateSubset(input.dimensions,f.dimensions,'维度白名单');
  const metrics=validateSubset(input.metrics,f.metrics,'指标白名单');
  const rowFilters=validateRows(input.rowFilters,f.dimensions);
  if(dimensions!==null && rowFilters.some(x=>!dimensions.includes(x.field)))throw new InputError('行策略使用了非授权字段');
  const current=readPolicy(db,ctx,dataset,input.role);
  if(input.version!==current.version)throw new InputError('数据权限策略版本冲突',409);
  const payload=[ctx.tenantId,dataset.id,input.role,Number(input.canQuery),JSON.stringify(dimensions),JSON.stringify(metrics),JSON.stringify(rowFilters)];
  db.exec('BEGIN IMMEDIATE');
  try {
    if(!current.explicit){
      const r=db.prepare('INSERT OR IGNORE INTO dataset_role_policies(tenant_id,dataset_id,role,can_query,dimensions_json,metrics_json,row_filters_json) VALUES (?,?,?,?,?,?,?)').run(...payload);
      if(r.changes!==1)throw new InputError('数据权限策略版本冲突',409);
    }else{
      const r=db.prepare('UPDATE dataset_role_policies SET can_query=?,dimensions_json=?,metrics_json=?,row_filters_json=?,version=version+1 WHERE tenant_id=? AND dataset_id=? AND role=? AND version=?')
        .run(Number(input.canQuery),JSON.stringify(dimensions),JSON.stringify(metrics),JSON.stringify(rowFilters),ctx.tenantId,dataset.id,input.role,input.version);
      if(r.changes!==1)throw new InputError('数据权限策略版本冲突',409);
    }
    db.prepare('INSERT INTO dataset_policy_generations(tenant_id,dataset_id,revision) VALUES (?,?,1) ON CONFLICT(tenant_id,dataset_id) DO UPDATE SET revision=revision+1').run(ctx.tenantId,dataset.id);
    audit(db,ctx,'dataset.policy.update','dataset',dataset.id);
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  return {...readPolicy(db,ctx,dataset,input.role)};
}
