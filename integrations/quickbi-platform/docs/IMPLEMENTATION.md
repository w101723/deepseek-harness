# Phase 1 engineering progress · 2026-11-04

## Verified locally (Node 22.16, `npm test`)

- 18 automated test cases pass; includes original demo login/workspace/query/dashboard safety tests.
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
- Multi-user asset-level ACL and row/column policies, SSO, secure production infrastructure and database connection pooling.
- Native Harness `bi_catalog` and `bi_query` Cordis tool plugin + scoped loopback bridge added and locally tested with an injected fake Agent. Actual SDK/plugin/model end-to-end integration has **not** been verified; full Skill/MCP/complex multi-agent planning remains.
- Basic canvas drag/resize/zoom + editable artifact metadata added; multi-user collaboration, full infinite canvas UX, sophisticated charts, enterprise gallery and report generation remain.
- Phase 2 full dashboard designer: existing demonstration dashboard is not complete.

## Design note

Tenant isolation for external sources is metadata/source-ownership isolation. Unlike the built-in demo SQL, an external table **does not automatically contain tenant_id**. For this reason, current external SQL is limited to editor/admin and any required row-level restrictions must be enforced via restricted database users/views until full dataset-policy implementation lands.

## Batch 03 native-tool development

- Added `harness/bi-tool.mjs` based on the upstream `@deepseek-ai/dsh-tools` `defineTool` API, and a per-request SDK profile overlay that disables Shell / file tools.
- Added `src/agent-bridge.mjs` with loopback-only scoped capabilities: tenant+user+dataset immutable, 120s TTL, 8 query cap, 5 catalog cap, immediate revocation.
- The model cannot pass another dataset ID, tenant ID, free SQL or credentials to the tool. Queries run through the same validated `QuerySpec` compiler and existing role checks.
- Added native Agent mode (`HARNESS_AGENT_MODE=native`) to the `/api/ai/sessions/:id/ask` path; persists query evidence and the tool trace. It fails closed if no `bi_query` executes.
- MySQL now uses `mysql2.execute()` server-side prepared statements rather than `.query()` client interpolation; fake driver tests updated accordingly.
- Added artifact name/chart edit PATCH endpoint with optimistic versioning and a drag/resize/zoom canvas UI, with server-side layout bounds.
- New negative tests check revoked/forged tokens, per-turn query budget, dataset impersonation, evidence immutability and canvas validation.
- **CI and local test cases are not equivalent to real model or database integration tests.**
