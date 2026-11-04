import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { id, token, hashToken, verifyPassword, openDatabase, audit } from './db.mjs';
import { executeQuery, suggestSpec, InputError, getDataset } from './query.mjs';
import { narrateWithHarness } from './harness.mjs';

const publicDir=join(dirname(fileURLToPath(import.meta.url)),'../public');
const assetMap={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
const fail=(status,message)=>{throw new InputError(message,status);};
const clean=v=>typeof v==='string'?v.trim():'';
const name=v=>{v=clean(v);if(v.length<1||v.length>80)fail(400,'名称长度须在 1–80 字符');return v;};
const list=(db,sql,...params)=>db.prepare(sql).all(...params).map(x=>({...x}));
const one=(db,sql,...params)=>db.prepare(sql).get(...params);
const roleRank={viewer:1,editor:2,admin:3};
const rateLimit=new Map();
function requireRole(ctx,role){if((roleRank[ctx.role]||0)<roleRank[role])fail(403,'没有该操作权限');}
function sessionFromRequest(db,req){
  const match=/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'');
  if(!match)fail(401,'尚未登录');
  const record=one(db,`SELECT s.*,u.name,u.email,m.role,t.name AS tenant_name FROM sessions s
    JOIN users u ON u.id=s.user_id JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
    JOIN tenants t ON t.id=s.tenant_id WHERE s.token_hash=? AND s.expires_at>?`,hashToken(match[1]),Date.now());
  if(!record)fail(401,'登录已过期或账号无权限');
  return {userId:record.user_id,tenantId:record.tenant_id,tenantName:record.tenant_name,role:record.role,name:record.name,email:record.email,csrf:record.csrf,tokenHash:record.token_hash};
}
function assertOrigin(req){
  const origin=req.headers.origin;
  if(origin){let url;try{url=new URL(origin)}catch{fail(403,'请求来源非法')};if(url.host!==req.headers.host)fail(403,'跨来源请求已拒绝');}
}
async function bodyJson(req){
  if(!req.headers['content-type']?.toLowerCase().startsWith('application/json'))fail(415,'仅接受 application/json');
  let size=0,parts=[];
  for await(const chunk of req){size+=chunk.length;if(size>131072)fail(413,'请求体过大');parts.push(chunk);}
  try{const data=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))fail(400,'JSON 对象无效');return data;}catch(e){if(e instanceof InputError)throw e;fail(400,'JSON 格式错误');}
}
function workspace(db,ctx,workspaceId){
  const row=one(db,'SELECT * FROM workspaces WHERE id=? AND tenant_id=?',workspaceId,ctx.tenantId);
  if(!row)fail(404,'工作空间不存在');return row;
}
function datasource(db,ctx,sourceId){
  const row=one(db,'SELECT * FROM datasources WHERE id=? AND tenant_id=?',sourceId,ctx.tenantId);
  if(!row)fail(404,'数据源不存在');return row;
}
function dashboard(db,ctx,dashboardId){
  const row=one(db,'SELECT * FROM dashboards WHERE id=? AND tenant_id=?',dashboardId,ctx.tenantId);
  if(!row)fail(404,'仪表板不存在');return {...row,widgets:JSON.parse(row.widgets_json)};
}
function validWidgets(db,ctx,items){
  if(!Array.isArray(items)||items.length>30)fail(400,'组件数量超出限制');
  return items.map(w=>{
    if(!w||typeof w!=='object'||!['bar','table','line'].includes(w.chart))fail(400,'图表类型无效');
    const dataset=getDataset(db,ctx,w.datasetId);
    const dims=JSON.parse(dataset.dimensions_json),met=JSON.parse(dataset.metrics_json);
    if(!dims.includes(w.dimension)||!met.includes(w.metric))fail(400,'组件字段无效');
    return {id:typeof w.id==='string'&&w.id.length<80?w.id:id(),title:name(w.title),datasetId:dataset.id,dimension:w.dimension,metric:w.metric,chart:w.chart};
  });
}
function publicUser(db,ctx){
  return {id:ctx.userId,name:ctx.name,email:ctx.email,tenantId:ctx.tenantId,tenantName:ctx.tenantName,role:ctx.role,csrf:ctx.csrf,tenants:list(db,'SELECT t.id,t.name,m.role FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=? ORDER BY t.name',ctx.userId)};
}
export function createApp(opts={}){
  const db=openDatabase(opts.dbPath ?? ':memory:',{demoMode:opts.demoMode??false,bootstrapEmail:opts.bootstrapEmail,bootstrapPassword:opts.bootstrapPassword});
  const server=http.createServer(async(req,res)=>{
    try {
      const u=new URL(req.url,'http://localhost'), path=u.pathname, method=req.method;
      res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
      if(method==='GET'&&assetMap[path]){
        const file=assetMap[path], bytes=await readFile(join(publicDir,file));
        res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(bytes);return;
      }
      if(path==='/api/health'&&method==='GET')return json(res,{ok:true,service:'quickbi-platform',version:'0.1.0'});
      if(!path.startsWith('/api/'))fail(404,'页面不存在');
      if(!['GET','POST','PATCH','DELETE'].includes(method))fail(405,'方法不允许');
      if(method!=='GET')assertOrigin(req);
      if(path==='/api/login'&&method==='POST'){
        const b=await bodyJson(req),email=clean(b.email).toLowerCase(),password=b.password;
        if(!email||typeof password!=='string')fail(400,'邮箱与密码必填');
        const key=`${req.socket.remoteAddress}:${email}`,info=rateLimit.get(key)||{count:0,until:0};
        if(Date.now()<info.until)fail(429,'登录失败次数过多，请稍后重试');
        const user=one(db,'SELECT * FROM users WHERE email=?',email);
        if(!user||!verifyPassword(password,user.password_hash)){
          info.count++;info.until=info.count>=5?Date.now()+300000:0;rateLimit.set(key,info);fail(401,'邮箱或密码错误');
        }
        rateLimit.delete(key);
        const membership=one(db,'SELECT tenant_id FROM memberships WHERE user_id=? ORDER BY tenant_id LIMIT 1',user.id);
        if(!membership)fail(403,'账号尚未加入任何组织');
        const raw=token(),csrf=token();
        db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(hashToken(raw),user.id,membership.tenant_id,csrf,Date.now()+8*3600_000);
        const secure=opts.secureCookies??process.env.NODE_ENV==='production';
        res.setHeader('Set-Cookie',`session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure?'; Secure':''}`);
        const ctx=sessionFromRequest(db,{headers:{cookie:`session=${raw}`}});
        audit(db,ctx,'auth.login','session');return json(res,{user:publicUser(db,ctx)});
      }
      const ctx=sessionFromRequest(db,req);
      if(method!=='GET'&&req.headers['x-csrf-token']!==ctx.csrf)fail(403,'CSRF 校验失败');
      if(path==='/api/me'&&method==='GET')return json(res,{user:publicUser(db,ctx)});
      if(path==='/api/logout'&&method==='POST'){
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(ctx.tokenHash);audit(db,ctx,'auth.logout','session');
        res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,{ok:true});
      }
      if(path==='/api/tenants'&&method==='GET')return json(res,{items:publicUser(db,ctx).tenants});
      if(path==='/api/tenant/switch'&&method==='POST'){
        const b=await bodyJson(req),m=one(db,'SELECT role FROM memberships WHERE tenant_id=? AND user_id=?',b.tenantId,ctx.userId);
        if(!m)fail(403,'不可切换至未授权租户');
        db.prepare('UPDATE sessions SET tenant_id=?,csrf=? WHERE token_hash=?').run(b.tenantId,token(),ctx.tokenHash);
        const next=sessionFromRequest(db,req);audit(db,next,'tenant.switch','tenant',b.tenantId);return json(res,{user:publicUser(db,next)});
      }
      if(path==='/api/workspaces'){
        if(method==='GET')return json(res,{items:list(db,'SELECT * FROM workspaces WHERE tenant_id=? ORDER BY created_at DESC',ctx.tenantId)});
        if(method==='POST'){
          requireRole(ctx,'editor');const b=await bodyJson(req),newId=id();db.prepare('INSERT INTO workspaces(id,tenant_id,name) VALUES (?,?,?)').run(newId,ctx.tenantId,name(b.name));audit(db,ctx,'workspace.create','workspace',newId);return json(res,{id:newId},201);
        }
      }
      if(path==='/api/datasources'){
        if(method==='GET')return json(res,{items:list(db,'SELECT * FROM datasources WHERE tenant_id=? ORDER BY created_at DESC',ctx.tenantId)});
        if(method==='POST'){
          requireRole(ctx,'editor');const b=await bodyJson(req);workspace(db,ctx,b.workspaceId);
          if(b.kind!=='demo-sqlite')fail(422,'当前仅实现 demo-sqlite 连接器');
          const newId=id();db.prepare('INSERT INTO datasources(id,tenant_id,workspace_id,name,kind) VALUES (?,?,?,?,?)').run(newId,ctx.tenantId,b.workspaceId,name(b.name),b.kind);
          audit(db,ctx,'datasource.create','datasource',newId);return json(res,{id:newId},201);
        }
      }
      let m=/^\/api\/datasources\/([^/]+)\/(test|schema|preview)$/.exec(path);
      if(m&&method==='GET'){
        const ds=datasource(db,ctx,m[1]);
        if(m[2]==='test')return json(res,{ok:true,kind:ds.kind});
        if(m[2]==='schema')return json(res,{tables:[{name:'sales_demo',fields:['order_date','region','category','channel','revenue','cost','quantity']}],kind:ds.kind});
        return json(res,{columns:['order_date','region','category','channel','revenue','cost','quantity'],rows:list(db,'SELECT order_date,region,category,channel,revenue,cost,quantity FROM sales_demo WHERE tenant_id=? AND workspace_id=? LIMIT 15',ctx.tenantId,ds.workspace_id)});
      }
      if(path==='/api/datasets'){
        if(method==='GET')return json(res,{items:list(db,'SELECT * FROM datasets WHERE tenant_id=? ORDER BY created_at DESC',ctx.tenantId).map(x=>({...x,dimensions:JSON.parse(x.dimensions_json),metrics:JSON.parse(x.metrics_json)}))});
        if(method==='POST'){
          requireRole(ctx,'editor');const b=await bodyJson(req),ds=datasource(db,ctx,b.datasourceId);
          const allowedDims=['region','category','channel','order_date'],allowedMetrics=['revenue','cost','quantity','orders'];
          const dims=b.dimensions??allowedDims,metrics=b.metrics??allowedMetrics;
          if(!Array.isArray(dims)||!dims.length||dims.some(x=>!allowedDims.includes(x))||!Array.isArray(metrics)||!metrics.length||metrics.some(x=>!allowedMetrics.includes(x)))fail(400,'维度或指标配置无效');
          const newId=id();db.prepare('INSERT INTO datasets(id,tenant_id,workspace_id,datasource_id,name,dimensions_json,metrics_json) VALUES (?,?,?,?,?,?,?)').run(newId,ctx.tenantId,ds.workspace_id,ds.id,name(b.name),JSON.stringify([...new Set(dims)]),JSON.stringify([...new Set(metrics)]));
          audit(db,ctx,'dataset.create','dataset',newId);return json(res,{id:newId,version:1},201);
        }
      }
      m=/^\/api\/datasets\/([^/]+)\/preview$/.exec(path);
      if(m&&method==='GET'){
        const ds=getDataset(db,ctx,m[1]),dim=JSON.parse(ds.dimensions_json)[0],metric=JSON.parse(ds.metrics_json)[0];
        return json(res,executeQuery(db,ctx,{datasetId:ds.id,dimensions:[dim],metrics:[metric],limit:20}));
      }
      if(path==='/api/query'&&method==='POST')return json(res,executeQuery(db,ctx,await bodyJson(req)));
      if(path==='/api/query/history'&&method==='GET')return json(res,{items:list(db,'SELECT id,dataset_id,row_count,created_at FROM query_runs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50',ctx.tenantId)});
      if(path==='/api/dashboards'){
        if(method==='GET')return json(res,{items:list(db,'SELECT * FROM dashboards WHERE tenant_id=? ORDER BY updated_at DESC',ctx.tenantId).map(x=>({...x,widgets:JSON.parse(x.widgets_json)}))});
        if(method==='POST'){
          requireRole(ctx,'editor');const b=await bodyJson(req);workspace(db,ctx,b.workspaceId);
          const newId=id();db.prepare('INSERT INTO dashboards(id,tenant_id,workspace_id,name,widgets_json) VALUES (?,?,?,?,?)').run(newId,ctx.tenantId,b.workspaceId,name(b.name),JSON.stringify(validWidgets(db,ctx,b.widgets??[])));
          audit(db,ctx,'dashboard.create','dashboard',newId);return json(res,{id:newId,version:1},201);
        }
      }
      m=/^\/api\/dashboards\/([^/]+)$/.exec(path);
      if(m){
        const d=dashboard(db,ctx,m[1]);if(method==='GET')return json(res,{item:d});
        if(method==='PATCH'){
          requireRole(ctx,'editor');const b=await bodyJson(req);
          if(!Number.isInteger(b.version)||b.version!==d.version)fail(409,'版本冲突，请重新载入');
          const widgets=b.widgets===undefined?d.widgets:validWidgets(db,ctx,b.widgets);
          const newName=b.name===undefined?d.name:name(b.name);
          const updated=db.prepare('UPDATE dashboards SET name=?,widgets_json=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND version=?').run(newName,JSON.stringify(widgets),d.id,ctx.tenantId,b.version);
          if(updated.changes!==1)fail(409,'版本冲突');audit(db,ctx,'dashboard.update','dashboard',d.id);return json(res,{id:d.id,version:b.version+1});
        }
      }
      if(path==='/api/ai/ask'&&method==='POST'){
        const b=await bodyJson(req),question=clean(b.question),datasets=list(db,'SELECT * FROM datasets WHERE tenant_id=? ORDER BY created_at LIMIT 50',ctx.tenantId);
        const spec=suggestSpec(question,datasets),result=executeQuery(db,ctx,spec);
        const dims=spec.dimensions,metric=spec.metrics[0];
        const summary=`已按${dims.length?dims.join('、'):'全量'}汇总 ${metric}，共返回 ${result.count} 行。此结果来自受控语义查询，不代表因果归因。`;
        let narration=null,error=null;
        if(opts.harnessEnabled){try{narration=await narrateWithHarness(question,result,{enabled:true,home:opts.harnessHome});}catch(e){error=`Harness 未就绪：${e.message}`;}}
        audit(db,ctx,'ai.ask','dataset',spec.datasetId);
        return json(res,{mode:opts.harnessEnabled?'harness-narration':'deterministic-preview',question,spec,result,summary:narration||summary,warning:error});
      }
      if(path==='/api/audit'&&method==='GET'){
        requireRole(ctx,'admin');return json(res,{items:list(db,'SELECT id,user_id,action,resource_type,resource_id,created_at FROM audit_events WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100',ctx.tenantId)});
      }
      if(path==='/api/search'&&method==='GET'){
        const q=(u.searchParams.get('q')||'').slice(0,80),pattern=`%${q.replace(/[\\%_]/g,'\\$&')}%`;
        return json(res,{items:[...list(db,"SELECT id,name,'dataset' AS type FROM datasets WHERE tenant_id=? AND name LIKE ? ESCAPE '\\' LIMIT 20",ctx.tenantId,pattern),...list(db,"SELECT id,name,'dashboard' AS type FROM dashboards WHERE tenant_id=? AND name LIKE ? ESCAPE '\\' LIMIT 20",ctx.tenantId,pattern)]});
      }
      fail(404,'API 路由不存在');
    }catch(e){
      const status=e instanceof InputError?e.status:(e?.code==='SQLITE_CONSTRAINT_UNIQUE'?409:500);
      if(status===500)console.error('[server error]',e);
      json(res,{error:status===500?'服务器内部错误':e.message},status);
    }
  });
  server.on('close',()=>db.close());
  return {server,db};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const opts={dbPath:process.env.DB_PATH||'./data/quickbi.sqlite',demoMode:process.env.DEMO_MODE==='1',bootstrapEmail:process.env.BOOTSTRAP_EMAIL,bootstrapPassword:process.env.BOOTSTRAP_PASSWORD,harnessEnabled:process.env.HARNESS_ENABLE==='1',harnessHome:process.env.HARNESS_HOME};
  const {server}=createApp(opts),port=Number(process.env.PORT||3088),host=process.env.HOST||'127.0.0.1';
  server.listen(port,host,()=>console.log(`QuickBI platform listening at http://${host}:${port} (DEMO_MODE=${opts.demoMode})`));
}