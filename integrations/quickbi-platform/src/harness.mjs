import { resolve } from 'node:path';

// Isolated opt-in SDK bridge. Harness never receives DB credentials or direct SQL execution.
async function runHarness(prompt,options={}){
  const {DeepSeekHarness}=await import('@deepseek-ai/dsh-sdk-client');
  const harness=new DeepSeekHarness({profile:'sdk-minimal',dshHome:resolve(options.home??'.dsh-quickbi-analysis')});
  try{return (await harness.run(prompt)).finalResponse||'';}finally{await harness.close();}
}
export async function planWithHarness({question,history,catalog,datasetId},options={}){
  if(!options.enabled)throw new Error('Harness not enabled');
  const text=await runHarness(`你是 BI 查询计划生成器。仅输出原始 JSON 对象，不要使用 Markdown。不得请求工具、访问文件或生成 SQL。\n可用数据集 ID: ${datasetId}\n允许字段和指标：${JSON.stringify(catalog).slice(0,9000)}\n最近对话：${JSON.stringify(history.map(x=>({role:x.role,text:x.text,spec:x.spec}))).slice(0,6000)}\n新问题：${question}\n输出 {"dimensions":["..."],"metrics":["..."],"filters":[],"limit":50}，必须只使用允许的维度/指标。`,options);
  const clean=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(clean);}catch{throw new Error('Harness 未返回可用的结构化 QuerySpec');}
}
export async function narrateWithHarness(question,result,options={}){
  if(!options.enabled)return null;
  const facts=JSON.stringify({columns:result.columns,rows:result.rows.slice(0,30),rowCount:result.count});
  return await runHarness(`你是 BI 数据解读助手。只能使用以下确定性结果，不能创造数字或外推因果。请用中文给出 2-3 句描述，不要调用工具。\n问题：${question}\n已验证查询结果：${facts}`,options);
}
