import { id, audit } from './db.mjs';
import { InputError, getDataset } from './query.mjs';
import { validateQueryPolicy } from './dataset-policy.mjs';
import { connectionFor, withConnection, identifier, bindPlaceholder, sourceSchema } from './connectors.mjs';

const allowedOps={eq:'=',ne:'<>',gte:'>=',lte:'<=',gt:'>',lt:'<'};
const numeric=/\b(bigint|smallint|tinyint|mediumint|integer|int|decimal|numeric|float|double|real|money|number)\b/i;
export function modelFromTable(table){
  if(!table?.schema||!table?.name||!Array.isArray(table.columns)||!table.columns.length)throw new InputError('目标表没有可用字段');
  const columns=table.columns.filter(col=>/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col.name));
  const dimensions=columns.map(c=>c.name).slice(0,50);
  const metrics={rows:{kind:'count'}};
  for(const col of columns){if(numeric.test(col.type))metrics[`sum_${col.name}`]={kind:'sum',column:col.name};}
  return {schema:table.schema,table:table.name,dimensions,metrics};
}
export async function createExternalModel(db,ctx,source,tableReq,options={}){
  const schema=await sourceSchema(source,options);
  const table=schema.tables.find(t=>t.schema===tableReq.schema&&t.name===tableReq.table);
  if(!table)throw new InputError('数据源中未发现指定的表',404);
  return modelFromTable(table);
}
export function compileExternalQuery(db,ctx,spec){
  if(!spec||typeof spec!=='object'||Array.isArray(spec))throw new InputError('QuerySpec 必须是对象');
  const dataset=getDataset(db,ctx,spec.datasetId);
  const source=db.prepare('SELECT * FROM datasources WHERE id=? AND tenant_id=? AND workspace_id=?').get(dataset.datasource_id,ctx.tenantId,dataset.workspace_id);
  if(!source||source.kind==='demo-sqlite')throw new InputError('不是外部数据集');
  const modelRow=db.prepare('SELECT * FROM external_dataset_models WHERE dataset_id=?').get(dataset.id);
  if(!modelRow)throw new InputError('数据集模型不存在',409);
  const model=JSON.parse(modelRow.definition_json);
  const dims=spec.dimensions??[],metrics=spec.metrics??['rows'],filters=spec.filters??[];
  if(!Array.isArray(dims)||dims.length>3||new Set(dims).size!==dims.length||dims.some(d=>!model.dimensions.includes(d)))throw new InputError('不允许的维度');
  if(!Array.isArray(metrics)||metrics.length<1||metrics.length>4||new Set(metrics).size!==metrics.length||metrics.some(m=>!Object.hasOwn(model.metrics,m)))throw new InputError('不允许的指标');
  if(!Array.isArray(filters)||filters.length>8)throw new InputError('不允许的过滤条件');
  const policyFilters=validateQueryPolicy(db,ctx,dataset,{dimensions:dims,metrics,filters});
  const q=n=>identifier(n,source.kind), params=[],where=[];
  for(const f of [...filters,...policyFilters]){
    if(!f||!model.dimensions.includes(f.field)||!Object.hasOwn(allowedOps,f.op))throw new InputError('不允许的过滤字段/操作');
    if(!['string','number'].includes(typeof f.value)||String(f.value).length>200)throw new InputError('过滤值无效');
    params.push(f.value);where.push(`${q(f.field)} ${allowedOps[f.op]} ${bindPlaceholder(source.kind,params.length)}`);
  }
  const selectors=dims.map(d=>q(d));
  for(const m of metrics){
    const def=model.metrics[m];
    const expr=def.kind==='count'?'COUNT(*)':def.kind==='sum'?`SUM(${q(def.column)})`:null;
    if(!expr)throw new InputError('不支持的指标表达式');
    selectors.push(`${expr} AS ${q(m)}`);
  }
  const limit=Number.isInteger(spec.limit)?Math.max(1,Math.min(100,spec.limit)):50;
  const from=`${q(model.schema)}.${q(model.table)}`;
  const sql=`SELECT ${selectors.join(', ')} FROM ${from}${where.length?' WHERE '+where.join(' AND '):''}${dims.length?' GROUP BY '+dims.map(q).join(', '):''} ORDER BY ${dims.length?dims.map(q).join(', '):q(metrics[0])} LIMIT ${bindPlaceholder(source.kind,params.length+1)}`;
  return {source,dataset,sql,params:[...params,limit],dimensions:dims,metrics,limit};
}
export async function executeExternalQuery(db,ctx,spec,options={}){
  const compiled=compileExternalQuery(db,ctx,spec);
  const cfg=connectionFor(compiled.source);
  const rows=await withConnection(cfg,query=>query(compiled.sql,compiled.params),options);
  const cleanRows=rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='bigint'?Number(v):typeof v==='object'&&v instanceof Date?v.toISOString():v])));
  const queryId=id();
  if(options.record!==false){
    db.prepare('INSERT INTO query_runs(id,tenant_id,user_id,dataset_id,spec_json,row_count) VALUES (?,?,?,?,?,?)').run(queryId,ctx.tenantId,ctx.userId,compiled.dataset.id,JSON.stringify({...spec,limit:compiled.limit}),cleanRows.length);
    audit(db,ctx,'query.execute','dataset',compiled.dataset.id);
  }
  return {queryId,datasetId:compiled.dataset.id,sql:compiled.sql,rows:cleanRows,columns:[...compiled.dimensions,...compiled.metrics],count:cleanRows.length,limit:compiled.limit};
}
export async function executeAnyQuery(db,ctx,spec,options={}){
  const dataset=getDataset(db,ctx,spec?.datasetId);
  const source=db.prepare('SELECT kind FROM datasources WHERE id=? AND tenant_id=?').get(dataset.datasource_id,ctx.tenantId);
  if(source?.kind==='demo-sqlite'){
    const {executeQuery}=await import('./query.mjs');return executeQuery(db,ctx,spec,options);
  }
  return executeExternalQuery(db,ctx,spec,options);
}
