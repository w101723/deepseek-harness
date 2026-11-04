# Real-driver PostgreSQL and MySQL CI acceptance

This project has two separate test levels:

- `npm test`: offline unit/API tests with injected fake PostgreSQL and MySQL drivers; run on every change.
- `npm run test:integration`: **real** PostgreSQL 16 and MySQL 8.4 servers, actual `pg`/`mysql2` drivers, database accounts restricted to `SELECT`, metadata discovery, typed query execution, safe parameters, AIPro sessions and saved artifacts. CI job `live-postgres-mysql` provisions disposable GitHub Actions service containers.

The integration suite refuses to start when either `QBI_LIVE_PG_PASSWORD` or `QBI_LIVE_MYSQL_ROOT_PASSWORD` is missing, rather than pretending to verify absent databases. It provisions its own `quickbi_reader` account and an `orders` fixture from the CI administrator accounts, and then tests **application requests as the read-only user**. The test also tries an `INSERT` through the real connector and asserts it fails and data remains unchanged.

## Reproduce locally

Provision empty `quickbi_ci` databases on local PostgreSQL 16 (port 5432) and MySQL 8.4 (port 3306), make sure the disposable admin accounts are permitted to create a table and user, install the project optional `pg` and `mysql2` drivers, then:

```bash
QBI_LIVE_PG_PASSWORD='local-pg-admin-password' \
QBI_LIVE_MYSQL_ROOT_PASSWORD='local-mysql-admin-password' \
npm run test:integration
```

The script binds the application server to `127.0.0.1` and sets its ephemeral `DATASOURCE_MASTER_KEY` and `DATASOURCE_ALLOWED_HOSTS` for the test run. It does not use or print real production secrets. **Do not run against a production database**: the suite creates a role/table and truncates a `quickbi_ci_orders` test table.

## Precise coverage boundaries

This is real-database integration testing for **PostgreSQL and MySQL only**. TiDB and StarRocks use the MySQL protocol but still require independent compatibility runs on those actual servers. The test uses the deterministic AIPro fallback to validate session/artifact persistence; it does not invoke a real DeepSeek model or prove the Harness Agent path works. The CI services use plaintext loopback connections; production TLS certificate/hostname and security policy verification remains a separate gate.