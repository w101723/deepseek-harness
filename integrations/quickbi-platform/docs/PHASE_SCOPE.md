# Scope baseline: AIPro first, dashboards second; no ETL

## Phase 1 (active)
Real PostgreSQL/MySQL/TiDB/StarRocks data connection → schema discovery → semantic dataset → validated QuerySpec → AIPro session and questions → saved chart artifact → reusable canvas/topic. Tenant-scoped authentication, audit, data-access controls and test evidence are required. The AI layer must ultimately use proper Harness Agent tools; the current JSON-planner bridge is an intermediate stage.

## Phase 2 (deferred)
Full dashboard/chart design: drag/drop, cross-filter and drilling, chart styling, publish and share. Reuse the Phase 1 dataset, QuerySpec and artifacts. The existing dashboard page is a working **prototype only**.

## Excluded
All ETL/data cleaning/transformation/synchronization/extraction acceleration; traditional spreadsheet, data screen, portal, data entry, and unrestricted enterprise market modules. Previous 343-feature full-product matrix is reference material rather than implementation acceptance scope.

## Remaining Phase 1 milestones
1. Real source integration tests and credential/TLS deployment checks.
2. Business metric governance and row/column-scoped ACL.
3. Harness native BI tool contract and multi-step planning with trace evidence.
4. Canvas interactivity, saved analysis artifact editing, scheduled analysis.
5. Actual enterprise data end-to-end acceptance with errors, security and resource limits.
