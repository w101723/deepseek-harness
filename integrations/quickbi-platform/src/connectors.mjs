import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { InputError } from './query.mjs';

export const SUPPORTED_SOURCES = Object.freeze(['postgres','mysql','tidb','starrocks']);
const ident = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export function assertIdentifier(value) {
  if(typeof value!=='string' || !ident.test(value) || value.length>64)throw new InputError('不支持的 SQL 标识符',400);
  return value;
}
function keyFromEnv() {
  const raw=process.env.DATASOURCE_MASTER_KEY||'';
  if(!/^[0-9a-fA-F]{64}$/.test(raw)) throw new InputError('服务未配置 DATASOURCE_MASTER_KEY（64 位十六进制）',503);
  return Buffer.from(raw,'hex');
}
export function encryptCredentials(value) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyFromEnv(),iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
}
export function decryptCredentials(sealed) {
  try {
    const {v,iv,tag,data}=JSON.parse(sealed);
    if(v!==1)throw Error('version');
    const decipher=createDecipheriv('aes-256-gcm',keyFromEnv(),Buffer.from(iv,'base64'));
    decipher.setAuthTag(Buffer.from(tag,'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8'));
  }catch(e){if(e instanceof InputError)throw e;throw new InputError('数据源凭据解密失败',503);}
}
function allowedHost(host){
  // Explicit opt-in for each reachable DB hostname/IP. No wildcard, URLs or socket paths.
  const allowed=(process.env.DATASOURCE_ALLOWED_HOSTS||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
  if(!allowed.includes(host.toLowerCase()))throw new InputError('数据源地址未加入 DATASOURCE_ALLOWED_HOSTS 白名单',403);
}
export function validateConnection(input) {
  if(!input || !SUPPORTED_SOURCES.includes(input.kind))throw new InputError('不支持的数据源类型');
  const host=String(input.host||'').trim(), database=String(input.database||'').trim(),user=String(input.user||'').trim(),password=input.password;
  const port=Number(input.port||(input.kind==='postgres'?5432:3306));
  if(!/^[a-zA-Z0-9_.:-]{1,253}$/.test(host)||host.includes('..')||!host)throw new InputError('数据源主机名格式不合法');
  allowedHost(host);
  if(!Number.isInteger(port)||port<1||port>65535)throw new InputError('数据库端口无效');
  if(!ident.test(database)||database.length>64||!user||user.length>128||typeof password!=='string'||password.length>1024)throw new InputError('数据库名、账号或密码无效');
  // TLS opt-in: remote DBs should be configured with TLS; the DB driver validates the certificate.
  return {kind:input.kind,host,port,database,user,password,ssl:input.ssl===true};
}
export function sourcePublic(row){
  const {connection_json,...rest}=row;
  if(row.kind==='demo-sqlite')return rest;
  let cfg={};try{cfg=decryptCredentials(connection_json);}catch{}
  return {...rest,host:cfg.host||null,port:cfg.port||null,database:cfg.database||null,ssl:cfg.ssl??false};
}
export function connectionFor(row) {
  if(!SUPPORTED_SOURCES.includes(row.kind)||!row.connection_json)throw new InputError('数据源未配置');
  const c=decryptCredentials(row.connection_json);
  allowedHost(c.host); // Re-check on every use, including when allowlist changes after creation.
  return {...c,kind:row.kind};
}
export function dialect(kind){return kind==='postgres'?'postgres':'mysql';}
export function identifier(name,kind){const n=assertIdentifier(name);return dialect(kind)==='postgres'?`"${n}"`:`\`${n}\``;}
export function bindPlaceholder(kind,index){return dialect(kind)==='postgres'?`$${index}`:'?';}
export function externalError(err){
  if(err instanceof InputError)return err;
  const known=new Set(['ECONNREFUSED','ENOTFOUND','ETIMEDOUT','EHOSTUNREACH','28P01','1045','3D000','1049']);
  const code=String(err?.code||'');
  if(known.has(code))return new InputError(`数据库连接/认证失败（${code}）`,502);
  return new InputError('数据源查询失败（请检查网络、权限或数据库日志）',502);
}
export async function withConnection(config,runner,{drivers}={}) {
  let conn, isPg=dialect(config.kind)==='postgres';
  try {
    if(isPg){
      const Client=drivers?.postgres ?? (await import('pg')).default.Client;
      conn=new Client({host:config.host,port:config.port,database:config.database,user:config.user,password:config.password,ssl:config.ssl?{rejectUnauthorized:true}:false,connectionTimeoutMillis:5000,query_timeout:15000});
      await conn.connect();
      await conn.query('BEGIN TRANSACTION READ ONLY');
      await conn.query('SET LOCAL statement_timeout = 15000');
      const query=async(sql,params=[])=>{const r=await conn.query({text:sql,values:params});return r.rows;};
      return await runner(query);
    }
    const factory=drivers?.mysql ?? (await import('mysql2/promise')).createConnection;
    conn=await factory({host:config.host,port:config.port,database:config.database,user:config.user,password:config.password,connectTimeout:5000,ssl:config.ssl?{minVersion:'TLSv1.2',rejectUnauthorized:true}:undefined,multipleStatements:false,decimalNumbers:true,timezone:'Z'});
    // Prepared queries prevent driver-side interpolation; database accounts must be read-only.
    // Some supported engines do not implement START TRANSACTION READ ONLY; no writable SQL exists in the query compiler.
    const query=async(sql,params=[])=>{const [rows]=await conn.execute({sql,values:params,timeout:15000});return rows;};
    return await runner(query);
  }catch(e){throw externalError(e);}finally{
    if(conn){try{if(isPg){await conn.query('ROLLBACK');await conn.end();}else await conn.end();}catch{}}
  }
}
export async function testSource(source,options={}){
  return withConnection(connectionFor(source),async query=>{await query('SELECT 1 AS connected');return {ok:true,kind:source.kind};},options);
}
export async function sourceSchema(source,options={}){
  const cfg=connectionFor(source); const pg=dialect(source.kind)==='postgres';
  return withConnection(cfg,async query=>{
    const rows=pg?
      await query(`SELECT table_schema AS schema_name,table_name,column_name,data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name,ordinal_position LIMIT 500`):
      await query(`SELECT table_schema AS schema_name,table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=? ORDER BY table_name,ordinal_position LIMIT 500`,[cfg.database]);
    const tables=new Map();
    for(const r of rows){
      if(!ident.test(r.schema_name)||!ident.test(r.table_name)||!ident.test(r.column_name))continue;
      const key=`${r.schema_name}.${r.table_name}`;
      if(!tables.has(key))tables.set(key,{schema:r.schema_name,name:r.table_name,columns:[],fields:[]});
      const t=tables.get(key);t.columns.push({name:r.column_name,type:r.data_type});t.fields.push(r.column_name);
    }
    return {kind:source.kind,tables:[...tables.values()]};
  },options);
}
export async function sourcePreview(source,options={}){
  const cfg=connectionFor(source), schema=await sourceSchema(source,options);
  const table=schema.tables[0];if(!table)return {columns:[],rows:[]};
  const sql=`SELECT * FROM ${identifier(table.schema,cfg.kind)}.${identifier(table.name,cfg.kind)} LIMIT 15`;
  const rows=await withConnection(cfg,async query=>await query(sql),options);
  return {schema:table.schema,table:table.name,columns:table.fields,rows:rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?Number(v):v])))};
}
