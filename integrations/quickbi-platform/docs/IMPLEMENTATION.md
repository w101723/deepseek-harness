# Phase 1 engineering progress · 2026-11-04

## Verified locally (Node 22.16, `npm test`)

- 27 automated test cases pass (including role-scoped access and safe export tests); includes original demo login/workspace/query/dashboard safety tests.
- New API integration tests use **injected fake PostgreSQL/MySQL drivers**, covering connection test, metadata, preview, dataset, SQL binding, session continuity, topic publishing, canvas version conflict, cross-tenant rejection and credential encryption.
- Old `datasources` schema migrates to the expanded multi-engine table, retaining existing datasets.
- Browser application includes actual source connection form, dataset table selection, AIPro session, saved artifacts, topics and canvas layout view.

## Implemented, but awaiting verification in an actual database environment

- `pg` adapter for PostgreSQL, and `mysql2` adapter for MySQL/TiDB/StarRocks compatibility.
- Read-only semantic query compiler and database SQL dialect support.
- Optional DeepSeek Harness planning/narration SDK path. The existing tests inject a fake planner, **not** a real DeepSeek model or native agent tool.

## Out of scope / still pending

- **ETL removed entirely** (no data movement, transformations, sync or materialization).
- External connection live smoke against real MySQL, PostgreSQL, TiDB, StarRocks; TLS validation; TLS defaults need deployment hardening.
- Per-user/group resource ACL, inherited policies, SSO, secure production infrastructure and database connection pooling. **Role-scoped dataset dimension/metric allowlists and mandatory row predicates are now implemented and tested**, but not production-hardened.
- Native Harness `bi_catalog` and `bi_query` Cordis tool plugin + scoped loopback bridge added and locally tested with an injected fake Agent. Actual SDK/plugin/model end-to-end integration has **not** been verified; full Skill/MCP/complex multi-agent planning remains.
- Basic canvas drag/resize/zoom + editable artifact metadata added; multi-user collaboration, full infinite canvas UX, sophisticated charts, enterprise gallery and report generation remain.
- Phase 2 full dashboard designer: existing demonstration dashboard is not complete.

## Design note

Tenant isolation for external sources is metadata/source-ownership isolation. Unlike the built-in demo SQL, an external table **does not automatically contain tenant_id**. External SQL is denied to viewers by default and can be enabled with an explicit per-role dataset policy. These policies enforce parameterized mandatory row predicates, and dimension/metric allowlists; the configured external database account must still be read-only. See [DATA_POLICIES.md](DATA_POLICIES.md).

## Batch 03 native-tool development

- Added `harness/bi-tool.mjs` based on the upstream `@deepseek-ai/dsh-tools` `defineTool` API, and a per-request SDK profile overlay that disables Shell / file tools.
- Added `src/agent-bridge.mjs` with loopback-only scoped capabilities: tenant+user+dataset immutable, 120s TTL, 8 query cap, 5 catalog cap, immediate revocation.
- The model cannot pass another dataset ID, tenant ID, free SQL or credentials to the tool. Queries run through the same validated `QuerySpec` compiler and existing role checks.
- Added native Agent mode (`HARNESS_AGENT_MODE=native`) to the `/api/ai/sessions/:id/ask` path; persists query evidence and the tool trace. It fails closed if no `bi_query` executes.
- MySQL now uses `mysql2.execute()` server-side prepared statements rather than `.query()` client interpolation; fake driver tests updated accordingly.
- Added artifact name/chart edit PATCH endpoint with optimistic versioning and a drag/resize/zoom canvas UI, with server-side layout bounds.
- New negative tests check revoked/forged tokens, per-turn query budget, dataset impersonation, evidence immutability and canvas validation.
- **CI and local test cases are not equivalent to real model or database integration tests.**

## Batch 04: role-scoped dataset access + history safety

- Role-level dataset policies (`viewer`/`editor`/`admin`) and admin-only GET/PATCH endpoints, including optimistic versioning and committed audit+revision updates.
- Mandatory AND-combined SQL row predicates and dimension/metric allowlists apply to demo SQL, external adapters, and native Harness bi_catalog/bi_query calls.
- Viewer external database access is denied until granted. Viewer metadata/source lists are filtered. Query history is user-scoped.
- Historical AIPro query evidence and artifacts are hidden when dataset policy revision or creator's role differs from when the results were generated.
- Data policy editor on datasets; optional `npm run test:live` connector smoke runner uses *real* provided DB credentials and hides them from logs.
- Local 25/25 tests pass, including policy propagation, viewer grant/revoke, query injection attempts, stale artifact invalidation and creator role downgrade.
- No real database or DeepSeek model endpoint is available inside these tests. Live smoke and native model end-to-end remain **unverified**.

## Batch 05: reports and portable exports

- Saved analysis artifacts now support `report` as well as chart/table works.
- Authorized `GET /api/ai/artifacts/:id/export?format=csv|md|json` produces attachments from previously verified query results, not a fresh SQL query.
- CSV formula-prefix neutralization, JSON snapshot, readable Markdown report and policy-aware download authorization implemented.
- Browser UI exposes type selection and download actions; 27/27 local tests pass. **Live database/model E2E remains outstanding**.

## Batch 06 · AIPro scheduled analysis

- Added `src/scheduler.mjs` with persistent recurring read-only queries, UTC-based scheduling, limited history, manual execution, optimistic updates, task lease and current-role/policy revalidation.
- Added Web UI for creating, manually running, pausing, resuming and inspecting recurring tasks.
- Added automated tests: scheduled query contracts, policy invalidation, concurrency lease and restart recovery.
- **No ETL/data movement**; no external delivery, distributed scheduler, retry guarantees or live DB smoke proof.

## Batch 07: AIPro knowledge topics (2026-11-04)

- Added per-topic business glossary/rules/examples with owner-only editing, 20-item limit, audit log and versioned REST APIs.
- Published topics become drafts after edits; analysis sessions pin the topic version, so edits cannot silently alter an active session.
- Business notes are supplied to model planning as bounded untrusted context, while all QuerySpec and data authorization remain server-controlled.
- A frontend editor manages topic instructions and knowledge; tests cover access isolation, stale versions, publish/republish and model context forwarding.
- This is an application feature implementation and does **not** establish real-model or external-database end-to-end acceptance.
