# Phase 1 engineering progress · 2026-11-04

## Verified locally (Node 22.16, `npm test`)

- 15 automated test cases pass; includes original demo login/workspace/query/dashboard safety tests.
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
- Native Harness `bi_query` Tool/Skill/MCP runtime + validated iterative multi-tool planning (currently SDK JSON planning + deterministic query execution).
- Full AIPro unlimited canvas UX, sophisticated charts and interactivity, enterprise gallery and report generation.
- Phase 2 full dashboard designer: existing demonstration dashboard is not complete.

## Design note

Tenant isolation for external sources is metadata/source-ownership isolation. Unlike the built-in demo SQL, an external table **does not automatically contain tenant_id**. For this reason, current external SQL is limited to editor/admin and any required row-level restrictions must be enforced via restricted database users/views until full dataset-policy implementation lands.
