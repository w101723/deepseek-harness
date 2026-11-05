import { randomUUID } from 'node:crypto';
import { InputError, getDataset } from './query.mjs';
import { readableCatalog } from './dataset-policy.mjs';
import { sourcePublic, sourceSchema, connectionFor, withConnection, identifier, decryptCredentials, encryptCredentials, validateConnection } from './connectors.mjs';
import { modelFromTable } from './query-external.mjs';
import { audit } from './db.mjs';

const invalid=(message,status=400)=>{throw new InputError(message,status);};
const name=(value)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>80)invalid('名称长度必须为 1–80 字符');return value.trim();};
const description=v=>{if(v===undefined)return undefined;if(typeof v!=='string'||v.length>500)invalid('备注最多 500 字符');return v.trim();};
function edit(ctx){if(!['admin','editor'].includes(ctx.role))invalid('需要编辑权限',403);}
function admin(ctx){if(ctx.role!=='admin')invalid('需要管理员权限',403);}
function one(db,sql,...args){return db.prepare(sql).get(...args);}
function all(db,sql,...args){return db.prepare(sql).all(...args);}
function scope(db,ctx,wid){const w=one(db,'SELECT id FROM workspaces WHERE id=? AND tenant_id=?',wid,ctx.tenantId);if(!w)invalid('工作空间不存在',404);return w;}
function source(db,ctx,id){const x=one(db,'SELECT * FROM datasources WHERE id=? AND tenant_id=?',id,ctx.tenantId);if(!x)invalid('数据源不存在',404);return x;}
function folder(db,ctx,id){const x=one(db,'SELECT * FROM asset_folders WHERE id=? AND tenant_id=?',id,ctx.tenantId);if(!x)invalid('文件夹不存在',404);return x;}
function checkFolder(db,ctx,folderId,wid){if(folderId===null||folderId===undefined||folderId==='')return null;const f=folder(db,ctx,folderId);if(f.workspace_id!==wid)invalid('文件夹与资源不在同一工作空间');return f.id;}
function write(db,fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
export function ensureAssetSchema(db){
  db.exec(`CREATE TABLE IF NOT EXISTS asset_folders(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,parent_id TEXT,name TEXT NOT NULL,owner_id TEXT NOT NULL,updated_by TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(parent_id) REFERENCES asset_folders(id) ON DELETE RESTRICT);
    CREATE INDEX IF NOT EXISTS idx_asset_folders_scope ON asset_folders(tenant_id,workspace_id,parent_id);
    CREATE TABLE IF NOT EXISTS dataset_assets(dataset_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,folder_id TEXT,owner_id TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,FOREIGN KEY(folder_id) REFERENCES asset_folders(id) ON DELETE RESTRICT);
    CREATE INDEX IF NOT EXISTS idx_dataset_assets_folder ON dataset_assets(tenant_id,workspace_id,folder_id);
    CREATE TABLE IF NOT EXISTS source_assets(source_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,updated_by TEXT NOT NULL,remark TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(source_id) REFERENCES datasources(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS dataset_sql_definitions(dataset_id TEXT PRIMARY KEY,sql_text TEXT NOT NULL,FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE);`);
  // Preserve original assets from deployments predating the folder manager.
  const createdBy=(resource,kind)=>`COALESCE((SELECT a.user_id FROM audit_events a WHERE a.tenant_id=${resource}.tenant_id AND a.resource_id=${resource}.id AND a.action='${kind}' ORDER BY a.rowid LIMIT 1),(SELECT m.user_id FROM memberships m WHERE m.tenant_id=${resource}.tenant_id ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,m.user_id LIMIT 1),'')`;
  const owner=createdBy('d','dataset.create');
  db.exec(`INSERT OR IGNORE INTO dataset_assets(dataset_id,tenant_id,workspace_id,folder_id,owner_id,updated_by)
    SELECT d.id,d.tenant_id,d.workspace_id,NULL,${owner},${owner} FROM datasets d`);
  const sourceOwner=createdBy('s','datasource.create');
  db.exec(`INSERT OR IGNORE INTO source_assets(source_id,tenant_id,owner_id,updated_by)
    SELECT s.id,s.tenant_id,${sourceOwner},${sourceOwner} FROM datasources s`);
}
export function assetsDatasets(db,ctx){
  return all(db,`SELECT d.*,a.folder_id,a.owner_id,a.updated_by,a.updated_at,
        owner.name AS owner_name,modifier.name AS modifier_name,CASE WHEN sql.dataset_id IS NULL THEN 'table' ELSE 'sql' END AS model_kind,sql.sql_text
      FROM datasets d LEFT JOIN dataset_assets a ON a.dataset_id=d.id AND a.tenant_id=d.tenant_id
      LEFT JOIN users owner ON owner.id=a.owner_id LEFT JOIN users modifier ON modifier.id=a.updated_by
      LEFT JOIN dataset_sql_definitions sql ON sql.dataset_id=d.id WHERE d.tenant_id=? ORDER BY COALESCE(a.updated_at,d.created_at) DESC`,ctx.tenantId)
    .flatMap(d=>{try{const rights=readableCatalog(db,ctx,d);const {dimensions_json,metrics_json,...rest}=d;return [{...rest,dimensions:rights.dimensions,metrics:rights.metrics}];}catch(e){if(e.status===403)return [];throw e;}});
}
export function assetsSources(db,ctx){
  const permitted=ctx.role==='viewer'?new Set(assetsDatasets(db,ctx).map(x=>x.datasource_id)):null;
  return all(db,`SELECT d.*,a.owner_id,a.updated_by,a.updated_at,a.version,a.remark,u.name AS owner_name,m.name AS modifier_name FROM datasources d LEFT JOIN source_assets a ON a.source_id=d.id LEFT JOIN users u ON u.id=a.owner_id LEFT JOIN users m ON m.id=a.updated_by WHERE d.tenant_id=? ORDER BY COALESCE(a.updated_at,d.created_at) DESC`,ctx.tenantId).filter(d=>!permitted||permitted.has(d.id)).map(sourcePublic);
}
export function parseSelect(sql){
  // Parse only a single-table SELECT projection; never execute the supplied SQL.
  // Immutable WHERE predicates are converted into typed, bound parameters.
  if(typeof sql!=='string'||!sql.trim()||sql.length>2000)invalid('SQL 不合法或超过 2000 字符');
  const text=sql.trim().replace(/;$/, '').trim();
  if(text.includes(';')||/--|\/\*|\*\//.test(text))invalid('SQL 不允许多语句或注释');
  const m=/^SELECT\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*){0,49})\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+WHERE\s+(.+))?$/i.exec(text);
  if(!m)invalid('仅支持 SELECT 字段 FROM schema.table [WHERE 字段 = 常量 AND ...]，不支持 JOIN、子查询、函数或 OR');
  const fields=m[1].split(',').map(x=>x.trim());
  if(new Set(fields).size!==fields.length)invalid('SQL 投影列不能重复');
  const predicates=[];
  let condition=m[4]?.trim()||'';
  while(condition){
    if(predicates.length>=8)invalid('WHERE 最多允许 8 个 AND 条件');
    const found=/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|<>|>=|<=|>|<)\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?)(?=\s+AND\s+|$)/i.exec(condition);
    if(!found)invalid('WHERE 仅支持 字段 比较符 字符串/数字，多条件用 AND 连接');
    const literal=found[3];
    const value=literal[0]==="'"?literal.slice(1,-1).replace(/''/g,"'"):Number(literal);
    if((typeof value==='string'&&value.length>200)||(typeof value==='number'&&!Number.isFinite(value)))invalid('SQL 过滤值无效');
    const op=({'=':'eq','<>':'ne','>=':'gte','<=':'lte','>':'gt','<':'lt'})[found[2]];
    predicates.push({field:found[1],op,value});
    condition=condition.slice(found[0].length);
    if(condition){const and=/^\s+AND\s+/i.exec(condition);if(!and)invalid('SQL WHERE 语法错误');condition=condition.slice(and[0].length);if(!condition)invalid('SQL WHERE 语法错误');}
  }
  const normalized='SELECT '+fields.join(', ')+' FROM '+m[2]+'.'+m[3]+(m[4]?' WHERE '+m[4].trim():'');
  return {schema:m[2],table:m[3],fields,predicates,normalized};
}
function safePage(v,defaultValue,max){const n=Number(v??defaultValue);if(!Number.isInteger(n)||n<1||n>max)invalid('分页参数不合法');return n;}
/** Schema discovery for one chosen table, no global 500-column discovery cap. */
export async function discoverSingleTable(source,schema,table,options={}){
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema||'')||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table||''))invalid('数据库表名格式无效');
  const pg=source.kind==='postgres';
  const cfg=connectionFor(source);
  return withConnection(cfg,async query=>{
    const sql=pg?'SELECT table_schema AS schema_name,table_name AS table_name,column_name AS column_name,data_type AS data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position LIMIT 200':
      'SELECT table_schema AS schema_name,table_name AS table_name,column_name AS column_name,data_type AS data_type FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position LIMIT 200';
    const cols=await query(sql,[schema,table]);
    const columns=cols.filter(c=>c.schema_name===schema&&c.table_name===table&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.column_name||'')).map(c=>({name:c.column_name,type:c.data_type}));
    return columns.length?{schema,name:table,columns,fields:columns.map(c=>c.name)}:null;
  },options);
}
/** Paginated server-side table index; never enumerate an entire enterprise catalog. */
export async function listSourceTables(source,request={},options={}){
  const page=safePage(request.page,1,100000),pageSize=safePage(request.pageSize,15,100);
  const q=String(request.q||'').trim();if(q.length>80)invalid('表搜索最长 80 字符');
  if(source.kind==='demo-sqlite'){
    const items='sales_demo'.includes(q)?[{schema:'main',name:'sales_demo',fieldCount:7}]:[];
    return {items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize};
  }
  const pg=source.kind==='postgres',cfg=connectionFor(source);
  return withConnection(cfg,async query=>{
    const predicates=pg?"table_schema NOT IN ('pg_catalog','information_schema') AND table_type IN ('BASE TABLE','VIEW')":"table_schema=? AND table_type IN ('BASE TABLE','VIEW')";
    const params=pg?[]:[cfg.database];
    const clause=q?` AND ${pg?'POSITION($1 IN LOWER(table_name)) > 0':'LOCATE(?, LOWER(table_name)) > 0'}`:'';
    if(q)params.push(q.toLowerCase());
    const n=pg?i=>`$${i}`:()=>'?';
    const count=await query(`SELECT COUNT(*) AS total_count FROM information_schema.tables WHERE ${predicates}${clause}`,params);
    const total=Number(count[0]?.total_count??count[0]?.TOTAL_COUNT??0);
    const sort=request.sort==='schema'?'table_schema,table_name':'table_name,table_schema';
    const sql=`SELECT table_schema AS schema_name,table_name AS table_name FROM information_schema.tables WHERE ${predicates}${clause} ORDER BY ${sort} LIMIT ${n(params.length+1)} OFFSET ${n(params.length+2)}`;
    const rows=await query(sql,[...params,pageSize,(page-1)*pageSize]);
    return {items:rows.filter(r=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.schema_name||'')&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.table_name||'')).map(r=>({schema:r.schema_name,name:r.table_name,fieldCount:null})),total,page,pageSize};
  },options);
}
function referenced(db,ctx,id){
  const t=ctx.tenantId;
  const checks=[
    ['分析会话','SELECT 1 FROM analysis_sessions WHERE tenant_id=? AND dataset_id=? LIMIT 1'],
    ['分析主题','SELECT 1 FROM analysis_topics WHERE tenant_id=? AND dataset_id=? LIMIT 1'],
    ['定时分析','SELECT 1 FROM analysis_schedules WHERE tenant_id=? AND dataset_id=? LIMIT 1'],
    ['历史查询','SELECT 1 FROM query_runs WHERE tenant_id=? AND dataset_id=? LIMIT 1']
  ];
  for(const [label,sql] of checks){const table=/FROM\s+([a-z_]+)/i.exec(sql)?.[1];if(table&&!one(db,"SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",table))continue;if(one(db,sql,t,id))invalid(`数据集已被${label}引用，不允许删除`,409);}
  // Dashboards store their widgets in JSON, not a relation table.
  if(all(db,'SELECT widgets_json FROM dashboards WHERE tenant_id=?',t).some(r=>{try{return JSON.parse(r.widgets_json).some(w=>w.datasetId===id);}catch{return true;}}))invalid('数据集被看板组件引用，不允许删除',409);
}
function response(body,status=200){return {body,status};}
export async function handleAssetRoute(db,ctx,method,path,body,options={}){
  if(path==='/api/assets/folders'){
    if(method==='GET'){
      const allFolders=all(db,'SELECT f.*,u.name AS owner_name FROM asset_folders f LEFT JOIN users u ON u.id=f.owner_id WHERE f.tenant_id=? ORDER BY f.created_at,f.name',ctx.tenantId);
      if(ctx.role!=='viewer')return response({items:allFolders});
      const permitted=new Set(assetsDatasets(db,ctx).map(d=>d.folder_id).filter(Boolean)),byId=new Map(allFolders.map(f=>[f.id,f]));
      for(const fid of [...permitted]){let parent=byId.get(fid)?.parent_id;while(parent&&!permitted.has(parent)){permitted.add(parent);parent=byId.get(parent)?.parent_id;}}
      return response({items:allFolders.filter(f=>permitted.has(f.id))});
    }
    if(method==='POST'){edit(ctx);scope(db,ctx,body.workspaceId);const parent=checkFolder(db,ctx,body.parentId,body.workspaceId),fid=randomUUID();
      write(db,()=>{db.prepare('INSERT INTO asset_folders(id,tenant_id,workspace_id,parent_id,name,owner_id,updated_by) VALUES(?,?,?,?,?,?,?)').run(fid,ctx.tenantId,body.workspaceId,parent,name(body.name),ctx.userId,ctx.userId);audit(db,ctx,'folder.create','folder',fid);});return response({id:fid},201);}
  }
  let m=/^\/api\/assets\/folders\/([^/]+)$/.exec(path);
  if(m){edit(ctx);const f=folder(db,ctx,m[1]);if(method==='PATCH'){
    const parent=body.parentId===undefined?f.parent_id:checkFolder(db,ctx,body.parentId,f.workspace_id);
    if(parent===f.id)invalid('文件夹不能成为自身的子文件夹');let node=parent;
    while(node){if(node===f.id)invalid('不能移动到自己的子文件夹');node=folder(db,ctx,node).parent_id;}
    write(db,()=>{db.prepare('UPDATE asset_folders SET name=?,parent_id=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?').run(body.name===undefined?f.name:name(body.name),parent,ctx.userId,f.id,ctx.tenantId);audit(db,ctx,'folder.update','folder',f.id);});return response({id:f.id});
  }
  if(method==='DELETE'){
    if(one(db,'SELECT 1 FROM asset_folders WHERE tenant_id=? AND parent_id=?',ctx.tenantId,f.id)||one(db,'SELECT 1 FROM dataset_assets WHERE tenant_id=? AND folder_id=?',ctx.tenantId,f.id))invalid('文件夹非空，请先移动内部资源',409);
    write(db,()=>{db.prepare('DELETE FROM asset_folders WHERE id=? AND tenant_id=?').run(f.id,ctx.tenantId);audit(db,ctx,'folder.delete','folder',f.id);});return response({ok:true});
  }}
  if(path==='/api/assets/datasets'){
    if(method==='GET')return response({items:assetsDatasets(db,ctx)});
  }
  if(path==='/api/assets/datasets/table'&&method==='POST'){
    edit(ctx);const src=source(db,ctx,body.datasourceId),folderId=checkFolder(db,ctx,body.folderId,src.workspace_id);
    let model,dims,metrics;
    if(src.kind==='demo-sqlite'){
      dims=['region','category','channel','order_date'];metrics=['revenue','cost','quantity','orders'];
    }else{
      const table=await discoverSingleTable(src,body.schema,body.table,options);
      if(!table)invalid('数据表不存在或未授权',404);
      model=modelFromTable(table);dims=model.dimensions;metrics=Object.keys(model.metrics);
    }
    const did=randomUUID();write(db,()=>{
      db.prepare('INSERT INTO datasets(id,tenant_id,workspace_id,datasource_id,name,dimensions_json,metrics_json) VALUES(?,?,?,?,?,?,?)').run(did,ctx.tenantId,src.workspace_id,src.id,name(body.name),JSON.stringify(dims),JSON.stringify(metrics));
      if(model)db.prepare('INSERT INTO external_dataset_models(dataset_id,schema_name,table_name,definition_json) VALUES(?,?,?,?)').run(did,model.schema,model.table,JSON.stringify(model));
      db.prepare('INSERT INTO dataset_assets(dataset_id,tenant_id,workspace_id,folder_id,owner_id,updated_by) VALUES(?,?,?,?,?,?)').run(did,ctx.tenantId,src.workspace_id,folderId,ctx.userId,ctx.userId);
      audit(db,ctx,'dataset.table.create','dataset',did);
    });return response({id:did,version:1},201);
  }
  if(path==='/api/assets/datasets/sql'&&method==='POST'){
    edit(ctx);const src=source(db,ctx,body.datasourceId);if(src.kind==='demo-sqlite')invalid('SQL 数据集要求外部数据库');
    const select=parseSelect(body.sql),table=await discoverSingleTable(src,select.schema,select.table,options);
    if(!table)invalid('SQL 使用的表不存在或未授权',404);
    const discovered=new Set(table.columns.map(c=>c.name));if([...select.fields,...select.predicates.map(f=>f.field)].some(f=>!discovered.has(f)))invalid('SQL 使用了不存在或未授权的字段',404);
    const model=modelFromTable({...table,columns:table.columns.filter(c=>select.fields.includes(c.name))});
    model.baseFilters=select.predicates;model.sourceColumns=table.columns.map(c=>c.name);
    const did=randomUUID(),folderId=checkFolder(db,ctx,body.folderId,src.workspace_id);
    write(db,()=>{
      db.prepare('INSERT INTO datasets(id,tenant_id,workspace_id,datasource_id,name,dimensions_json,metrics_json) VALUES(?,?,?,?,?,?,?)').run(did,ctx.tenantId,src.workspace_id,src.id,name(body.name),JSON.stringify(model.dimensions),JSON.stringify(Object.keys(model.metrics)));
      db.prepare('INSERT INTO external_dataset_models(dataset_id,schema_name,table_name,definition_json) VALUES(?,?,?,?)').run(did,model.schema,model.table,JSON.stringify(model));
      db.prepare('INSERT INTO dataset_sql_definitions(dataset_id,sql_text) VALUES(?,?)').run(did,select.normalized);
      db.prepare('INSERT INTO dataset_assets(dataset_id,tenant_id,workspace_id,folder_id,owner_id,updated_by) VALUES(?,?,?,?,?,?)').run(did,ctx.tenantId,src.workspace_id,folderId,ctx.userId,ctx.userId);
      audit(db,ctx,'dataset.sql.create','dataset',did);
    });return response({id:did,version:1},201);
  }
  m=/^\/api\/assets\/datasets\/([^/]+)(?:\/(duplicate))?$/.exec(path);
  if(m){edit(ctx);const d=getDataset(db,ctx,m[1]);
    if(m[2]==='duplicate'&&method==='POST'){
      const folderId=checkFolder(db,ctx,body.folderId,d.workspace_id),newId=randomUUID();
      write(db,()=>{
        db.prepare('INSERT INTO datasets(id,tenant_id,workspace_id,datasource_id,name,dimensions_json,metrics_json) VALUES(?,?,?,?,?,?,?)').run(newId,ctx.tenantId,d.workspace_id,d.datasource_id,name(body.name||`${d.name} 副本`),d.dimensions_json,d.metrics_json);
        const model=one(db,'SELECT * FROM external_dataset_models WHERE dataset_id=?',d.id);
        if(model)db.prepare('INSERT INTO external_dataset_models VALUES(?,?,?,?)').run(newId,model.schema_name,model.table_name,model.definition_json);
        const sourceSQL=one(db,'SELECT sql_text FROM dataset_sql_definitions WHERE dataset_id=?',d.id);
        if(sourceSQL)db.prepare('INSERT INTO dataset_sql_definitions VALUES(?,?)').run(newId,sourceSQL.sql_text);
        db.prepare('INSERT INTO dataset_assets(dataset_id,tenant_id,workspace_id,folder_id,owner_id,updated_by) VALUES(?,?,?,?,?,?)').run(newId,ctx.tenantId,d.workspace_id,folderId,ctx.userId,ctx.userId);
        audit(db,ctx,'dataset.duplicate','dataset',newId);
      });return response({id:newId,version:1},201);
    }
    if(!m[2]&&method==='PATCH'){
      if(!Number.isInteger(body.version)||body.version!==d.version)invalid('数据集版本冲突',409);
      const folderId=body.folderId===undefined?one(db,'SELECT folder_id FROM dataset_assets WHERE dataset_id=?',d.id)?.folder_id??null:checkFolder(db,ctx,body.folderId,d.workspace_id);
      const updated=write(db,()=>{
        const x=db.prepare('UPDATE datasets SET name=?,version=version+1 WHERE id=? AND tenant_id=? AND version=?').run(body.name===undefined?d.name:name(body.name),d.id,ctx.tenantId,d.version);
        if(x.changes!==1)invalid('数据集版本冲突',409);
        db.prepare(`INSERT INTO dataset_assets(dataset_id,tenant_id,workspace_id,folder_id,owner_id,updated_by) VALUES(?,?,?,?,?,?) ON CONFLICT(dataset_id) DO UPDATE SET folder_id=excluded.folder_id,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run(d.id,ctx.tenantId,d.workspace_id,folderId,ctx.userId,ctx.userId);
        audit(db,ctx,'dataset.update','dataset',d.id);return d.version+1;
      });return response({id:d.id,version:updated});
    }
    if(!m[2]&&method==='DELETE'){
      referenced(db,ctx,d.id);
      write(db,()=>{db.prepare('DELETE FROM dataset_role_policies WHERE dataset_id=? AND tenant_id=?').run(d.id,ctx.tenantId);db.prepare('DELETE FROM dataset_policy_generations WHERE dataset_id=? AND tenant_id=?').run(d.id,ctx.tenantId);db.prepare('DELETE FROM external_dataset_models WHERE dataset_id=?').run(d.id);db.prepare('DELETE FROM dataset_assets WHERE dataset_id=?').run(d.id);db.prepare('DELETE FROM dataset_sql_definitions WHERE dataset_id=?').run(d.id);db.prepare('DELETE FROM datasets WHERE id=? AND tenant_id=?').run(d.id,ctx.tenantId);audit(db,ctx,'dataset.delete','dataset',d.id);});return response({ok:true});
    }
  }
  m=/^\/api\/assets\/sources\/([^/]+)\/tables$/.exec(path);
  if(m&&method==='GET'){
    edit(ctx);const s=source(db,ctx,m[1]);return response(await listSourceTables(s,options.query??{},options));
  }
  m=/^\/api\/assets\/sources\/([^/]+)\/preview$/.exec(path);
  if(m&&method==='GET'){
    edit(ctx);const s=source(db,ctx,m[1]),requested=options.query??{};
    if(s.kind==='demo-sqlite'){
      if(requested.schema!=='main'||requested.table!=='sales_demo')invalid('数据表不存在',404);
      const columns=['order_date','region','category','channel','revenue','cost','quantity'];
      const rows=all(db,'SELECT order_date,region,category,channel,revenue,cost,quantity FROM sales_demo WHERE tenant_id=? AND workspace_id=? LIMIT 15',ctx.tenantId,s.workspace_id);
      audit(db,ctx,'datasource.table.preview','datasource',s.id);return response({columns,rows});
    }
    const table=await discoverSingleTable(s,requested.schema,requested.table,options);
    if(!table)invalid('表不在当前数据源元数据中',404);
    const cfg=connectionFor(s),sql=`SELECT * FROM ${identifier(table.schema,s.kind)}.${identifier(table.name,s.kind)} LIMIT 15`;
    const rows=await withConnection(cfg,query=>query(sql),options);
    audit(db,ctx,'datasource.table.preview','datasource',s.id);
    return response({columns:table.fields,rows:rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='bigint'?v.toString():v instanceof Date?v.toISOString():v])))});
  }
  if(path==='/api/assets/sources'&&method==='GET')return response({items:assetsSources(db,ctx)});
  m=/^\/api\/assets\/sources\/([^/]+)$/.exec(path);
  if(m){edit(ctx);const s=source(db,ctx,m[1]);
    if(method==='PATCH'){
      const current=one(db,'SELECT * FROM source_assets WHERE source_id=? AND tenant_id=?',s.id,ctx.tenantId),version=current?.version??1;
      if(body.version!==version)invalid('数据源版本冲突',409);
      const remark=description(body.remark);
      let encrypted=null;
      if(body.connection!==undefined){
        if(s.kind==='demo-sqlite')invalid('演示数据源不支持修改外部连接');
        if(!body.connection||typeof body.connection!=='object'||Array.isArray(body.connection)||(body.connection.kind&&body.connection.kind!==s.kind))invalid('连接类型不可更改');
        const candidate=validateConnection({...body.connection,kind:s.kind});
        const original=decryptCredentials(s.connection_json);
        const hasDatasets=!!one(db,'SELECT 1 FROM datasets WHERE datasource_id=? AND tenant_id=?',s.id,ctx.tenantId);
        if(hasDatasets&&['host','port','database'].some(k=>String(candidate[k])!==String(original[k])))invalid('已有数据集引用此数据源；请保持主机、端口和数据库不变，只更新账户、密码或 TLS',409);
        await withConnection(candidate,async query=>{await query('SELECT 1 AS connected');},options);
        encrypted=encryptCredentials(candidate);
      }
      const active=one(db,'SELECT role FROM memberships WHERE user_id=? AND tenant_id=?',ctx.userId,ctx.tenantId);
      if(!active||active.role!==ctx.role)invalid('连接验证期间账户角色发生变化，请重新提交',403);
      write(db,()=>{
        const latest=one(db,'SELECT version FROM source_assets WHERE source_id=? AND tenant_id=?',s.id,ctx.tenantId);
        if((latest?.version??1)!==version||!one(db,'SELECT id FROM datasources WHERE id=? AND tenant_id=?',s.id,ctx.tenantId))invalid('数据源版本冲突，请刷新页面',409);
        db.prepare('UPDATE datasources SET name=?,connection_json=COALESCE(?,connection_json) WHERE id=? AND tenant_id=?').run(body.name===undefined?s.name:name(body.name),encrypted,s.id,ctx.tenantId);
        db.prepare('INSERT INTO source_assets(source_id,tenant_id,owner_id,updated_by,remark,version) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET updated_by=excluded.updated_by,remark=excluded.remark,version=source_assets.version+1,updated_at=CURRENT_TIMESTAMP').run(s.id,ctx.tenantId,ctx.userId,ctx.userId,remark??current?.remark??'',version+1);
        audit(db,ctx,encrypted?'source.connection.rotate':'source.update','datasource',s.id);
      });return response({id:s.id,version:version+1,connectionUpdated:!!encrypted});
    }
    if(method==='DELETE'){
      if(one(db,'SELECT 1 FROM datasets WHERE tenant_id=? AND datasource_id=?',ctx.tenantId,s.id))invalid('数据源已被数据集引用，不能删除',409);
      write(db,()=>{db.prepare('DELETE FROM source_assets WHERE source_id=? AND tenant_id=?').run(s.id,ctx.tenantId);db.prepare('DELETE FROM datasources WHERE id=? AND tenant_id=?').run(s.id,ctx.tenantId);audit(db,ctx,'source.delete','datasource',s.id);});return response({ok:true});
    }
  }
  invalid('资源管理 API 不存在',404);
}