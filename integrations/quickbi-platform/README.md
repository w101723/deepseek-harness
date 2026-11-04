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
- AIPro session creation, persisted multi-turn history, query evidence, optional Harness-driven JSON query planning and narration (model/SDK must be configured); deterministic fallback explicitly labelled as a preview.
- AIPro topics (draft + publish), analysis artifacts and versioned canvas layout. Canvas UI supports adding and removing saved analysis artifacts; full interactive/infinite canvas experience is not yet delivered.
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
| GET | `/api/ai/artifacts/:id` | Retrieve saved artwork and query evidence |
| GET/POST | `/api/ai/canvases` | List/create persistent analysis canvas |
| GET/PATCH | `/api/ai/canvases/:id` | Read/edit with version conflict checking |

Non-GET JSON APIs require the CSRF token from `/api/me`. IDs are checked against the authenticated tenant and, for AIPro, creator user. **External DB access currently requires editor or admin, not viewer**: full dataset/column/row ACL is still pending.

## Safety and outstanding work

This is an engineering preview, **not production ready**. External connectors need actual database integration tests, TLS/cert testing, network protections and per-tenant query quotas. The external read-only account is essential; connection test alone cannot enforce read-only privileges. AIPro Harness SDK integration is optional; native model-side `bi_query` plugin/tool, richer agent plans, full canvas controls and business knowledge approval workflow remain. No license to copy proprietary Quick BI UI assets or internal code is implied.

For the current two-phase plan see [docs/PHASE_SCOPE.md](docs/PHASE_SCOPE.md). For exact status see [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).
