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

## Phase 1 capabilities implemented

- Account sign-in, tenant-scoped workspaces, admin/editor/viewer basic policy, HTTP-only session cookie, CSRF and audit trail.
- PostgreSQL and MySQL protocol adapters, including TiDB and StarRocks through MySQL-compatible protocol (server compatibility requires live verification).
- Encryption-at-rest for DB credentials (AES-256-GCM), exact hostname allowlist, validation of DB/table/column identifiers, backend connection test, Schema and column discovery, limited preview.
- Dataset creation from discovered tables; dimensions and numeric `SUM` / `COUNT` metrics; one shared typed `QuerySpec` compiler for demo or real connections. Parameters are bound; no arbitrary SQL is accepted through the API.
- AIPro sessions, persisted multi-turn history and query evidence; optional native Harness `bi_catalog` / `bi_query` tool path (requires SDK/model runtime validation) with an ephemeral scoped bearer and server-enforced query limits. Previous JSON-planner and deterministic fallback remain available, explicitly marked as previews.
- AIPro topics (draft + publish), analysis artifacts (rename/chart-style edits with version checks), versioned canvas layout with drag/resize/zoom and vertical scrolling. This is not the full multi-user infinite canvas/collaboration experience.
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

Non-GET JSON APIs require the CSRF token from `/api/me`. IDs are checked against the authenticated tenant and, for AIPro, creator user. **External DB access currently requires editor or admin, not viewer**: full dataset/column/row ACL is still pending.

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
