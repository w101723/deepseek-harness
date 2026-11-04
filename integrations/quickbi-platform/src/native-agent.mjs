import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const pluginFile = resolve(dirname(fileURLToPath(import.meta.url)), '../harness/bi-tool.mjs');

/** Launch an isolated Harness profile exposing only bi_catalog and bi_query.
 * The session's scoped secret is written to mode 0600 and deleted after use.
 * No model-side shell, arbitrary files or database passwords are provided.
 */
export async function runNativeBiAgent({ question, history, topic, url, capability, home }) {
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
  const scratch = await mkdtemp(join(tmpdir(), 'quickbi-agent-'));
  const patch = join(scratch, 'bi-tools.patch.yml');
  // JSON strings are valid YAML scalars; the token is not interpolated into the model prompt.
  const overlay = `- id: persistent-bash\n  disabled: true\n- id: persistent-pwsh\n  disabled: true\n- id: tool-fs\n  disabled: true\n- id: tool-working-directory\n  disabled: true\n- insert:\n    - id: quickbi-bi-tools\n      name: ${JSON.stringify(pluginFile)}\n      config:\n        apiBaseUrl: ${JSON.stringify(url)}\n        token: ${JSON.stringify(capability)}\n`;
  await writeFile(patch, overlay, { mode: 0o600 });
  let harness;
  try {
    harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome: resolve(home ?? '.dsh-quickbi-agent'), patches: [patch], maxTokens: 2048 });
    const recent = history.slice(-8).map(x => ({ role: x.role, text: x.text }));
    const prompt = [
      '你是严谨的商业数据分析师。必须先调用 bi_catalog，然后根据问题调用 bi_query 得到真实数据。可进行多次有针对性的查询。',
      '不允许虚构数字，结论必须明确说明观察结果与因果解释的区别；如果缺少证据，必须承认。',
      '不能调用 shell/文件工具，不能请求任何凭据。模型只能依据工具返回的聚合数据回答。',
      `主题说明：${String(topic ?? '').slice(0,1500)}`,
      `最近对话：${JSON.stringify(recent).slice(0,4000)}`,
      `当前问题：${question}`,
    ].join('\n');
    const response = await harness.run(prompt);
    if (response.finishReason === 'error') throw new Error('Harness Agent 回合执行失败');
    return response.finalResponse;
  } finally {
    try { if (harness) await harness.close(); } finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
