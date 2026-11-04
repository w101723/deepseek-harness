# Dataset access policies · Phase 1

This is a role-based *dataset* policy, not a completed enterprise IAM/RBAC implementation. It applies to both the built-in demo and live PostgreSQL/MySQL/TiDB/StarRocks semantic queries.

## Policy model

An authenticated administrator can set one policy per dataset and tenant role (`viewer`, `editor`, `admin`). A policy has `canQuery`, optional dimension/metric allowlists, and an administrator-defined list of enforced row filters. `null` allowlists mean all fields, `[]` means none. All required row predicates are AND-combined with user filters in SQL using bound values. The model never receives row SQL or database credentials; it cannot override the enforcement.

**Default:** editors/admins can query tenant-owned datasets; viewers can query the demo dataset but **cannot query live datasets** until explicitly granted access. A role policy supersedes the default. Dataset metadata and data-source listings are filtered for viewers.

## API

Only administrators can access these endpoints (session + CSRF for PATCH):

- `GET /api/datasets/:datasetId/policies`
- `PATCH /api/datasets/:datasetId/policies`

Example JSON:

```json
{
  "role": "viewer",
  "version": 0,
  "canQuery": true,
  "dimensions": ["region"],
  "metrics": ["sum_amount"],
  "rowFilters": [{"field":"region","op":"eq","value":"华东"}]
}
```

`version` is optimistic concurrency control: `0` means no explicit role policy exists. A second update uses the version returned from the preceding update. Invalid fields, unknown metrics, bad operators, untrusted identifiers and cross-tenant targets are rejected before policy storage. Admin can use the **数据权限** button on a dataset to configure role visibility.

## Security behavior

- The policy is re-evaluated for **every** query, including agent tool calls, not only at session creation. Tool calls also verify the caller still has a tenant membership.
- Row filters are compiled as extra bound SQL predicates, so request-side `ne` cannot broaden an administrator-mandated `eq` filter.
- Query history is scoped to its owner. Assistant response evidence and saved artifacts record a dataset-policy revision and role. A role change or any policy update hides prior query evidence rather than serving an old sensitive snapshot.
- Policy mutation, dataset row and global policy revision update are committed atomically; a version mismatch fails with 409.
- Persisted prior evidence is retained in SQLite even when hidden by the API: **data deletion/retention governance is still missing**. File/database backups need equivalent controls.

## Known gaps

No per-user or per-group ACL; no inherited workspace rules; no row filter expressions beyond an AND of supported simple comparisons; no impersonation/identity-provider integration; no cryptographic tamper-proof audit; no enforcement of external database grants beyond the configured DB account. For production, use restricted read-only DB users/views, TLS, network isolation, independent security review, and explicit query quotas. This is a developer preview, not a production-certified authorization engine.
