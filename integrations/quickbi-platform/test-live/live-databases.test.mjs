/**
 * Real-driver API integration tests for ephemeral PostgreSQL and MySQL.
 * Unlike mock-driven `npm test`, this suite MUST connect to real databases.
 * The CI job supplies two disposable service containers and bootstrap credentials.
 * No network targets or credentials are stored in the repository.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/db.mjs';
import { connectionFor, withConnection } from '../src/connectors.mjs';

const required = ['QBI_LIVE_PG_PASSWORD', 'QBI_LIVE_MYSQL_ROOT_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key}: this suite requires live CI database services`);
}
const pgPassword = process.env.QBI_LIVE_PG_PASSWORD;
const mysqlRootPassword = process.env.QBI_LIVE_MYSQL_ROOT_PASSWORD;
const readPassword = 'ci-read-only-password'; // Disposable in GitHub Actions only.
const old = Object.fromEntries(['DATASOURCE_MASTER_KEY', 'DATASOURCE_ALLOWED_HOSTS'].map(k => [k, process.env[k]]));
process.env.DATASOURCE_MASTER_KEY = randomBytes(32).toString('hex');
process.env.DATASOURCE_ALLOWED_HOSTS = '127.0.0.1';

const pgModule = await import('pg');
const mysqlModule = await import('mysql2/promise');
const PgClient = pgModule.default.Client;
const mysql = mysqlModule.default;
const pgAdmin = new PgClient({host: '127.0.0.1', port: 5432, user: 'postgres', password: pgPassword, database: 'quickbi_ci', connectionTimeoutMillis: 6000});
let mysqlAdmin;
let app;
let base;

// Always clean up database processes and restore the caller's test environment.
after(async () => {
  if (app) await new Promise(resolve => app.server.close(resolve));
  if (mysqlAdmin) await mysqlAdmin.end();
  await pgAdmin.end().catch(() => {});
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function setupFixtures() {
  await pgAdmin.connect();
  await pgAdmin.query(`CREATE TABLE IF NOT EXISTS public.quickbi_ci_orders (
    region TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, quantity INTEGER NOT NULL
  )`);
  await pgAdmin.query('TRUNCATE TABLE public.quickbi_ci_orders');
  await pgAdmin.query(`INSERT INTO public.quickbi_ci_orders(region,amount,quantity)
    VALUES ('east',100.25,1),('east',200.75,2),('west',50.00,3)`);
  await pgAdmin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='quickbi_reader') THEN
      CREATE ROLE quickbi_reader LOGIN PASSWORD '${readPassword}';
    END IF;
  END $$`);
  await pgAdmin.query('GRANT CONNECT ON DATABASE quickbi_ci TO quickbi_reader');
  await pgAdmin.query('GRANT USAGE ON SCHEMA public TO quickbi_reader');
  await pgAdmin.query('GRANT SELECT ON TABLE public.quickbi_ci_orders TO quickbi_reader');

  mysqlAdmin = await mysql.createConnection({host: '127.0.0.1', port: 3306, user: 'root', password: mysqlRootPassword, database: 'quickbi_ci', connectTimeout: 6000});
  await mysqlAdmin.execute(`CREATE TABLE IF NOT EXISTS quickbi_ci_orders (
    region VARCHAR(40) NOT NULL, amount DECIMAL(12,2) NOT NULL, quantity INT NOT NULL
  )`);
  await mysqlAdmin.execute('TRUNCATE TABLE quickbi_ci_orders');
  await mysqlAdmin.execute(`INSERT INTO quickbi_ci_orders(region,amount,quantity)
    VALUES ('east',100.25,1),('east',200.75,2),('west',50.00,3)`);
  // This static credential exists only inside disposable CI containers.
  await mysqlAdmin.query(`CREATE USER IF NOT EXISTS 'quickbi_reader'@'%' IDENTIFIED BY '${readPassword}'`);
  await mysqlAdmin.query('GRANT SELECT ON quickbi_ci.quickbi_ci_orders TO \'quickbi_reader\'@\'%\'');
}

function apiClient() {
  let cookie, csrf;
  return {
    async request(path, method = 'GET', body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : {'content-type': 'application/json'}),
          ...(cookie ? {cookie, 'x-csrf-token': csrf} : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      const issued = response.headers.get('set-cookie');
      if (issued?.startsWith('session=')) cookie = issued.split(';')[0];
      if (data.user?.csrf) csrf = data.user.csrf;
      return {status: response.status, data};
    },
    async login(email = 'admin@demo.local', password = 'DemoOnly!2026') {
      const r = await this.request('/api/login', 'POST', {email, password});
      assert.equal(r.status, 200, `Login: ${JSON.stringify(r.data)}`);
      return r;
    },
  };
}

await setupFixtures();
app = createApp({demoMode: true});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${app.server.address().port}`;

test('real PostgreSQL/MySQL drivers: dataset → QuerySpec → AIPro → artifact and denied writes', async t => {
  const c = apiClient();
  await c.login();
  const work = (await c.request('/api/workspaces')).data.items[0];
  assert.ok(work?.id, 'Demo workspace must exist');

  for (const item of [
    {kind: 'postgres', database: 'quickbi_ci', schema: 'public', port: 5432},
    {kind: 'mysql', database: 'quickbi_ci', schema: 'quickbi_ci', port: 3306},
  ]) {
    await t.test(`${item.kind}: real connection, metadata, typed SQL, read-only account and saved analysis`, async () => {
      const create = await c.request('/api/datasources', 'POST', {
        name: `CI ${item.kind}`, workspaceId: work.id, kind: item.kind,
        host: '127.0.0.1', port: item.port, database: item.database,
        user: 'quickbi_reader', password: readPassword, ssl: false,
      });
      assert.equal(create.status, 201, `Create ${item.kind} source: ${JSON.stringify(create.data)}`);
      const sourceId = create.data.id;
      const stored = app.db.prepare('SELECT * FROM datasources WHERE id=?').get(sourceId);
      assert.ok(stored.connection_json, 'Credential must be encrypted at rest');
      assert.ok(!stored.connection_json.includes(readPassword), 'Password must not be stored in cleartext');
      const list = await c.request('/api/datasources');
      assert.ok(!JSON.stringify(list.data).includes(readPassword), 'Credential must not reach browser');

      const conn = await c.request(`/api/datasources/${sourceId}/test`);
      assert.equal(conn.status, 200);
      assert.equal(conn.data.ok, true);
      const catalog = await c.request(`/api/datasources/${sourceId}/schema`);
      assert.equal(catalog.status, 200, JSON.stringify(catalog.data));
      const table = catalog.data.tables.find(x => x.schema === item.schema && x.name === 'quickbi_ci_orders');
      assert.ok(table, `Expected ${item.schema}.quickbi_ci_orders in ${item.kind} metadata: ${JSON.stringify(catalog.data).slice(0,2500)}`);
      assert.ok(table.fields.includes('amount'));
      const preview = await c.request(`/api/datasources/${sourceId}/preview`);
      assert.equal(preview.status, 200);
      assert.equal(preview.data.rows.length, 3);
      // Real PostgreSQL/MySQL checks for the source table browser and SQL datasets.
      const indexed=await c.request(`/api/assets/sources/${sourceId}/tables?page=1&pageSize=15&q=quickbi_ci_orders`);
      assert.equal(indexed.status,200,JSON.stringify(indexed.data));
      assert.ok(indexed.data.items.some(x=>x.schema===item.schema&&x.name==='quickbi_ci_orders'));
      const sample=await c.request(`/api/assets/sources/${sourceId}/preview?schema=${item.schema}&table=quickbi_ci_orders`);
      assert.equal(sample.status,200,JSON.stringify(sample.data));
      assert.equal(sample.data.rows.length,3);
      const sqlDataset=await c.request('/api/assets/datasets/sql','POST',{datasourceId:sourceId,name:'SQL dataset '+item.kind,sql:`SELECT region, amount FROM ${item.schema}.quickbi_ci_orders`});
      assert.equal(sqlDataset.status,201,JSON.stringify(sqlDataset.data));
      const result=await c.request('/api/query','POST',{datasetId:sqlDataset.data.id,dimensions:['region'],metrics:['sum_amount'],filters:[{field:'region',op:'eq',value:'east'}],limit:10});
      assert.equal(result.status,200,JSON.stringify(result.data));
      assert.equal(Number(result.data.rows[0].sum_amount),301);
      assert.equal((await c.request('/api/assets/datasets/sql','POST',{datasourceId:sourceId,name:'invalid',sql:`SELECT * FROM ${item.schema}.quickbi_ci_orders`})).status,400);

      const dataset = await c.request('/api/datasets', 'POST', {
        name: `Orders ${item.kind}`, datasourceId: sourceId,
        schema: item.schema, table: 'quickbi_ci_orders',
      });
      assert.equal(dataset.status, 201, JSON.stringify(dataset.data));
      const datasetId = dataset.data.id;
      const spec = {datasetId, dimensions: ['region'], metrics: ['sum_amount', 'rows'], filters: [{field: 'region', op: 'eq', value: 'east'}], limit: 10};
      const query = await c.request('/api/query', 'POST', spec);
      assert.equal(query.status, 200, JSON.stringify(query.data));
      assert.equal(query.data.rows.length, 1);
      assert.equal(query.data.rows[0].region, 'east');
      assert.equal(Number(query.data.rows[0].sum_amount), 301);
      assert.equal(Number(query.data.rows[0].rows), 2);
      assert.ok(query.data.sql.startsWith('SELECT '));
      assert.ok(query.data.sql.includes(item.kind === 'postgres' ? '$1' : '?'));

      const injected = await c.request('/api/query', 'POST', {
        ...spec, filters: [{field: 'region', op: 'eq', value: "east' OR 1=1 --"}],
      });
      assert.equal(injected.status, 200);
      assert.equal(injected.data.rows.length, 0, 'Filter must bind its value');
      assert.equal((await c.request('/api/query', 'POST', {...spec, metrics: ['delete_me']})).status, 400);

      const session = await c.request('/api/ai/sessions', 'POST', {datasetId, title: `CI ${item.kind} analysis`});
      assert.equal(session.status, 201);
      const analysis = await c.request(`/api/ai/sessions/${session.data.id}/ask`, 'POST', {question: '按照 region 分析 sum_amount'});
      assert.equal(analysis.status, 200, JSON.stringify(analysis.data));
      assert.equal(analysis.data.result.count, 2);
      const saved = await c.request('/api/ai/artifacts', 'POST', {sessionId: session.data.id, name: `${item.kind} verified result`});
      assert.equal(saved.status, 201);
      const replay = await c.request(`/api/ai/artifacts/${saved.data.id}`);
      assert.equal(replay.status, 200);
      assert.equal(replay.data.item.content.spec.datasetId, datasetId);

      // These are real DB sessions as the readonly account, not fake driver calls.
      await assert.rejects(
        withConnection(connectionFor(stored), q => q(item.kind === 'postgres'
          ? "INSERT INTO public.quickbi_ci_orders(region,amount,quantity) VALUES ('blocked',1,1)"
          : "INSERT INTO quickbi_ci_orders(region,amount,quantity) VALUES ('blocked',1,1)")),
        'A read-only database account must not be able to write',
      );
      const count = await c.request('/api/query', 'POST', {datasetId, dimensions: [], metrics: ['rows'], limit: 10});
      assert.equal(Number(count.data.rows[0].rows), 3, 'Rejected INSERT must not change source data');

      // Even members of the same tenant cannot inspect an external dataset by default.
      const viewerId = `ci-viewer-${item.kind}`;
      app.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(viewerId, `${viewerId}@demo.local`, hashPassword('AnotherDemoPass!'), 'CI viewer');
      app.db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(work.tenant_id, viewerId, 'viewer');
      const viewer = apiClient();
      await viewer.login(`${viewerId}@demo.local`, 'AnotherDemoPass!');
      const denied = await viewer.request('/api/query', 'POST', spec);
      assert.equal(denied.status, 403);
      assert.equal((await viewer.request(`/api/datasources/${sourceId}/schema`)).status, 403);
    });
  }
});