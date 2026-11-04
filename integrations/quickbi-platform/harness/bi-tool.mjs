/** Native DeepSeek Harness Cordis tool plugin, loaded only in the dedicated AIPro SDK profile.
 * The scoped bearer is supplied as private plugin config, never a model tool parameter.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'quickbi-scoped-tools';
export const inject = ['tools'];

export function apply(ctx, config) {
  if (!config || !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.apiBaseUrl ?? '') || !/^[a-f0-9]{64}$/.test(config.token ?? '')) {
    throw new Error('BI tool requires a scoped loopback bridge and a private token');
  }
  const request = async (action, spec, signal) => {
    const response = await fetch(`${config.apiBaseUrl}/api/internal/agent-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ action, ...(spec === undefined ? {} : { spec }) }),
      signal,
    });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'BI query denied');
    return JSON.stringify(body);
  };
  ctx.tools.register(defineTool({
    name: 'bi_catalog',
    description: 'Read the dimension and metric catalog for this user-authorized analysis dataset. Call this before querying.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) { return request('catalog', undefined, exec.signal); },
  }));
  ctx.tools.register(defineTool({
    name: 'bi_query',
    description: 'Run a bounded read-only analytical query for the current authorized dataset; identifiers must come from bi_catalog. There is no arbitrary SQL capability.',
    parameters: {
      dimensions: { type: 'array', items: { type: 'string' }, required: true, description: 'Group-by dimension names, 0-3 items' },
      metrics: { type: 'array', items: { type: 'string' }, required: true, description: 'At least one aggregation metric name' },
      filters: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        field: { type: 'string', required: true },
        op: { type: 'string', required: true, enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] },
        value: { oneOf: [{ type: 'string' }, { type: 'number' }], required: true },
      } }, description: 'Optional filters; max 8' },
      limit: { type: 'integer', description: 'Row limit, max 30' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) { return request('query', args, exec.signal); },
  }));
}
