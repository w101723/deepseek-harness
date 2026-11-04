const state={user:null,workspaces:[],sources:[],datasets:[],dashboards:[],page:'home',workspaceId:null,activeDashboard:null,query:null,messages:[],aiSessions:[],aiSessionId:null,aiMessages:[],aiArtifacts:[],aiTopics:[],topicSelectedId:null,topicKnowledge:[],aiCanvases:[],aiCanvas:null,aiResult:null,canvasZoom:1,aiArtifactDetail:null,policyEditor:null,aiSchedules:[],aiScheduleRuns:null};
const app=document.querySelector('#app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=n=>Number(n||0).toLocaleString('zh-CN',{maximumFractionDigits:2});
function toast(message){document.querySelector('.toast')?.remove();const el=document.createElement('div');el.className='toast';el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),3500);}
async function api(path,{method='GET',body}={}){
  const r=await fetch(path,{method,credentials:'same-origin',headers:{...(body?{'Content-Type':'application/json'}:{}),...(method!=='GET'&&state.user?{'x-csrf-token':state.user.csrf}:{})},body:body?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>({error:'服务器响应无效'}));
  if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);
  return data;
}
async function load(){const [w,s,d,boards]=await Promise.all([api('/api/workspaces'),api('/api/datasources'),api('/api/datasets'),api('/api/dashboards')]);state.workspaces=w.items;state.sources=s.items;state.datasets=d.items;state.dashboards=boards.items;if(!state.workspaces.some(x=>x.id===state.workspaceId))state.workspaceId=state.workspaces[0]?.id??null;}
function navButton(page,label,ico){return `<button data-action="navigate" data-page="${page}" class="${state.page===page?'active':''}"><span class="ico">${ico}</span><span class="caption">${label}</span></button>`;}
function shell(content){const u=state.user;app.innerHTML=`<div class="shell"><aside class="side"><div class="brand"><div class="brand-icon">I</div><span><b>Insight BI</b><small>INTELLIGENCE PLATFORM</small></span></div><nav class="nav"><div class="nav-group">工作空间</div>${navButton('home','总览主页','⌂')}${navButton('sources','数据源管理','▣')}${navButton('datasets','数据集建模','▤')}${navButton('query','语义查询','⌕')}<div class="nav-group">一期 · AIPro</div>${navButton('aipro','AIPro 分析','✧')}${navButton('topics','分析主题','⌘')}${navButton('canvas','分析画布','▦')}${navButton('schedules','定时分析','◷')}<div class="nav-group">管理与二期</div>${navButton('dashboards','看板（原型）','▥')}${navButton('audit','操作审计','◷')}</nav><div class="side-bottom"><b>Foundation · v0.5</b><br>真实 API · 持久化 · 权限隔离<br>Harness 原生 BI Tool 可选启用</div></aside><main class="main"><header class="topbar"><div class="breadcrumb">企业分析平台 / ${esc(({home:'工作台',sources:'数据源',datasets:'数据集',query:'查询分析',dashboards:'仪表板',aipro:'AIPro',topics:'分析主题',canvas:'分析画布',schedules:'定时分析',audit:'审计日志'})[state.page])}</div><div class="workspace-control"><select class="top-select" id="workspace"><option value="">全部工作空间</option>${state.workspaces.map(w=>`<option value="${esc(w.id)}" ${w.id===state.workspaceId?'selected':''}>${esc(w.name)}</option>`).join('')}</select><div class="avatar">${esc(u.name.slice(0,1))}</div><span class="tiny">${esc(u.name)} · ${esc(u.role)}</span><button class="btn secondary sm" data-action="logout">退出</button></div></header><div class="content">${content}<div class="footer-note">Insight BI Foundation · 独立产品实现，非阿里云官方产品 · 开发预览，不可直接部署为生产环境</div></div></main></div>`;}
const title=(eyebrow,heading,action='')=>`<div class="eyebrow">${eyebrow}</div><div class="page-title"><h1>${heading}</h1>${action}</div>`;
const noData=(hint='暂无数据')=>`<div class="empty"><div class="big">◇</div><p>${esc(hint)}</p></div>`;
const wp=()=>state.workspaceId||'';
const filterWorkspace=a=>a.filter(x=>!wp()||x.workspace_id===wp());
const datasets=()=>filterWorkspace(state.datasets);
const sources=()=>filterWorkspace(state.sources);
function home(){
  const boards=filterWorkspace(state.dashboards);
  const body=`${title('OVERVIEW','让每一个数据决策都有依据')}<div class="hero"><div><h2>数据与智能，同一个工作台</h2><p>从连接数据源到自助分析、可视化看板和智能问数。<br>当前是可运行的 M0/M1 开发基础版。</p></div><div class="actions"><button class="btn light" data-action="navigate" data-page="query">打开查询分析 →</button><button class="btn light" data-action="navigate" data-page="aipro">尝试智能问数 ✧</button></div></div><div class="section grid four"><div class="card stat"><div class="label">工作空间</div><div class="value">${state.workspaces.length}</div><div class="sub">租户隔离</div></div><div class="card stat"><div class="label">已连接数据源</div><div class="value">${sources().length}</div><div class="sub">受控只读连接</div></div><div class="card stat"><div class="label">数据集</div><div class="value">${datasets().length}</div><div class="sub">语义指标</div></div><div class="card stat"><div class="label">仪表板</div><div class="value">${boards.length}</div><div class="sub">可编辑版本</div></div></div><div class="section-title"><h2>最近的分析资产</h2><button class="btn secondary sm" data-action="navigate" data-page="dashboards">查看全部</button></div><div class="grid">${boards.length?boards.slice(0,3).map(b=>`<div class="card clickable" data-action="open-dashboard" data-id="${esc(b.id)}"><div class="row spaced"><span class="tag">仪表板</span><span class="muted tiny">v${b.version}</span></div><h3>${esc(b.name)}</h3><p class="muted tiny">${b.widgets.length} 个图表组件</p></div>`).join(''):noData('暂无仪表板')}</div>`;
  shell(body);
}
function sourcesPage(){shell(`${title('DATA CONNECTIONS','数据源管理',state.user.role!=='viewer'?'<button class="btn" data-action="toggle-source-form">+ 连接数据库</button>':'')}<div class="notice">一期支持直连 PostgreSQL / MySQL 协议（TiDB、StarRocks 复用 MySQL 协议）。不做 ETL / 同步。服务端须设置 DATASOURCE_MASTER_KEY 和 DATASOURCE_ALLOWED_HOSTS。</div><div id="source-form" class="card form section hidden"><h3>新建只读数据源</h3><form id="create-source" class="stack"><div class="form-row"><label>数据源名称<input name="name" required placeholder="经营分析数据库"></label><label>数据库类型<select name="kind" id="source-kind"><option value="demo-sqlite">演示 SQLite</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="tidb">TiDB</option><option value="starrocks">StarRocks</option></select></label></div><div id="external-fields" class="stack hidden"><div class="form-row"><label>地址<input name="host" placeholder="db.internal"></label><label>端口<input name="port" type="number" placeholder="5432 / 3306"></label><label>数据库<input name="database" placeholder="analytics"></label><label>只读账号<input name="user" autocomplete="off"></label><label>密码<input name="password" type="password" autocomplete="new-password"></label><label>TLS 连接<select name="ssl"><option value="false">关闭（仅受信任网络）</option><option value="on">启用并校验证书</option></select></label></div></div><button class="btn">保存并测试连接</button></form></div><div class="section-title"><h2>数据连接</h2><span class="pill">${sources().length} 个</span></div><div class="card">${sources().length?`<div class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>主机</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${sources().map(v=>`<tr><td><b>${esc(v.name)}</b></td><td>${esc(v.kind)}</td><td>${esc(v.host||'本地演示')}</td><td>${esc(v.created_at)}</td><td><button class="btn secondary sm" data-action="source-preview" data-id="${esc(v.id)}">连接 / 元数据 / 预览</button></td></tr>`).join('')}</tbody></table></div>`:noData('还没有配置数据源')}</div><div id="source-preview" class="section"></div>`);}
function datasetsPage(){const src=sources();shell(`${title('SEMANTIC LAYER','数据集与指标',state.user.role!=='viewer'?'<button class="btn" data-action="toggle-dataset-form">+ 新建数据集</button>':'')}<div class="notice">直连数据集从真实数据库的元数据建立，自动识别维度和数值 SUM 指标；只读查询不执行任意 SQL。暂不提供关联建模或 ETL。管理员可配置各角色的数据权限和强制行过滤。</div><div class="card form section hidden" id="dataset-form"><h3>数据集定义</h3><form id="create-dataset" class="stack"><div class="form-row"><label>数据集名称<input name="name" required placeholder="订单分析"></label><label>数据源<select name="datasourceId" id="dataset-source" required>${src.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label></div><div class="form-row hidden" id="dataset-external-select"><label>数据库 Schema<input name="schema" id="model-schema" readonly></label><label>源数据表<select id="model-table" name="table"></select></label></div><button class="btn" ${src.length?'':'disabled'}>创建数据集</button></form></div><div class="grid section">${datasets().length?datasets().map(d=>`<div class="card"><div class="row spaced"><span class="tag blue">Dataset v${d.version}</span><span class="muted tiny">只读</span></div><h3>${esc(d.name)}</h3><p class="muted tiny">维度：${esc(d.dimensions.join('、'))}</p><p class="muted tiny">指标：${esc(d.metrics.join('、'))}</p><div class="row"><button class="btn secondary sm" data-action="preview-dataset" data-id="${esc(d.id)}">预览</button>${state.user.role==='admin'?`<button class="btn secondary sm" data-action="edit-dataset-policy" data-id="${esc(d.id)}">数据权限</button>`:''}</div></div>`).join(''):noData('请先接入数据源并建立数据集')}</div><div id="dataset-preview" class="section"></div><div id="dataset-policy-panel" class="section"></div>`);}
async function refreshDatasetTables(){const target=document.querySelector('#dataset-external-select'),form=document.querySelector('#create-dataset');if(!target||!form)return;const source=state.sources.find(x=>x.id===form.elements.datasourceId.value);if(!source||source.kind==='demo-sqlite'){target.classList.add('hidden');return;}target.classList.remove('hidden');try{const data=await api(`/api/datasources/${encodeURIComponent(source.id)}/schema`);const tableList=data.tables||[];document.querySelector('#model-table').innerHTML=tableList.map(t=>`<option value="${esc(t.name)}" data-schema="${esc(t.schema)}">${esc(t.schema)}.${esc(t.name)}</option>`).join('');document.querySelector('#model-schema').value=tableList[0]?.schema||'';}catch(e){toast(e.message);document.querySelector('#model-table').innerHTML='';}}
function renderDatasetPolicyPanel(){
  const p=state.policyEditor,host=document.querySelector('#dataset-policy-panel');if(!host||!p)return;
  const current=p.roles.find(x=>x.role===p.role),d=p.dataset;
  if(!current)return;
  const check=(name,all,allowed)=>all.map(x=>`<label class="policy-choice"><input type="checkbox" name="${name}" value="${esc(x)}" ${allowed===null||allowed.includes(x)?'checked':''}> ${esc(x)}</label>`).join('');
  host.innerHTML=`<div class="card form"><div class="row spaced"><h3>数据集权限 · ${esc(d.name)}</h3><button class="btn secondary sm" data-action="close-dataset-policy">关闭</button></div><p class="helper">按角色限制访问的维度、指标和行数据；所有过滤条件由服务端参数绑定。权限变更后历史分析结果会隐藏，避免旧作品绕过新策略。</p><form id="save-dataset-policy" class="stack"><div class="form-row"><label>角色<select id="dataset-policy-role" name="role">${['viewer','editor','admin'].map(x=>`<option value="${x}" ${p.role===x?'selected':''}>${({viewer:'只读用户',editor:'编辑者',admin:'管理员'})[x]}</option>`).join('')}</select></label><label>查询权限<select name="canQuery"><option value="true" ${current.canQuery?'selected':''}>允许</option><option value="false" ${!current.canQuery?'selected':''}>禁止</option></select></label></div><div class="form-row"><div><b class="light-title">允许的维度</b><div class="policy-fields">${check('dimension',d.dimensions,current.dimensions)}</div></div><div><b class="light-title">允许的指标</b><div class="policy-fields">${check('metric',d.metrics,current.metrics)}</div></div></div><label>强制行过滤（JSON 数组；例如 [{"field":"region","op":"eq","value":"华东"}]）<textarea name="rowFilters" rows="3">${esc(JSON.stringify(current.rowFilters))}</textarea></label><div class="row"><span class="pill">策略版本 ${current.version}</span><button class="btn">保存权限策略</button></div></form></div>`;
}
function opts(items,selected){return items.map(x=>`<option value="${esc(x)}" ${x===selected?'selected':''}>${esc(({region:'地区',category:'品类',channel:'渠道',order_date:'日期',revenue:'销售额',cost:'成本',quantity:'销售数量',orders:'订单数'})[x]||x)}</option>`).join('');}
function queryPage(){const data=datasets();const d=data[0];shell(`${title('EXPLORE','自助查询分析')}<div class="grid two"><div class="card"><h3>语义查询构建器</h3><p class="helper">不接受任意 SQL。所有列和聚合均按数据集定义编译，所有过滤条件采用参数绑定。</p><form id="query-form" class="form stack"><label>数据集<select name="datasetId" id="query-dataset">${data.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label><div class="form-row"><label>分组维度<select name="dimension">${opts(d?.dimensions||[])}</select></label><label>指标<select name="metric">${opts(d?.metrics||[])}</select></label></div><button class="btn" ${data.length?'':'disabled'}>运行查询 →</button></form></div><div class="card"><h3>执行策略</h3><div class="stack"><div class="notice">✓ 租户和空间隔离在 SQL 层强制生效</div><div class="notice">✓ 维度、指标及过滤条件采用允许列表</div><div class="notice">✓ 查询行数上限 100 行，结果可追溯</div><div class="notice warn">查询使用内置演示库，不是外部数据库的生产查询网关</div></div></div></div><div class="section" id="query-result">${state.query?resultView(state.query):noData('运行查询后显示图表、表格与 SQL')}</div>`);}
function resultView(data){if(!data)return '';const cols=data.columns||[],rows=data.rows||[];return `<div class="grid two"><div class="card"><div class="row spaced"><h3>查询可视化</h3><span class="tag">${rows.length} 行</span></div>${chart(rows,cols[0],cols.at(-1))}</div><div class="card"><h3>结果表格</h3>${table(cols,rows)}</div></div><div class="section card"><div class="row spaced"><h3>生成的只读 SQL</h3><span class="pill">Query ${esc(data.queryId?.slice(0,8))}</span></div><pre class="code">${esc(data.sql)}</pre></div>`;}
function table(cols,rows){return rows.length?`<div class="table-wrap"><table><thead><tr>${cols.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${cols.map(c=>`<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:noData('没有结果');}
function chart(rows,dim,metric){if(!rows.length||!dim||!metric)return noData('暂无图表数据');const max=Math.max(1,...rows.map(r=>Number(r[metric])||0));return `<div class="bars">${rows.slice(0,12).map(r=>`<div class="bar-group"><div class="bar-val">${num(r[metric])}</div><div class="bar" style="height:${Math.max(3,Math.round(145*(Number(r[metric])||0)/max))}px"></div><span class="bar-label" title="${esc(r[dim])}">${esc(r[dim])}</span></div>`).join('')}</div>`;}
function dashboardsPage(){const boards=filterWorkspace(state.dashboards);shell(`${title('DASHBOARDS','仪表板',state.user.role!=='viewer'?'<button class="btn" data-action="toggle-dashboard-form">+ 新建仪表板</button>':'')}<div class="card form hidden section" id="dashboard-form"><form id="create-dashboard" class="row"><input name="name" placeholder="新仪表板名称" required style="max-width:320px"><button class="btn">创建</button></form></div><div class="grid section">${boards.length?boards.map(b=>`<div class="card clickable" data-action="open-dashboard" data-id="${esc(b.id)}"><div class="row spaced"><span class="tag blue">Dashboard</span><span class="pill">v${b.version}</span></div><h3>${esc(b.name)}</h3><p class="muted tiny">${b.widgets.length} 个图表 · ${esc(b.updated_at)}</p><button class="btn secondary sm" data-action="open-dashboard" data-id="${esc(b.id)}">打开编辑器 →</button></div>`).join(''):noData('当前工作空间暂无仪表板')}</div><div id="dashboard-editor" class="section"></div>`);if(state.activeDashboard)openDashboard(state.activeDashboard);}
async function openDashboard(dashboardId){try{const {item:d}=await api(`/api/dashboards/${encodeURIComponent(dashboardId)}`);state.activeDashboard=d.id;let parent=document.querySelector('#dashboard-editor');if(!parent)return;const ds=datasets();parent.innerHTML=`<div class="section-title"><h2>${esc(d.name)} <span class="pill">版本 ${d.version}</span></h2><button class="btn secondary sm" data-action="close-dashboard">收起</button></div><div class="dashboard-cards" id="dashboard-charts">${d.widgets.map(w=>`<div class="card" id="widget-${esc(w.id)}"><div class="row spaced"><h3>${esc(w.title)}</h3><span class="tag blue">${esc(w.chart)}</span></div><div class="skeleton"></div></div>`).join('')||noData('这个仪表板尚未添加图表')}</div>${state.user.role==='viewer'?'':`<div class="card form section"><h3>增加组件</h3><form id="add-widget" class="form-row"><label>组件标题<input name="title" value="新的销售图表" required></label><label>数据集<select name="datasetId">${ds.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label><label>分组维度<select name="dimension">${opts(ds[0]?.dimensions||[])}</select></label><label>指标<select name="metric">${opts(ds[0]?.metrics||[])}</select></label><label>图表类型<select name="chart"><option value="bar">柱状图</option><option value="table">明细表</option><option value="line">趋势（当前以柱状形式预览）</option></select></label><button class="btn" ${ds.length?'':'disabled'}>添加并保存</button></form></div>`}`;
  for(const w of d.widgets){const el=document.getElementById(`widget-${w.id}`);if(!el)continue;try{const r=await api('/api/query',{method:'POST',body:{datasetId:w.datasetId,dimensions:[w.dimension],metrics:[w.metric],limit:30}});el.innerHTML=`<div class="row spaced"><h3>${esc(w.title)}</h3><span class="tag blue">${esc(w.chart)}</span></div>${w.chart==='table'?table(r.columns,r.rows):chart(r.rows,w.dimension,w.metric)}`;}catch(e){el.innerHTML=`<p class="error">${esc(e.message)}</p>`;}}
}catch(e){toast(e.message);}}
async function loadSchedules(){
  const data=await api('/api/ai/schedules');
  state.aiSchedules=data.items;
}
function schedulesPage(){
  const data=datasets(),d=data[0];
  const choice=(arr)=>arr.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('');
  let html=title('AUTOMATED INSIGHTS','定时分析');
  html+='<div class="notice">周期性执行受控的只读数据集查询，保存最近 50 次分析结果；不做 ETL、同步或外部推送。服务启动期间自动执行到期任务。</div>';
  html+='<div class="grid two"><div class="card form"><h3>创建定时分析</h3><form id="create-ai-schedule" class="stack">';
  html+='<label>任务名称<input name="title" maxlength="80" required placeholder="每日报表分析"></label>';
  html+='<label>数据集<select id="schedule-dataset" name="datasetId">'+data.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('')+'</select></label>';
  html+='<div class="form-row"><label>维度<select id="schedule-dimension" name="dimension"><option value="">不分组</option>'+choice(d?.dimensions||[])+'</select></label>';
  html+='<label>指标<select id="schedule-metric" name="metric">'+choice(d?.metrics||[])+'</select></label></div>';
  html+='<div class="form-row"><label>筛选字段<select id="schedule-filter" name="filterField"><option value="">无</option>'+choice(d?.dimensions||[])+'</select></label>';
  html+='<label>筛选值（等于）<input name="filterValue" placeholder="可选"></label></div>';
  html+='<label>执行周期<select name="intervalMinutes"><option value="15">15 分钟</option><option value="60">每小时</option><option value="1440" selected>每天</option><option value="10080">每周</option></select></label>';
  html+='<button class="btn" '+(!data.length||state.user.role==='viewer'?'disabled':'')+'>创建任务</button></form></div>';
  html+='<div class="card"><h3>我的任务</h3><div class="list-items section">';
  html+=state.aiSchedules.map(x=>{
    const controls='<button class="btn secondary sm" data-action="schedule-history" data-id="'+esc(x.id)+'">历史</button>'+
      (state.user.role==='viewer'?'':('<button class="btn secondary sm" data-action="schedule-run" data-id="'+esc(x.id)+'">立即执行</button>'+
      '<button class="btn secondary sm" data-action="schedule-toggle" data-id="'+esc(x.id)+'" data-version="'+x.version+'" data-enabled="'+x.enabled+'">'+(x.enabled?'暂停':'恢复')+'</button>'));
    return '<div class="item"><div><b>'+esc(x.title)+'</b><div class="tiny muted">'+(x.enabled?'已启用':'暂停')+
      ' · '+x.intervalMinutes+' 分钟/次 · v'+x.version+'<br>下次计划：'+esc(new Date(x.nextRunAt).toLocaleString())+'</div></div><div class="row">'+controls+'</div></div>';
  }).join('')||noData('暂无定时分析任务');
  html+='</div></div></div>';
  html+='<div class="card section"><h3>执行历史</h3>';
  html+=state.aiScheduleRuns?.length?state.aiScheduleRuns.map(r=>
    '<div class="section"><div class="row spaced"><b>'+(r.status==='success'?'✓ 运行成功':'✕ 运行失败')+
    '</b><span class="tiny muted">'+esc(new Date(r.startedAt).toLocaleString())+'</span></div>'+
    (r.summary?'<p class="helper">'+esc(r.summary)+'</p>':'')+
    (r.error?'<p class="helper">'+esc(r.error)+'</p>':'')+
    (r.result?resultView(r.result):'<p class="helper">无可用结果（可能已修改数据权限）。</p>')+'</div>'
  ).join(''):noData('选择任务并点击「历史」');
  html+='</div>';
  shell(html);
}
async function loadAi(){const [sessions,artifacts,topics,canvases]=await Promise.all([api('/api/ai/sessions'),api('/api/ai/artifacts'),api('/api/ai/topics'),api('/api/ai/canvases')]);state.aiSessions=sessions.items;state.aiArtifacts=artifacts.items;state.aiTopics=topics.items;state.aiCanvases=canvases.items;if(state.aiSessionId){const d=await api(`/api/ai/sessions/${encodeURIComponent(state.aiSessionId)}`);state.aiMessages=d.messages;state.aiResult=d.messages.filter(x=>x.role==='assistant').at(-1)||null;}}
function aiPage(){const active=state.aiSessions.find(s=>s.id===state.aiSessionId);shell(`${title('AIPro','AI 原生分析工作台')}<div class="grid two ai-layout"><div class="card"><div class="row spaced"><h3>分析会话</h3><span class="tag blue">${active?esc(active.title):'请选择会话'}</span></div><form id="create-ai-session" class="form stack section"><label>选择数据集<select name="datasetId">${datasets().map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label><label>分析主题（可选）<select name="topicId"><option value="">自由分析</option>${state.aiTopics.filter(t=>t.status==='published').map(t=>`<option value="${esc(t.id)}" data-dataset="${esc(t.dataset_id)}">${esc(t.name)}</option>`).join('')}</select></label><div class="row"><button class="btn" ${datasets().length?'':'disabled'}>+ 新建分析会话</button><span class="helper">会话、结果会持久化</span></div></form><div class="list-items">${state.aiSessions.slice(0,12).map(s=>`<button class="btn secondary sm session-item" data-action="open-ai-session" data-id="${esc(s.id)}">${esc(s.title)} <span class="tiny muted">${esc(s.updated_at)}</span></button>`).join('')||noData('先创建分析会话')}</div><div class="section-title"><h2>对话与追问</h2></div><div class="chat section" id="chat-log">${state.aiMessages.length?state.aiMessages.map(m=>`<div class="bubble ${m.role==='user'?'user':''}">${esc(m.text)}</div>`).join(''):noData('创建会话后开始分析')}</div><form id="ask-ai" class="chat-input"><input name="question" maxlength="500" placeholder="例如：按地区分析销售额；再按品类看成本" required><button class="btn" ${state.aiSessionId?'':'disabled'}>分析 →</button></form></div><div class="card"><div class="row spaced"><h3>查询证据与作品</h3><span class="pill">AIPro · 一期</span></div><div class="notice warn">默认展示确定性分析预览；启用 HARNESS_AGENT_MODE=native 后使用 Harness 原生 bi_catalog / bi_query 工具，模型不获取数据库凭据。请在正式环境配置模型和数据源连接。</div><div class="section" id="ai-chart">${state.aiResult?.result?resultView(state.aiResult.result):noData('分析结果将展示在这里')}</div>${state.aiSessionId&&state.aiResult?`<form id="save-ai-artifact" class="form stack"><label>保存分析作品<input name="name" required value="${esc(active?.title||'分析作品')}"></label><div class="row"><select name="kind"><option value="chart">图表作品</option><option value="report">分析报告</option></select><select name="chart"><option value="bar">柱状图</option><option value="line">折线图</option><option value="table">数据表格</option></select><button class="btn">保存作品</button></div></form>`:''}<div class="section-title"><h2>我的分析作品</h2><span class="pill">${state.aiArtifacts.length}</span></div><div class="list-items">${state.aiArtifacts.map(a=>`<button class="btn secondary sm session-item" data-action="open-ai-artifact" data-id="${esc(a.id)}">${esc(a.name)} · v${a.version}</button>`).join('')||noData('尚未保存作品')}</div><div id="artifact-view" class="section"></div></div></div>`);}
function topicManager(){
  const t=state.aiTopics.find(x=>x.id===state.topicSelectedId);
  if(!t)return '<p class="helper">选择一个主题，管理业务口径知识。</p>';
  const canEdit=state.user.id===t.owner_id&&state.user.role!=='viewer';
  return `<div class="section"><h3>${esc(t.name)} · 知识资料</h3><div class="notice">修改已发布主题将重新转为草稿，原会话不会静默切换到新版本。</div>
    ${canEdit?`<form id="edit-ai-topic" class="form stack"><input type="hidden" name="topicId" value="${esc(t.id)}"><input type="hidden" name="version" value="${t.version}"><label>主题名称<input name="name" required maxlength="80" value="${esc(t.name)}"></label><label>业务说明<textarea name="description" rows="3" maxlength="5000">${esc(t.description)}</textarea></label><button class="btn secondary sm">保存主题草稿</button></form>`:''}
    <div class="list-items section">${state.topicKnowledge.map(k=>`<div class="item"><div><b>${esc(k.title)}</b><div class="item-meta">${esc(k.kind)} · ${esc(k.content)}</div></div>${canEdit?`<button class="btn secondary sm" data-action="delete-ai-knowledge" data-id="${esc(k.id)}" data-topic="${esc(t.id)}" data-version="${t.version}">删除</button>`:''}</div>`).join('')||noData('尚无主题知识') }</div>
    ${canEdit?`<form id="create-ai-knowledge" class="form stack section"><input type="hidden" name="topicId" value="${esc(t.id)}"><input type="hidden" name="version" value="${t.version}"><label>知识类型<select name="kind"><option value="glossary">指标口径</option><option value="rule">业务规则</option><option value="example">分析示例</option></select></label><label>标题<input name="title" maxlength="100" required></label><label>知识内容<textarea name="content" rows="3" maxlength="2000" required></textarea></label><button class="btn">新增知识并保存草稿</button></form>`:''}
  </div>`;
}
function topicsPage(){shell(`${title('AI TOPICS','分析主题',state.user.role!=='viewer'?'<span class="pill">草稿 → 发布</span>':'')}<div class="grid two"><div class="card form"><h3>新建分析主题</h3><p class="helper">主题固定数据集和业务解释说明；发布后用于 AIPro 创建分析会话。</p><form id="create-ai-topic" class="stack"><label>名称<input name="name" required maxlength="80" placeholder="销售经营分析"></label><label>数据集<select name="datasetId">${datasets().map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label><label>业务规则说明<textarea name="description" rows="4" maxlength="5000" placeholder="例如：销售额为订单金额 SUM；仅分析已授权的订单数据"></textarea></label><button class="btn" ${state.user.role==='viewer'||!datasets().length?'disabled':''}>创建草稿</button></form></div><div class="card"><h3>主题列表</h3><div class="list-items section">${state.aiTopics.map(t=>`<div class="item"><div><div class="item-title">${esc(t.name)}</div><div class="item-meta">${esc(t.status)} · v${t.version} · ${esc(t.description)}</div></div><div class="row"><button class="btn secondary sm" data-action="manage-ai-topic" data-id="${esc(t.id)}">管理知识</button>${t.status==='draft'&&t.owner_id===state.user.id&&state.user.role!=='viewer'?`<button class="btn secondary sm" data-action="publish-ai-topic" data-id="${esc(t.id)}" data-version="${t.version}">发布</button>`:''}</div></div>`).join('')||noData('暂无分析主题')}</div><div id="topic-knowledge-panel">${topicManager()}</div></div></div>`);}
function canvasEditor(){
  if(!state.aiCanvas)return noData('选择或创建画布以编辑');
  const c=state.aiCanvas;
  const maxY=Math.max(10,...c.layout.map(v=>v.y+v.h+2));
  return `<div class="notice">${esc(c.name)} · 版本 ${c.version}。可拖动作品、拖拽右下角调整尺寸，自动保存布局；缩放不会修改作品内容。</div>
    <form id="add-canvas-item" class="form row section"><select name="artifactId">${state.aiArtifacts.filter(a=>a.session_id===c.sessionId).map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><button class="btn" ${state.aiArtifacts.some(a=>a.session_id===c.sessionId)?'':'disabled'}>添加作品</button></form>
    <div class="row spaced"><span class="tiny muted">网格 24 列 · ${c.layout.length} 个作品</span><div class="row"><button class="btn secondary sm" data-action="canvas-zoom-out">－</button><span class="tiny">${Math.round(state.canvasZoom*100)}%</span><button class="btn secondary sm" data-action="canvas-zoom-in">＋</button></div></div>
    <div class="canvas-viewport"><div class="canvas-surface" style="zoom:${state.canvasZoom};height:${Math.max(480,maxY*40)}px">${c.layout.map((v,i)=>`<div class="canvas-item" data-canvas-index="${i}" style="left:${v.x*40}px;top:${v.y*40}px;width:${v.w*40-6}px;height:${v.h*40-6}px"><div class="row spaced canvas-handle" data-canvas-drag="${i}"><b>${esc(state.aiArtifacts.find(a=>a.id===v.artifactId)?.name||`作品 ${i+1}`)}</b><button class="btn secondary sm" data-action="remove-canvas-item" data-index="${i}">×</button></div><span class="tiny muted">可拖拽移动 · v${c.version}</span><button class="canvas-resize" data-canvas-resize="${i}" title="拖动调整大小" aria-label="调整作品大小"></button></div>`).join('')||'<div class="canvas-empty">画布为空，先添加一个已保存的分析作品</div>'}</div></div>`;
}
function canvasPage(){shell(`${title('AI WORKSPACE','分析画布')}<div class="grid two canvas-layout"><div class="card"><h3>从分析会话创建画布</h3><form id="create-ai-canvas" class="form stack"><label>画布名称<input name="name" required placeholder="本月业务分析"></label><label>分析会话<select name="sessionId">${state.aiSessions.map(x=>`<option value="${esc(x.id)}">${esc(x.title)}</option>`).join('')}</select></label><button class="btn" ${state.aiSessions.length?'':'disabled'}>新建画布</button></form><div class="section-title"><h2>已保存画布</h2></div><div class="list-items">${state.aiCanvases.map(c=>`<button class="btn secondary sm session-item" data-action="open-ai-canvas" data-id="${esc(c.id)}">${esc(c.name)} · v${c.version}</button>`).join('')||noData('暂无画布')}</div></div><div class="card"><h3>画布编辑器</h3>${canvasEditor()}</div></div>`);}
async function saveCanvasLayout(layout){
  const c=state.aiCanvas;
  if(!c)return;
  const r=await api(`/api/ai/canvases/${encodeURIComponent(c.id)}`,{method:'PATCH',body:{version:c.version,layout}});
  state.aiCanvas={...c,layout,version:r.version};
  canvasPage();
}
let pointerMove=null;
app.addEventListener('pointerdown',e=>{
  const handle=e.target.closest('[data-canvas-drag],[data-canvas-resize]');
  if(!handle||e.target.closest('[data-action]')||!state.aiCanvas)return;
  if(e.button!==0)return;
  const resize=handle.hasAttribute('data-canvas-resize');
  const index=Number(resize?handle.dataset.canvasResize:handle.dataset.canvasDrag);
  const initial=state.aiCanvas.layout[index];
  const node=handle.closest('[data-canvas-index]');
  if(!initial||!node)return;
  e.preventDefault();
  const startX=e.clientX,startY=e.clientY,zoom=state.canvasZoom;
  pointerMove={index,resize,initial:{...initial},node,startX,startY,zoom};
  handle.setPointerCapture(e.pointerId);
});
app.addEventListener('pointermove',e=>{
  if(!pointerMove)return;
  const p=pointerMove,dx=Math.round((e.clientX-p.startX)/(40*p.zoom)),dy=Math.round((e.clientY-p.startY)/(40*p.zoom));
  const next=p.resize?{...p.initial,w:Math.max(1,Math.min(24-p.initial.x,p.initial.w+dx)),h:Math.max(1,Math.min(48,p.initial.h+dy))}:{...p.initial,x:Math.max(0,Math.min(24-p.initial.w,p.initial.x+dx)),y:Math.max(0,Math.min(10000,p.initial.y+dy))};
  p.next=next;
  p.node.style.left=`${next.x*40}px`;
  p.node.style.top=`${next.y*40}px`;
  p.node.style.width=`${next.w*40-6}px`;
  p.node.style.height=`${next.h*40-6}px`;
});
app.addEventListener('pointerup',async()=>{
  if(!pointerMove)return;
  const p=pointerMove;pointerMove=null;
  if(!p.next||JSON.stringify(p.next)===JSON.stringify(p.initial))return;
  const layout=state.aiCanvas.layout.map((v,i)=>i===p.index?p.next:v);
  try{await saveCanvasLayout(layout);}catch(e){toast(e.message);canvasPage();}
});
app.addEventListener('pointercancel',()=>{if(pointerMove){pointerMove=null;canvasPage();}});
function auditPage(){shell(`${title('GOVERNANCE','权限与操作审计')}<div class="grid two"><div class="card"><h3>当前身份</h3><div class="stack"><div class="notice">租户：${esc(state.user.tenantName)}</div><div class="notice">用户：${esc(state.user.email)}</div><div class="notice">角色：${esc(state.user.role)}</div></div></div><div class="card"><h3>系统边界</h3><p class="helper">全部资源查询服务端强制 tenant_id，查询同时绑定 workspace_id，操作需校验 Session、角色和 CSRF token。现已支持数据集角色授权、维度和指标白名单、强制行过滤。用户级资源 ACL、SSO 和企业级细粒度策略仍待建设。</p></div></div><div class="section card"><h3>最近操作</h3><div id="audit-log" class="skeleton"></div></div>`);api('/api/audit').then(x=>{const el=document.querySelector('#audit-log');if(el)el.innerHTML=table(['created_at','action','resource_type','resource_id'],x.items);}).catch(e=>{const el=document.querySelector('#audit-log');if(el)el.textContent=e.message;});}
function render(){if(!state.user){loginPage();return;}({home,sources:sourcesPage,datasets:datasetsPage,query:queryPage,dashboards:dashboardsPage,aipro:aiPage,topics:topicsPage,canvas:canvasPage,schedules:schedulesPage,audit:auditPage}[state.page]||home)();}
function loginPage(){app.innerHTML=`<div class="login-bg"><div class="login-card"><div class="brand-icon">I</div><h1>登录 Insight BI</h1><p>为数据团队打造的统一 BI 与智能分析平台。</p><form class="form" id="login-form"><label>邮箱<input type="email" name="email" placeholder="name@company.com" required autocomplete="username"></label><label>密码<input type="password" name="password" required autocomplete="current-password"></label><button class="btn">登录工作台 →</button></form><div class="notice warn section">仅当服务以 DEMO_MODE=1 启动时，可用 admin@demo.local / DemoOnly!2026 登录。正式环境请设置 BOOTSTRAP_EMAIL 和 BOOTSTRAP_PASSWORD。</div></div></div>`;}
const actionHandlers={
  navigate:async b=>{state.page=b.dataset.page;state.activeDashboard=null;if(['aipro','topics','canvas'].includes(state.page))await loadAi();if(state.page==='schedules')await loadSchedules();render();},
  logout:async()=>{await api('/api/logout',{method:'POST'});state.user=null;render();},
  'schedule-history':async button=>{
    const data=await api('/api/ai/schedules/'+encodeURIComponent(button.dataset.id)+'/runs');
    state.aiScheduleRuns=data.items;schedulesPage();
  },
  'schedule-run':async button=>{
    const id=encodeURIComponent(button.dataset.id);
    const response=await api('/api/ai/schedules/'+id+'/run',{method:'POST',body:{}});
    await loadSchedules();
    state.aiScheduleRuns=(await api('/api/ai/schedules/'+id+'/runs')).items;
    schedulesPage();toast(response.run.status==='success'?'分析已执行':('运行失败：'+response.run.error));
  },
  'schedule-toggle':async button=>{
    const id=encodeURIComponent(button.dataset.id);
    await api('/api/ai/schedules/'+id,{method:'PATCH',body:{version:Number(button.dataset.version),enabled:button.dataset.enabled!=='true'}});
    await loadSchedules();schedulesPage();toast('任务状态已更新');
  },
  'canvas-zoom-in':()=>{state.canvasZoom=Math.min(1.5,Math.round((state.canvasZoom+0.25)*100)/100);canvasPage();},
  'canvas-zoom-out':()=>{state.canvasZoom=Math.max(0.5,Math.round((state.canvasZoom-0.25)*100)/100);canvasPage();},
  'toggle-source-form':()=>document.querySelector('#source-form')?.classList.toggle('hidden'),
  'toggle-dataset-form':()=>document.querySelector('#dataset-form')?.classList.toggle('hidden'),
  'close-dataset-policy':()=>{state.policyEditor=null;document.querySelector('#dataset-policy-panel').innerHTML='';},
  'edit-dataset-policy':async b=>{const d=state.datasets.find(x=>x.id===b.dataset.id);if(!d)throw new Error('没有该数据集');const r=await api(`/api/datasets/${encodeURIComponent(d.id)}/policies`);state.policyEditor={dataset:d,role:'viewer',roles:r.items};renderDatasetPolicyPanel();document.querySelector('#dataset-policy-panel')?.scrollIntoView({behavior:'smooth',block:'nearest'});},
  'toggle-dashboard-form':()=>document.querySelector('#dashboard-form')?.classList.toggle('hidden'),
  'source-preview':async b=>{const sid=encodeURIComponent(b.dataset.id);const [check,metadata,preview]=await Promise.all([api(`/api/datasources/${sid}/test`),api(`/api/datasources/${sid}/schema`),api(`/api/datasources/${sid}/preview`)]);document.querySelector('#source-preview').innerHTML=`<div class="card"><h3>连接测试 ${check.ok?'✓ 成功':''}</h3><p class="helper">可用表：${metadata.tables.map(t=>esc((t.schema||'')+'.'+t.name)).join('、')}</p>${table(preview.columns,preview.rows)}</div>`;},
  'preview-dataset':async b=>{const r=await api(`/api/datasets/${b.dataset.id}/preview`);document.querySelector('#dataset-preview').innerHTML=resultView(r);},
  'open-dashboard':async b=>{state.page='dashboards';state.activeDashboard=b.dataset.id;render();},
  'close-dashboard':()=>{state.activeDashboard=null;document.querySelector('#dashboard-editor').innerHTML='';},
  'open-ai-session':async b=>{state.aiSessionId=b.dataset.id;await loadAi();aiPage();},
  'open-ai-artifact':async b=>{
    const {item}=await api(`/api/ai/artifacts/${encodeURIComponent(b.dataset.id)}`);
    state.aiArtifactDetail=item;
    const el=document.querySelector('#artifact-view');
    if(el)el.innerHTML=`<div class="notice">${esc(item.name)} · ${esc(item.content.summary)}</div>${resultView(item.content.result)}<div class="row section"><a class="btn secondary sm" download href="/api/ai/artifacts/${encodeURIComponent(item.id)}/export?format=csv">下载 CSV</a><a class="btn secondary sm" download href="/api/ai/artifacts/${encodeURIComponent(item.id)}/export?format=md">下载 Markdown</a><a class="btn secondary sm" download href="/api/ai/artifacts/${encodeURIComponent(item.id)}/export?format=json">下载 JSON</a></div><form id="edit-ai-artifact" class="form row section"><input type="hidden" name="id" value="${esc(item.id)}"><input type="hidden" name="version" value="${item.version}"><label>作品名称<input name="name" required maxlength="80" value="${esc(item.name)}"></label><label>图表样式<select name="chart">${['bar','line','table'].map(k=>`<option value="${k}" ${k===item.content.chart?'selected':''}>${({bar:'柱状图',line:'折线图',table:'数据表格'})[k]}</option>`).join('')}</select></label><button class="btn">保存编辑</button></form>`;
  },
  'manage-ai-topic':async b=>{const id=b.dataset.id;const r=await api(`/api/ai/topics/${encodeURIComponent(id)}`);state.topicSelectedId=id;state.topicKnowledge=r.item.knowledge;topicsPage();},
  'delete-ai-knowledge':async b=>{await api(`/api/ai/topics/${encodeURIComponent(b.dataset.topic)}/knowledge/${encodeURIComponent(b.dataset.id)}`,{method:'DELETE',body:{version:Number(b.dataset.version)}});await loadAi();const r=await api(`/api/ai/topics/${encodeURIComponent(b.dataset.topic)}`);state.topicKnowledge=r.item.knowledge;topicsPage();toast('知识已删除，主题需重新发布');},
  'publish-ai-topic':async b=>{await api(`/api/ai/topics/${encodeURIComponent(b.dataset.id)}/publish`,{method:'POST',body:{version:Number(b.dataset.version)}});await loadAi();topicsPage();toast('主题已发布');},
  'open-ai-canvas':async b=>{const {item}=await api(`/api/ai/canvases/${encodeURIComponent(b.dataset.id)}`);state.aiCanvas=item;canvasPage();},
  'remove-canvas-item':async b=>{const c=state.aiCanvas;const layout=c.layout.filter((_,i)=>i!==Number(b.dataset.index));const r=await api(`/api/ai/canvases/${encodeURIComponent(c.id)}`,{method:'PATCH',body:{version:c.version,layout}});state.aiCanvas={...c,layout,version:r.version};canvasPage();}
};
app.addEventListener('click',async e=>{const el=e.target.closest('[data-action]');if(!el)return;const fn=actionHandlers[el.dataset.action];if(!fn)return;e.preventDefault();try{await fn(el);}catch(err){toast(err.message);}});
app.addEventListener('change',e=>{if(e.target.id==='source-kind'){document.querySelector('#external-fields')?.classList.toggle('hidden',e.target.value==='demo-sqlite');}if(e.target.id==='dataset-source'){refreshDatasetTables();}if(e.target.id==='model-table'){document.querySelector('#model-schema').value=e.target.selectedOptions[0]?.dataset.schema||'';}if(e.target.id==='dataset-policy-role'&&state.policyEditor){state.policyEditor.role=e.target.value;renderDatasetPolicyPanel();}if(e.target.id==='workspace'){state.workspaceId=e.target.value;state.activeDashboard=null;render();}if(e.target.id==='schedule-dataset'){
  const d=state.datasets.find(x=>x.id===e.target.value);
  const dim=document.querySelector('#schedule-dimension'),met=document.querySelector('#schedule-metric'),filter=document.querySelector('#schedule-filter');
  if(d&&dim&&met&&filter){const choices=xs=>xs.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('');dim.innerHTML='<option value="">不分组</option>'+choices(d.dimensions);met.innerHTML=choices(d.metrics);filter.innerHTML='<option value="">无</option>'+choices(d.dimensions);}
}if(e.target.id==='query-dataset'){const d=state.datasets.find(x=>x.id===e.target.value),form=document.querySelector('#query-form');if(d){form.elements.dimension.innerHTML=opts(d.dimensions);form.elements.metric.innerHTML=opts(d.metrics);}}});
app.addEventListener('submit',async e=>{
  const form=e.target;if(!form.id)return;e.preventDefault();const b=Object.fromEntries(new FormData(form));
  try{
    if(form.id==='login-form'){
      const d=await api('/api/login',{method:'POST',body:b});state.user=d.user;await load();render();return;
    }
    if(form.id==='create-source')await api('/api/datasources',{method:'POST',body:{...b,workspaceId:wp()}});
    if(form.id==='create-dataset')await api('/api/datasets',{method:'POST',body:b});
    if(form.id==='save-dataset-policy'){
      const p=state.policyEditor,d=p.dataset,current=p.roles.find(r=>r.role===p.role);
      const selected=n=>[...new FormData(form).getAll(n)];
      const dimensions=selected('dimension'),metrics=selected('metric');
      const payload={role:p.role,version:current.version,canQuery:b.canQuery==='true',
        dimensions:dimensions.length===d.dimensions.length?null:dimensions,
        metrics:metrics.length===d.metrics.length?null:metrics,
        rowFilters:JSON.parse(b.rowFilters||'[]')};
      const changed=await api(`/api/datasets/${encodeURIComponent(d.id)}/policies`,{method:'PATCH',body:payload});
      p.roles=p.roles.map(r=>r.role===p.role?changed.item:r);
      renderDatasetPolicyPanel();toast('数据权限策略已更新');return;
    }
    if(form.id==='create-dashboard')await api('/api/dashboards',{method:'POST',body:{...b,workspaceId:wp()}});
    if(form.id==='query-form'){state.query=await api('/api/query',{method:'POST',body:{datasetId:b.datasetId,dimensions:[b.dimension],metrics:[b.metric],limit:50}});render();return;}
    if(form.id==='add-widget'){
      const d=state.dashboards.find(x=>x.id===state.activeDashboard);if(!d)throw new Error('找不到仪表板');
      const result=await api(`/api/dashboards/${d.id}`,{method:'PATCH',body:{version:d.version,widgets:[...d.widgets,{...b}]}});
      toast('图表已保存 v'+result.version);
    }
    if(form.id==='create-ai-schedule'){
      const spec={datasetId:b.datasetId,dimensions:b.dimension?[b.dimension]:[],metrics:[b.metric],
        filters:b.filterField&&b.filterValue?[{field:b.filterField,op:'eq',value:b.filterValue}]:[],limit:30};
      await api('/api/ai/schedules',{method:'POST',body:{datasetId:b.datasetId,title:b.title,intervalMinutes:Number(b.intervalMinutes),spec}});
      await loadSchedules();state.aiScheduleRuns=null;schedulesPage();toast('定时分析任务已创建');return;
    }
    if(form.id==='create-ai-session'){
      if(!b.topicId)delete b.topicId;else{const topic=state.aiTopics.find(t=>t.id===b.topicId);b.datasetId=topic.dataset_id;}
      const created=await api('/api/ai/sessions',{method:'POST',body:b});state.aiSessionId=created.id;await loadAi();aiPage();toast('分析会话已创建');return;
    }
    if(form.id==='ask-ai'){
      const result=await api(`/api/ai/sessions/${encodeURIComponent(state.aiSessionId)}/ask`,{method:'POST',body:{question:b.question}});
      await loadAi();aiPage();return;
    }
    if(form.id==='edit-ai-topic'){
      await api(`/api/ai/topics/${encodeURIComponent(b.topicId)}`,{method:'PATCH',body:{version:Number(b.version),name:b.name,description:b.description}});
      await loadAi();state.topicKnowledge=(await api(`/api/ai/topics/${encodeURIComponent(b.topicId)}`)).item.knowledge;topicsPage();toast('主题已保存为草稿');return;
    }
    if(form.id==='create-ai-knowledge'){
      await api(`/api/ai/topics/${encodeURIComponent(b.topicId)}/knowledge`,{method:'POST',body:{kind:b.kind,title:b.title,content:b.content,version:Number(b.version)}});
      await loadAi();state.topicKnowledge=(await api(`/api/ai/topics/${encodeURIComponent(b.topicId)}`)).item.knowledge;topicsPage();toast('知识已保存，主题需重新发布');return;
    }
    if(form.id==='create-ai-topic'){
      await api('/api/ai/topics',{method:'POST',body:b});await loadAi();topicsPage();toast('主题草稿已创建');return;
    }
    if(form.id==='create-ai-canvas'){
      const result=await api('/api/ai/canvases',{method:'POST',body:b});const {item}=await api(`/api/ai/canvases/${result.id}`);state.aiCanvas=item;await loadAi();canvasPage();toast('画布已创建');return;
    }
    if(form.id==='add-canvas-item'){
      const c=state.aiCanvas,baseY=Math.max(0,...c.layout.map(v=>v.y+v.h));
      const layout=[...c.layout,{artifactId:b.artifactId,x:0,y:baseY,w:12,h:4}];
      const result=await api(`/api/ai/canvases/${c.id}`,{method:'PATCH',body:{version:c.version,layout}});
      state.aiCanvas={...c,layout,version:result.version};canvasPage();toast('作品已加入画布');return;
    }
    if(form.id==='edit-ai-artifact'){
      await api(`/api/ai/artifacts/${encodeURIComponent(b.id)}`,{method:'PATCH',body:{version:Number(b.version),name:b.name,chart:b.chart}});
      await loadAi();aiPage();
      await actionHandlers['open-ai-artifact']({dataset:{id:b.id}});
      toast('作品更新已保存');return;
    }
    if(form.id==='save-ai-artifact'){
      await api('/api/ai/artifacts',{method:'POST',body:{sessionId:state.aiSessionId,name:b.name,kind:b.kind,chart:b.chart}});
      await loadAi();aiPage();toast('分析作品已保存');return;
    }
    await load();render();toast('已保存');
  }catch(err){toast(err.message);}
});
(async()=>{try{const me=await api('/api/me');state.user=me.user;await load();}catch{state.user=null;}render();})();

