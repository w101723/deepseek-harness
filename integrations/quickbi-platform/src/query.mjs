import { id, audit } from './db.mjs';

const fields = new Set(['region','category','channel','order_date']);
const metrics = Object.freeze({revenue:'ROUND(SUM(revenue),2)',cost:'ROUND(SUM(cost),2)',quantity:'SUM(quantity)',orders:'COUNT(*)'});
const operators = new Set(['eq','ne','in','gte','lte']);
export class InputError extends Error { constructor(message,status=400){ super(message);this.status=status; } }
export function getDataset(db,ctx,datasetId) {
  const row = db.prepare('SELECT d.* FROM datasets d JOIN datasources s ON s.id=d.datasource_id AND s.tenant_id=d.tenant_id WHERE d.id=? AND d.tenant_id=? AND s.workspace_id=d.workspace_id').get(datasetId,ctx.tenantId);
  if(!row) throw new InputError('数据集不存在或无访问权限',404);
  return row;
}
export function executeQuery(db,ctx,spec,{record=true}={}) {
  if(!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new InputError('QuerySpec 必须是对象');
  const data = getDataset(db,ctx,spec.datasetId);
  const dimensions = spec.dimensions ?? [];
  const measures = spec.metrics ?? ['revenue'];
  const filters = spec.filters ?? [];
  const enabledDimensions = JSON.parse(data.dimensions_json), enabledMetrics = JSON.parse(data.metrics_json);
  if(!Array.isArray(dimensions)||dimensions.length>2||dimensions.some(x=>!fields.has(x)||!enabledDimensions.includes(x))||new Set(dimensions).size!==dimensions.length) throw new InputError('不支持的维度');
  if(!Array.isArray(measures)||measures.length<1||measures.length>4||measures.some(x=>!Object.hasOwn(metrics,x)||!enabledMetrics.includes(x))||new Set(measures).size!==measures.length) throw new InputError('不支持的指标');
  if(!Array.isArray(filters)||filters.length>8) throw new InputError('过滤条件数量不合法');
  const args=[ctx.tenantId,data.workspace_id];
  const where=['tenant_id=?','workspace_id=?'];
  for(const f of filters){
    if(!f || !fields.has(f.field) || !enabledDimensions.includes(f.field) || !operators.has(f.op)) throw new InputError('不支持的过滤条件');
    if(f.op==='in'){
      if(!Array.isArray(f.value)||!f.value.length||f.value.length>20||f.value.some(v=>typeof v!=='string'||v.length>80)) throw new InputError('IN 参数无效');
      where.push(`"${f.field}" IN (${f.value.map(()=>'?').join(',')})`); args.push(...f.value);
    }else{
      if(typeof f.value!=='string'||f.value.length>80) throw new InputError('过滤值无效');
      where.push(`"${f.field}" ${ {eq:'=',ne:'!=',gte:'>=',lte:'<='}[f.op] } ?`);args.push(f.value);
    }
  }
  const limit = Math.min(100,Math.max(1, Number.isInteger(spec.limit)?spec.limit:50));
  const columns = [...dimensions.map(d=>`"${d}"`),...measures.map(m=>`${metrics[m]} AS "${m}"`)];
  const sql = `SELECT ${columns.join(', ')} FROM sales_demo WHERE ${where.join(' AND ')}${dimensions.length?` GROUP BY ${dimensions.map(d=>`"${d}"`).join(', ')}`:''} ORDER BY ${dimensions.length?dimensions.map(d=>`"${d}"`).join(', '):'1'} LIMIT ?`;
  // All identifiers and expressions come from allowlists. User values are bound, never interpolated.
  const rows=db.prepare(sql).all(...args,limit).map(r=>({...r}));
  const runId=id();
  if(record){
    db.prepare('INSERT INTO query_runs(id,tenant_id,user_id,dataset_id,spec_json,row_count) VALUES (?,?,?,?,?,?)').run(runId,ctx.tenantId,ctx.userId,data.id,JSON.stringify({...spec,limit}),rows.length);
    audit(db,ctx,'query.execute','dataset',data.id);
  }
  return {queryId:runId,datasetId:data.id,sql,rows,columns:[...dimensions,...measures],count:rows.length,limit};
}
export function suggestSpec(question,datasets){
  if(typeof question!=='string'||!question.trim()||question.length>500) throw new InputError('请输入 1–500 字的分析问题');
  const dataset=datasets[0];if(!dataset) throw new InputError('请先创建数据集',409);
  const enabledDims=JSON.parse(dataset.dimensions_json),enabledMetrics=JSON.parse(dataset.metrics_json);
  const pairs=[['region',/地区|区域|华东|华北|华南|西部/],['category',/品类|类别|产品|商品/],['channel',/渠道|线上|线下/],['order_date',/日期|月份|时间|趋势/]];
  const dim=pairs.find(([key,rx])=>enabledDims.includes(key)&&rx.test(question))?.[0]??enabledDims[0];
  const metric=([['cost',/成本/],['quantity',/销量|数量/],['orders',/订单数|笔数/],['revenue',/销售|营收|收入|金额/]].find(([key,rx])=>enabledMetrics.includes(key)&&rx.test(question))?.[0])??enabledMetrics[0];
  return {datasetId:dataset.id,dimensions:dim?[dim]:[],metrics:[metric],limit:50};
}