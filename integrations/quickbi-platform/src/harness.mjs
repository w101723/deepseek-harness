import { resolve } from 'node:path';

// This is an opt-in, isolated narration adapter, not an authorization or SQL engine.
// An LLM never receives credentials or the ability to execute database statements.
export async function narrateWithHarness(question, result, options={}) {
  if (!options.enabled) return null;
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
  const harness = new DeepSeekHarness({
    profile: 'sdk-minimal',
    dshHome: resolve(options.home ?? '.dsh-quickbi-narration'),
  });
  try {
    const facts=JSON.stringify({columns:result.columns,rows:result.rows.slice(0,30),rowCount:result.count});
    const output=await harness.run(`你是 BI 数据解读助手。只能使用以下确定性结果，不能创造数字或外推因果。请用中文给出 2-3 句描述，不要访问文件或工具。\n问题：${question}\n已验证查询结果：${facts}`);
    return output.finalResponse || null;
  } finally { await harness.close(); }
}