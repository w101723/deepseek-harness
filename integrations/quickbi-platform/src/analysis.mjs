import { id, audit } from './db.mjs';
import { InputError, getDataset, suggestSpec } from './query.mjs';
import { executeAnyQuery } from './query-external.mjs';
import { planWithHarness, narrateWithHarness } from './harness.mjs';

export function analysisSession(db,ctx,sessionId){
  const row=db.prepare('SELECT * FROM analysis_sessions WHERE id=? AND tenant_id=? AND user_id=?').get(sessionId,ctx.tenantId,ctx.userId);
  if(!row)throw new InputError('分析会话不存在或没有权限',404);
  return row;
}
export function listSessions(db,ctx){return db.prepare('SELECT id,title,dataset_id,workspace_id,created_at,updated_at FROM analysis_sessions WHERE tenant_id=? AND user_id=? ORDER BY updated_at DESC LIMIT 100').all(ctx.tenantId,ctx.userId);}
export function listMessages(db,ctx,sessionId){
  analysisSession(db,ctx,sessionId);
  return db.prepare('SELECT id,role,text,spec_json,result_json,created_at FROM analysis_messages WHERE session_id=? AND tenant_id=? ORDER BY rowid LIMIT 150').all(sessionId,ctx.tenantId).map(r=>({...r,spec:r.spec_json?JSON.parse(r.spec_json):null,result:r.result_json?JSON.parse(r.result_json):null,spec_json:undefined,result_json:undefined}));
}
export function createSession(db,ctx,{datasetId,title='',topicId}={}){
  const ds=getDataset(db,ctx,datasetId);
  if(typeof title!=='string'||title.trim().length>80)throw new InputError('会话标题过长');
  if(topicId){
    const topic=db.prepare('SELECT * FROM analysis_topics WHERE id=? AND tenant_id=? AND dataset_id=?').get(topicId,ctx.tenantId,ds.id);
    if(!topic||(topic.status!=='published'&&topic.owner_id!==ctx.userId))throw new InputError('分析主题不存在或没有权限',404);
  }
  const sessionId=id();
  db.prepare('INSERT INTO analysis_sessions(id,tenant_id,workspace_id,user_id,dataset_id,title) VALUES (?,?,?,?,?,?)').run(sessionId,ctx.tenantId,ds.workspace_id,ctx.userId,ds.id,title.trim()||'新分析');
  if(topicId)db.prepare('INSERT INTO analysis_session_topics(session_id,topic_id) VALUES (?,?)').run(sessionId,topicId);
  audit(db,ctx,'analysis.session.create','session',sessionId);
  return {id:sessionId,title:title.trim()||'新分析',datasetId:ds.id};
}
function fallbackPlan(db,ctx,question,session,lastSpec){
  const data=getDataset(db,ctx,session.dataset_id);
  const model=db.prepare('SELECT definition_json FROM external_dataset_models WHERE dataset_id=?').get(data.id);
  if(model){
    const d=JSON.parse(model.definition_json);
    const previous=lastSpec?.datasetId===data.id?lastSpec:null;
    const dim=d.dimensions.find(x=>question.toLowerCase().includes(x.toLowerCase()));
    const metric=Object.keys(d.metrics).find(x=>question.toLowerCase().includes(x.toLowerCase()));
    return {datasetId:data.id,dimensions:dim?[dim]:previous?.dimensions??d.dimensions.slice(0,1),metrics:[metric||previous?.metrics?.[0]||Object.keys(d.metrics)[0]],limit:50};
  }
  const suggested=suggestSpec(question,[data]);
  if(lastSpec?.datasetId===data.id && /继续|同样|然后|再看|换成|上一/.test(question)){
    return {...suggested,metrics:/(成本|销售|销量|数量|订单)/.test(question)?suggested.metrics:lastSpec.metrics,dimensions:/(地区|品类|渠道|日期|时间)/.test(question)?suggested.dimensions:lastSpec.dimensions};
  }
  return suggested;
}
export async function askSession(db,ctx,sessionId,question,options={}){
  const session=analysisSession(db,ctx,sessionId);
  if(typeof question!=='string'||question.trim().length<1||question.length>500)throw new InputError('分析问题须在 1–500 字之间');
  const messages=listMessages(db,ctx,sessionId),last=messages.filter(x=>x.role==='assistant').at(-1),lastSpec=last?.spec;
  const dataset=getDataset(db,ctx,session.dataset_id);
  const external=db.prepare('SELECT definition_json FROM external_dataset_models WHERE dataset_id=?').get(dataset.id);
  const catalog=external?JSON.parse(external.definition_json):{dimensions:JSON.parse(dataset.dimensions_json),metrics:Object.fromEntries(JSON.parse(dataset.metrics_json).map(m=>[m,{kind:'builtin'}]))};
  const theme=db.prepare('SELECT t.name,t.description FROM analysis_topics t JOIN analysis_session_topics st ON st.topic_id=t.id WHERE st.session_id=? AND t.tenant_id=?').get(sessionId,ctx.tenantId);
  if(theme)catalog.topic={name:theme.name,description:theme.description};
  let spec,mode='deterministic-preview';
  if(options.planner){spec=await options.planner({question,history:messages.slice(-8),catalog,datasetId:dataset.id});mode='agent-planned';}
  else if(options.harnessEnabled){spec=await planWithHarness({question,history:messages.slice(-8),catalog,datasetId:dataset.id},{enabled:true,home:options.harnessHome});mode='agent-planned';}
  else spec=fallbackPlan(db,ctx,question,session,lastSpec);
  if(!spec||typeof spec!=='object'||Array.isArray(spec))throw new InputError('分析计划无效');
  // Never trust a model-supplied tenant id, SQL, data source or target dataset.
  spec={datasetId:dataset.id,dimensions:spec.dimensions,metrics:spec.metrics,filters:spec.filters??[],limit:spec.limit??50};
  const result=await executeAnyQuery(db,ctx,spec,{drivers:options.drivers});
  let summary=`按 ${spec.dimensions?.join('、')||'总体'} 分析 ${spec.metrics?.join('、')}，查询得到 ${result.count} 行。结果为聚合统计，不代表因果结论。`;
  if(options.harnessEnabled && !options.planner){
    summary=await narrateWithHarness(question,result,{enabled:true,home:options.harnessHome})||summary;
  }
  const userId=id(),assistantId=id();
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('INSERT INTO analysis_messages(id,session_id,tenant_id,role,text) VALUES (?,?,?,?,?)').run(userId,session.id,ctx.tenantId,'user',question.trim());
    db.prepare('INSERT INTO analysis_messages(id,session_id,tenant_id,role,text,spec_json,result_json) VALUES (?,?,?,?,?,?,?)').run(assistantId,session.id,ctx.tenantId,'assistant',summary,JSON.stringify(spec),JSON.stringify(result));
    db.prepare('UPDATE analysis_sessions SET updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?').run(session.id,ctx.tenantId);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  audit(db,ctx,'analysis.ask','session',sessionId);
  return {sessionId,mode,summary,spec,result,messageId:assistantId};
}
export function createArtifact(db,ctx,sessionId,{name,kind='chart',chart='bar'}={}){
  const session=analysisSession(db,ctx,sessionId);
  if(typeof name!=='string'||name.trim().length<1||name.length>80)throw new InputError('作品名称长度无效');
  if(!['chart','table','canvas'].includes(kind)||!['bar','line','table'].includes(chart))throw new InputError('作品类型无效');
  const last=db.prepare("SELECT spec_json,result_json,text FROM analysis_messages WHERE session_id=? AND tenant_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1").get(sessionId,ctx.tenantId);
  if(!last||!last.result_json)throw new InputError('请先完成一次分析',409);
  const content={kind,chart,spec:JSON.parse(last.spec_json),result:JSON.parse(last.result_json),summary:last.text};
  const artifactId=id();
  db.prepare('INSERT INTO analysis_artifacts(id,tenant_id,workspace_id,session_id,name,content_json) VALUES (?,?,?,?,?,?)').run(artifactId,ctx.tenantId,session.workspace_id,sessionId,name.trim(),JSON.stringify(content));
  audit(db,ctx,'analysis.artifact.create','artifact',artifactId);
  return {id:artifactId,version:1};
}
export function artifacts(db,ctx){
  return db.prepare('SELECT a.id,a.name,a.version,a.workspace_id,a.session_id,a.updated_at FROM analysis_artifacts a JOIN analysis_sessions s ON s.id=a.session_id WHERE a.tenant_id=? AND s.user_id=? ORDER BY a.updated_at DESC LIMIT 100').all(ctx.tenantId,ctx.userId);
}
export function artifact(db,ctx,id){
  const row=db.prepare('SELECT a.* FROM analysis_artifacts a JOIN analysis_sessions s ON s.id=a.session_id WHERE a.id=? AND a.tenant_id=? AND s.user_id=?').get(id,ctx.tenantId,ctx.userId);
  if(!row)throw new InputError('作品不存在或没有权限',404);
  return {id:row.id,name:row.name,sessionId:row.session_id,version:row.version,content:JSON.parse(row.content_json)};
}

export function listTopics(db,ctx){return db.prepare("SELECT id,name,description,version,status,dataset_id,workspace_id FROM analysis_topics WHERE tenant_id=? AND (status='published' OR owner_id=?) ORDER BY created_at DESC").all(ctx.tenantId,ctx.userId);}
export function createTopic(db,ctx,{datasetId,name,description=''}={}){
  if(ctx.role==='viewer')throw new InputError('没有创建主题的权限',403);
  const ds=getDataset(db,ctx,datasetId);
  if(typeof name!=='string'||!name.trim()||name.length>80||typeof description!=='string'||description.length>5000)throw new InputError('主题名称或描述无效');
  const topicId=id();db.prepare('INSERT INTO analysis_topics(id,tenant_id,workspace_id,owner_id,dataset_id,name,description) VALUES (?,?,?,?,?,?,?)').run(topicId,ctx.tenantId,ds.workspace_id,ctx.userId,ds.id,name.trim(),description);
  audit(db,ctx,'analysis.topic.create','topic',topicId);return {id:topicId,status:'draft',version:1};
}
export function publishTopic(db,ctx,topicId,version){
  if(ctx.role==='viewer')throw new InputError('没有发布权限',403);
  const topic=db.prepare('SELECT * FROM analysis_topics WHERE id=? AND tenant_id=? AND owner_id=?').get(topicId,ctx.tenantId,ctx.userId);
  if(!topic)throw new InputError('主题不存在或没有权限',404);
  if(!Number.isInteger(version)||version!==topic.version)throw new InputError('主题版本冲突',409);
  db.prepare("UPDATE analysis_topics SET status='published',version=version+1 WHERE id=?").run(topicId);
  audit(db,ctx,'analysis.topic.publish','topic',topicId);return {id:topicId,status:'published',version:version+1};
}
export function listCanvases(db,ctx){return db.prepare('SELECT id,name,session_id,version,updated_at FROM analysis_canvases WHERE tenant_id=? AND user_id=? ORDER BY updated_at DESC').all(ctx.tenantId,ctx.userId);}
export function getCanvas(db,ctx,canvasId){
  const canvas=db.prepare('SELECT * FROM analysis_canvases WHERE id=? AND tenant_id=? AND user_id=?').get(canvasId,ctx.tenantId,ctx.userId);
  if(!canvas)throw new InputError('画布不存在或没有权限',404);
  return {id:canvas.id,name:canvas.name,sessionId:canvas.session_id,version:canvas.version,layout:JSON.parse(canvas.layout_json)};
}
function checkLayout(db,ctx,sessionId,layout){
  if(!Array.isArray(layout)||layout.length>40)throw new InputError('画布组件数量无效');
  return layout.map(w=>{
    if(!w||typeof w!=='object'||typeof w.artifactId!=='string')throw new InputError('画布组件无效');
    const a=artifact(db,ctx,w.artifactId);
    if(a.sessionId!==sessionId)throw new InputError('画布不允许包含其他会话的作品',403);
    const n={artifactId:w.artifactId,x:w.x,y:w.y,w:w.w,h:w.h};
    if([n.x,n.y,n.w,n.h].some(v=>!Number.isInteger(v)||v<0||v>24)||n.w<1||n.h<1||n.x+n.w>24)throw new InputError('画布布局超出边界');
    return n;
  });
}
export function createCanvas(db,ctx,{sessionId,name}={}){
  if(ctx.role==='viewer')throw new InputError('没有创建画布的权限',403);
  const session=analysisSession(db,ctx,sessionId);
  if(typeof name!=='string'||!name.trim()||name.length>80)throw new InputError('画布名称无效');
  const canvasId=id();
  db.prepare('INSERT INTO analysis_canvases(id,tenant_id,workspace_id,user_id,session_id,name) VALUES (?,?,?,?,?,?)').run(canvasId,ctx.tenantId,session.workspace_id,ctx.userId,sessionId,name.trim());
  audit(db,ctx,'analysis.canvas.create','canvas',canvasId);return {id:canvasId,version:1};
}
export function updateCanvas(db,ctx,canvasId,{version,name,layout}={}){
  if(ctx.role==='viewer')throw new InputError('没有修改画布的权限',403);
  const canvas=getCanvas(db,ctx,canvasId);
  if(!Number.isInteger(version)||version!==canvas.version)throw new InputError('画布版本冲突',409);
  if(name!==undefined&&(typeof name!=='string'||!name.trim()||name.length>80))throw new InputError('画布名称无效');
  const updated=layout===undefined?canvas.layout:checkLayout(db,ctx,canvas.sessionId,layout);
  const res=db.prepare('UPDATE analysis_canvases SET name=?,layout_json=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND user_id=? AND version=?').run(name?.trim()||canvas.name,JSON.stringify(updated),canvasId,ctx.tenantId,ctx.userId,version);
  if(res.changes!==1)throw new InputError('画布版本冲突',409);
  audit(db,ctx,'analysis.canvas.update','canvas',canvasId);return {id:canvasId,version:version+1};
}
