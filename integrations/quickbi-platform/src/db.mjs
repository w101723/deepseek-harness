import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const id = () => randomUUID();
export const token = () => randomBytes(32).toString('hex');
export const hashToken = value => createHash('sha256').update(value).digest('hex');
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(stored)) return false;
  const [salt, hex] = stored.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hex, 'hex'));
}

export function openDatabase(path = ':memory:', { demoMode = false, bootstrapEmail, bootstrapPassword } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), PRIMARY KEY(tenant_id,user_id), FOREIGN KEY(tenant_id) REFERENCES tenants(id), FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,name));
    CREATE TABLE IF NOT EXISTS datasources(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('demo-sqlite','postgres','mysql','tidb','starrocks')), connection_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(workspace_id) REFERENCES workspaces(id));
    CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, datasource_id TEXT NOT NULL, name TEXT NOT NULL, dimensions_json TEXT NOT NULL, metrics_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(datasource_id) REFERENCES datasources(id));
    CREATE TABLE IF NOT EXISTS dashboards(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, widgets_json TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS query_runs(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, dataset_id TEXT NOT NULL, spec_json TEXT NOT NULL, row_count INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS sales_demo(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, order_date TEXT NOT NULL, region TEXT NOT NULL, category TEXT NOT NULL, channel TEXT NOT NULL, revenue REAL NOT NULL, cost REAL NOT NULL, quantity INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_sales_scope_date ON sales_demo(tenant_id,workspace_id,order_date);
    CREATE INDEX IF NOT EXISTS idx_sources_scope ON datasources(tenant_id,workspace_id);
    CREATE INDEX IF NOT EXISTS idx_datasets_scope ON datasets(tenant_id,workspace_id);
    CREATE INDEX IF NOT EXISTS idx_dashboards_scope ON dashboards(tenant_id,workspace_id);
  `);
  // Migration for the original foundation schema, which only accepted demo-sqlite.
  const columns=db.prepare('PRAGMA table_info(datasources)').all();
  if(!columns.some(c=>c.name==='connection_json')){
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try{
      db.exec(`CREATE TABLE datasources_v2(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('demo-sqlite','postgres','mysql','tidb','starrocks')),connection_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(workspace_id) REFERENCES workspaces(id));
        INSERT INTO datasources_v2(id,tenant_id,workspace_id,name,kind,created_at) SELECT id,tenant_id,workspace_id,name,kind,created_at FROM datasources;
        DROP TABLE datasources;
        ALTER TABLE datasources_v2 RENAME TO datasources;
        CREATE INDEX idx_sources_scope ON datasources(tenant_id,workspace_id);
      `);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}finally{db.exec('PRAGMA foreign_keys=ON');}
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('data source schema migration violated foreign keys');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_dataset_models(dataset_id TEXT PRIMARY KEY, schema_name TEXT NOT NULL,table_name TEXT NOT NULL,definition_json TEXT NOT NULL, FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS analysis_sessions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,dataset_id TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS analysis_messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,tenant_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),text TEXT NOT NULL,spec_json TEXT,result_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(session_id) REFERENCES analysis_sessions(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS analysis_artifacts(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,name TEXT NOT NULL,content_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(session_id) REFERENCES analysis_sessions(id));
    CREATE INDEX IF NOT EXISTS idx_analysis_sessions ON analysis_sessions(tenant_id,user_id,updated_at);
    CREATE INDEX IF NOT EXISTS idx_analysis_messages ON analysis_messages(session_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_analysis_artifacts ON analysis_artifacts(tenant_id,workspace_id);
    CREATE TABLE IF NOT EXISTS analysis_session_topics(session_id TEXT PRIMARY KEY,topic_id TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES analysis_sessions(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS analysis_topics(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,dataset_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),version INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS analysis_canvases(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,name TEXT NOT NULL,layout_json TEXT NOT NULL DEFAULT '[]',version INTEGER NOT NULL DEFAULT 1,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_analysis_topics ON analysis_topics(tenant_id,workspace_id);
    CREATE INDEX IF NOT EXISTS idx_analysis_canvases ON analysis_canvases(tenant_id,user_id);
  `);
  if (db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n === 0) {
    if (!demoMode && !(bootstrapEmail && bootstrapPassword)) return db;
    if (!demoMode && bootstrapPassword.length < 12) throw new Error('BOOTSTRAP_PASSWORD must contain >=12 characters');
    const email = demoMode ? 'admin@demo.local' : bootstrapEmail.toLowerCase();
    const password = demoMode ? 'DemoOnly!2026' : bootstrapPassword;
    const tenantId = id(), workspaceId = id(), sourceId = id(), datasetId = id(), dashboardId = id(), userId = id();
    const secondTenantId = id(), secondWorkspaceId = id();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO tenants VALUES (?,?)').run(tenantId, '演示企业');
      db.prepare('INSERT INTO tenants VALUES (?,?)').run(secondTenantId, '隔离测试企业');
      db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(userId, email, hashPassword(password), '平台管理员');
      db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(tenantId, userId, 'admin');
      // A second tenant is intentionally not granted to the first user.
      db.prepare('INSERT INTO workspaces(id,tenant_id,name) VALUES (?,?,?)').run(workspaceId, tenantId, '销售分析');
      db.prepare('INSERT INTO workspaces(id,tenant_id,name) VALUES (?,?,?)').run(secondWorkspaceId, secondTenantId, '隔离空间');
      db.prepare('INSERT INTO datasources(id,tenant_id,workspace_id,name,kind) VALUES (?,?,?,?,?)').run(sourceId, tenantId, workspaceId, '示例销售数据库', 'demo-sqlite');
      db.prepare('INSERT INTO datasets(id,tenant_id,workspace_id,datasource_id,name,dimensions_json,metrics_json) VALUES (?,?,?,?,?,?,?)').run(datasetId, tenantId, workspaceId, sourceId, '销售订单模型', JSON.stringify(['region','category','channel','order_date']), JSON.stringify(['revenue','cost','quantity','orders']));
      db.prepare('INSERT INTO dashboards(id,tenant_id,workspace_id,name,widgets_json) VALUES (?,?,?,?,?)').run(dashboardId, tenantId, workspaceId, '销售经营驾驶舱', JSON.stringify([{id:id(),title:'地区销售额',datasetId,dimension:'region',metric:'revenue',chart:'bar'}]));
      const stmt = db.prepare('INSERT INTO sales_demo VALUES (?,?,?,?,?,?,?,?,?,?)');
      const regions = ['华东','华北','华南','西部'];
      const categories = ['数码','家居','办公'];
      for (let month = 1; month <= 10; month++) for (let r = 0; r < regions.length; r++) for (let c = 0; c < categories.length; c++) {
        const revenue = (1300 + r * 410 + c * 330 + month * 93) * (month > 7 && r === 0 ? 0.72 : 1);
        stmt.run(id(),tenantId,workspaceId,`2026-${String(month).padStart(2,'0')}-15`,regions[r],categories[c],month%2?'线上':'线下',Math.round(revenue),Math.round(revenue*0.61),10+month+r+c);
      }
      db.prepare('INSERT INTO sales_demo VALUES (?,?,?,?,?,?,?,?,?,?)').run(id(),secondTenantId,secondWorkspaceId,'2026-10-15','机密区域','机密产品','内部',9999999,1,1);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

export function audit(db,ctx,action,type,resourceId=null) {
  db.prepare('INSERT INTO audit_events(id,tenant_id,user_id,action,resource_type,resource_id) VALUES (?,?,?,?,?,?)')
    .run(id(),ctx.tenantId,ctx.userId,action,type,resourceId);
}
