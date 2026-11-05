# Insight BI — Phase 1: AIPro + Live Data Access

Standalone BI business application in `integrations/quickbi-platform` inside the user-owned DeepSeek Harness fork. **Not** an Alibaba Quick BI product. The current implementation prioritizes live database access and AIPro, with dashboards explicitly deferred to Phase 2; **there is no ETL**.

## Running

Node.js 22.14+ (built-in `node:sqlite` is experimental on Node 22), npm. In this directory:

```bash
npm install
# Local-only demo, no external database needed
DEMO_MODE=1 npm start
# http://127.0.0.1:3088  admin@demo.local / DemoOnly!2026
npm test
```

For a real environment:

```bash
export BOOTSTRAP_EMAIL='admin@example.org'
export BOOTSTRAP_PASSWORD='a-unique-very-long-password'
export DATASOURCE_MASTER_KEY="$(openssl rand -hex 32)"
export DATASOURCE_ALLOWED_HOSTS='db.example.internal,10.0.0.12'
export DB_PATH='./data/quickbi.sqlite'
# No DEMO_MODE; don't expose the unreviewed developer preview to the public internet
npm start
```

Preserve `DATASOURCE_MASTER_KEY` safely, otherwise stored external credentials cannot be decrypted. Node imports `pg` for PostgreSQL and `mysql2` for MySQL/TiDB/StarRocks. Drivers are optional to allow a local demo when offline; ensure the relevant driver was installed before connecting a real source.

## Phase 1 capabilities implemented (developer preview)

- Account sign-in, tenant-scoped workspaces, admin/editor/viewer basic policy, HTTP-only session cookie, CSRF and audit trail.
- PostgreSQL and MySQL protocol adapters, including TiDB and StarRocks through MySQL-compatible protocol (server compatibility requires live verification).
- Encryption-at-rest for DB credentials (AES-256-GCM), exact hostname allowlist, validation of DB/table/column identifiers, backend connection test, Schema and column discovery, limited preview.
- Dataset creation from discovered tables; dimensions and numeric `SUM` / `COUNT` metrics; one shared typed `QuerySpec` compiler for demo or real connections. Parameters are bound; no arbitrary SQL is accepted through the API.
- AIPro sessions, persisted multi-turn history and query evidence; optional native Harness `bi_catalog` / `bi_query` tool path (requires SDK/model runtime validation) with an ephemeral scoped bearer and server-enforced query limits. Previous JSON-planner and deterministic fallback remain available, explicitly marked as previews.
- AIPro topics (draft + publish), analysis artifacts (rename/chart-style edits with version checks), versioned canvas layout with drag/resize/zoom and vertical scrolling. This is not the full multi-user infinite canvas/collaboration experience.
- Admin-managed role dataset policies: dimension and metric allowlists, mandatory bound row predicates, history invalidation on policy changes, and a policy editor.
- Saved chart and report artifacts can be downloaded as CSV, Markdown or JSON (no extra model call on export); downloads check current authorization and dataset policy revision.
- Existing dashboard editor remains a Phase 2 prototype, not a finished deliverable.

## Open API routes

Existing: `/api/login`, `/api/me`, `/api/workspaces`, `/api/datasources`, `/api/datasets`, `/api/query`, `/api/dashboards`, `/api/audit`.

New:

| Method | Route | Description |
|---|---|---|
| GET/POST | `/api/datasources` | List without credentials / create and verify a real connection |
| GET | `/api/datasources/:id/test` | Authenticated, editor-only external connection test |
| GET | `/api/datasources/:id/schema` | Discover actual table/column metadata |
| GET | `/api/datasources/:id/preview` | Bounded preview (external sources: editor-only) |
| GET/POST | `/api/ai/sessions` | My sessions / create session tied to dataset and optional topic |
| GET | `/api/ai/sessions/:id` | Session and saved turns |
| POST | `/api/ai/sessions/:id/ask` | Validated planned `QuerySpec`, execution, saved assistant output |
| GET/POST | `/api/ai/topics` | List or create topic draft |
| POST | `/api/ai/topics/:id/publish` | Publish with optimistic version check |
| GET/POST | `/api/ai/artifacts` | List/create analysis artwork from the last successful turn |
| GET/PATCH | `/api/ai/artifacts/:id` | Retrieve artwork or change its name/chart style (query evidence cannot be edited) |
| GET/POST | `/api/ai/canvases` | List/create persistent analysis canvas |
| GET/PATCH | `/api/ai/canvases/:id` | Read/edit with version conflict checking |

Non-GET JSON APIs require the CSRF token from `/api/me`. IDs are checked against the authenticated tenant and, for AIPro, creator user. **External DB access currently requires editor or admin, not viewer**: role-scoped dataset/row/column enforcement now exists but per-user/group ACL and production governance remain pending.

## Safety and outstanding work

This is an engineering preview, **not production ready**. External connectors need actual database integration tests, TLS/cert testing, network protections and per-tenant query quotas. The external read-only account is essential; connection test alone cannot enforce read-only privileges. AIPro native Harness tool integration is implemented but has not been validated against a configured live DeepSeek model/runtime. Richer multi-agent plans, advanced interactive charting, shared canvas collaboration and business knowledge approval workflow remain. No license to copy proprietary Quick BI UI assets or internal code is implied.

For the current two-phase plan see [docs/PHASE_SCOPE.md](docs/PHASE_SCOPE.md). For exact status see [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Native Harness BI Tool integration (experimental)

By default, no model is invoked. To enable real native tool calls, install compatible
`@deepseek-ai/dsh-sdk-client` and `@deepseek-ai/dsh-tools` packages and configure
`DEEPSEEK_API_KEY` for the selected SDK profile:

```bash
export HARNESS_AGENT_MODE=native
export DEEPSEEK_API_KEY='...'
export HARNESS_HOME="$(pwd)/data/harness"
npm start
```

The host application starts an SDK worker with a one-use patch that disables
Shell, file and working-directory tools, and loads `harness/bi-tool.mjs`. The
model sees only `bi_catalog` and `bi_query` (plus any unmodified SDK profile
system facilities), never the database connection string. Each analysis turn
uses a fresh 256-bit authorization token bound server-side to the active
user/tenant/dataset, expires after 120 seconds, permits 8 queries and 5 catalog
calls, and is revoked on completion. The loopback-only API
`POST /api/internal/agent-tool` requires this token and cannot be called with a
browser session cookie. Tool traces are saved alongside the verified result.

**Limits:** The 120-second window is a tool-access deadline, not a model-process
wall-clock deadline; multi-tenant worker isolation and comprehensive tool
restriction still require integration testing. No actual production DB or
DeepSeek API connection was available in the automated tests. SDK execution is
not production hardened. Do not expose this preview on a public network.

## Role-level dataset policy and live smoke

The administrator can use **数据权限** on a dataset to grant a viewer access to a real source, restrict fields/metrics and enforce AND-combined row filters. The policy is validated and bound to every SQL request (including model tools); an authorization change hides old AI evidence. See [docs/DATA_POLICIES.md](docs/DATA_POLICIES.md).

To exercise **real** source drivers rather than test fakes, set the encryption key and exact allowed hostnames, then run the opt-in smoke script with an explicit JSON array of read-only DB configs. Do not put passwords in shell history or commit credentials; use a protected environment/secrets provider.

```bash
# Provide QUICKBI_SMOKE_SOURCES through your environment or secret manager
npm run test:live
```

Without real DB credentials this command intentionally fails. It verifies connect, Schema discovery and bounded preview; this is not a substitute for TLS/permissions/throughput/security acceptance.

## Exporting AIPro works

Save an AIPro analysis as **图表作品** or **分析报告**, open the saved work and choose CSV, Markdown or JSON. The API is `GET /api/ai/artifacts/:id/export?format=csv|md|json`. Exports are generated only from persisted, already-authorized evidence; CSV cells with spreadsheet-formula prefixes are neutralized, responses are attachments with `no-store`, and the authorization check runs before streaming any bytes. Any dataset-policy revision or creator-role change invalidates old report downloads.

## 定时分析（一期）

`/api/ai/schedules` 提供持久化定时分析：复用同一份受控 QuerySpec、数据集权限和行过滤。Web「定时分析」可创建、手动执行、暂停或恢复并查看最近 50 次运行记录。结果最多保存 30 行、100 KB，绝不作为 ETL、数据同步或外部推送渠道。

Node 服务启动后默认每 30 秒检查到期任务；设置 `SCHEDULE_WORKER_ENABLED=0` 禁用。支持 15、30、60、180、360、720、1440、10080 分钟周期。每次执行重新检查发起者角色和策略修订，授权变化后旧结果不可再读取。调度目前是**单实例 SQLite 租约实现**，不提供高可用、漏执行补偿、分布式调度或邮件/IM 推送，**不得直接作为生产级定时任务平台**。

API：`GET/POST /api/ai/schedules`、`GET/PATCH /api/ai/schedules/:id`、`POST /api/ai/schedules/:id/run`、`GET /api/ai/schedules/:id/runs`。

### AIPro business topic knowledge

Theme drafts now support a versioned glossary, business rules, and examples, managed from **分析主题 → 管理知识**. Edits demote published themes to drafts; existing analysis sessions are pinned to their original topic revision. REST contract and security notes: [docs/TOPIC_KNOWLEDGE.md](docs/TOPIC_KNOWLEDGE.md).

## 数据源与数据集工作台（Batch 09）

已新增数据源左右分栏、真实表服务端分页/指定表预览、数据集文件夹/搜索/筛选/排序/编辑/复制/删除。SQL 创建数据集仅支持 `SELECT col[,col] FROM schema.table` 的受限只读建模，不支持直接执行任意 SQL。API 和边界见 [docs/ASSET_WORKBENCH.md](docs/ASSET_WORKBENCH.md)。不包含 ETL。

## SQL 数据集固定过滤条件（开发预览）

数据源管理 → SQL 创建数据集，支持单表投影及 `WHERE`（`AND` 连接，最多 8 个 `=`、`<>`、`>=`、`<=`、`>`、`<` 字符串/数值条件）。例如：

```sql
SELECT amount FROM analytics.orders WHERE region = 'east' AND amount >= 150
```

所有标识符在创建时按真实数据源列校验；SQL 不直接执行。固定 WHERE 被解析成带类型的 `baseFilters` 存入模型，后续普通查询、AIPro、定时任务、看板查询统一应用，值由数据库驱动参数绑定，不能被使用者的额外筛选移除。仅投影字段可作为查询维度或指标，不暴露 WHERE 用到的其他源列。暂不支持 JOIN、OR、CTE、任意函数或多语句。详见 [docs/SQL_DATASETS.md](docs/SQL_DATASETS.md)。
