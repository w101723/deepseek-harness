import { createHash, randomBytes } from 'node:crypto';
import { InputError, getDataset } from './query.mjs';
import { executeAnyQuery } from './query-external.mjs';
import { audit } from './db.mjs';
import { readableCatalog } from './dataset-policy.mjs';

const digest = token => createHash('sha256').update(token).digest('hex');

/** Per-turn, time-limited, tenant-bound capability tokens for the Harness tool subprocess.
 * The model cannot choose the tenant, source, dataset or user for a tool call.
 * Scopes live in process memory and are revoked even if the model fails.
 */
export function createAgentBridge(db, { drivers, lifetimeMs = 120_000 } = {}) {
  const scopes = new Map();
  function open(ctx, datasetId) {
    const dataset = getDataset(db, ctx, datasetId);
    const token = randomBytes(32).toString('hex');
    const key = digest(token);
    const state = {
      ctx: { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role },
      datasetId: dataset.id,
      deadline: Date.now() + lifetimeMs,
      queries: 0,
      catalogs: 0,
      trace: [],
      last: null,
    };
    scopes.set(key, state);
    return {
      token,
      get trace() { return structuredClone(state.trace); },
      get last() { return state.last && structuredClone(state.last); },
      close() { scopes.delete(key); },
    };
  }
  async function dispatch(token, request) {
    const scope = typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) ? scopes.get(digest(token)) : null;
    if (!scope || Date.now() >= scope.deadline) throw new InputError('无效或已过期的 Agent 能力令牌', 401);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new InputError('工具请求无效');
    const { ctx, datasetId } = scope;
    // Permission revocation must take effect even for an already-open model turn.
    const active=db.prepare('SELECT role FROM memberships WHERE tenant_id=? AND user_id=?').get(ctx.tenantId,ctx.userId);
    if(!active)throw new InputError('当前授权已被撤销',403);
    const currentCtx={...ctx,role:active.role};
    const dataset = getDataset(db, currentCtx, datasetId);
    if (request.action === 'catalog') {
      if (++scope.catalogs > 5) throw new InputError('本轮元数据访问次数已达到限制', 429);
      const external = db.prepare('SELECT definition_json FROM external_dataset_models WHERE dataset_id=?').get(datasetId);
      const allowed=readableCatalog(db,currentCtx,dataset);
      const model = external
        ? JSON.parse(external.definition_json)
        : { dimensions: JSON.parse(dataset.dimensions_json), metrics: Object.fromEntries(JSON.parse(dataset.metrics_json).map(m => [m, { kind: 'builtin' }])) };
      const result = { datasetId, datasetName: dataset.name, dimensions: allowed.dimensions, metrics: Object.fromEntries(Object.entries(model.metrics).filter(([k])=>allowed.metrics.includes(k))), queryLimit: 30 };
      scope.trace.push({ action: 'catalog', datasetId });
      audit(db, ctx, 'agent.catalog', 'dataset', datasetId);
      return result;
    }
    if (request.action === 'query') {
      if (++scope.queries > 8) throw new InputError('本轮查询次数已达到限制', 429);
      const raw = request.spec;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('缺少 QuerySpec');
      // Drop untrusted datasetId/sourceId/userId/tenantId, no free SQL or tool-side credentials.
      const spec = {
        datasetId,
        dimensions: raw.dimensions,
        metrics: raw.metrics,
        filters: raw.filters ?? [],
        limit: Number.isInteger(raw.limit) ? Math.min(raw.limit, 30) : 30,
      };
      const result = await executeAnyQuery(db, currentCtx, spec, { drivers });
      scope.last = { spec, result };
      scope.trace.push({ action: 'query', queryId: result.queryId, datasetId, rowCount: result.count, spec });
      audit(db, ctx, 'agent.query', 'dataset', datasetId);
      // Expose only bounded query evidence. SQL/query source identities never include credentials.
      return { queryId: result.queryId, columns: result.columns, rows: result.rows.slice(0, 30), count: result.count };
    }
    throw new InputError('不支持的 Agent 工具', 404);
  }
  return { open, dispatch };
}

export function isLoopback(remote) {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}
