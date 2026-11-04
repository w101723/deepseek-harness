# Insight BI · Quick BI + AIPro 全平台复刻（工程基础版）

> 项目按 `quickbi_full_rebuild_control_matrix_v1.xlsx` 与 `quickbi_full_rebuild_blueprint_v1.md` 开发。本仓库的代码是 **M0/M1 可运行切片**，**不是** 343 项功能已经完成，也非阿里云官方产品。遵守独立实现，不包含 Quick BI 专有代码、品牌资源或私有接口。

## 已实现且可实际操作

- 真实邮箱密码登录（scrypt 存储）/ HttpOnly session / 服务端退出 / CSRF / Origin 校验 / 登录限流；
- 租户、成员、角色基础（admin/editor/viewer）、租户切换校验、工作空间创建；
- 持久化 SQLite 业务模型、操作审计、演示销售数据；
- 数据源列表、新建、连接测试、Schema 发现、数据预览（当前**仅 demo-sqlite**）；
- 数据集定义、版本初始值、维度/指标白名单、数据集预览；
- 统一 QuerySpec、服务端只读 SQL 编译、参数绑定、tenant_id/workspace_id 查询范围限制、查询历史、行数限制；
- 仪表板创建、组件保存、版本冲突保护、数据驱动的图表/表格；
- 自然语言意图的确定性原型（**不是大模型问数**）；可选 `DeepSeekHarness` SDK 负责解释**已验证**的结构化结果；
- 单页管理工作台以及自动化 API/权限负例测试。

## 启动

需要 Node.js >= 22.14（使用内置 `node:sqlite`，此接口在 Node 22 仍标记为 experimental）。

```bash
cd integrations/quickbi-platform
# 内置演示数据，不对公网提供服务
DEMO_MODE=1 npm start
# 打开 http://127.0.0.1:3088
# 演示账号：admin@demo.local / DemoOnly!2026
npm test
```

非演示首次启动：

```bash
BOOTSTRAP_EMAIL=admin@example.com \
BOOTSTRAP_PASSWORD='a-unique-long-secret-value' \
DB_PATH=./data/quickbi.sqlite npm start
```

重启后无需重复配置初始账号。生产部署还须加 HTTPS/可信代理、会话管理、监控、持久化数据库、加密凭据、精细 ACL、逐租户计算隔离、速率/成本配额、SSO、安全审计和渗透测试；当前**不建议生产部署**。

## Harness 集成边界

`src/harness.mjs` 使用 DeepSeek 官方 `@deepseek-ai/dsh-sdk-client` 的 `DeepSeekHarness({ profile: 'sdk-minimal', dshHome })`；默认关闭。启用前必须安装与所使用 Harness 运行时匹配的 SDK、配置模型凭据，并隔离进程与工作目录。AI 不接触数据连接器凭据；业务服务先生成受控 `QuerySpec`、执行并校验，再将最多 30 行的结果交给 Harness 做自然语言解读。

当前不提供 Harness 的实时多会话治理、插件审批或托管数据访问，因此不得把此模块声明为完成的 AIPro Agent 引擎。后续按设计文档扩展专用 BI Tools、Skill、MCP 和独立的 Agent Runtime 服务。

## HTTP 接口

| 功能 | 路由 |
|---|---|
| 健康检查 | `GET /api/health` |
| 认证 | `POST /api/login`, `GET /api/me`, `POST /api/logout` |
| 租户与工作空间 | `GET /api/tenants`, `POST /api/tenant/switch`, `GET/POST /api/workspaces` |
| 数据源 | `GET/POST /api/datasources`, `GET /api/datasources/:id/{test,schema,preview}` |
| 语义数据集 | `GET/POST /api/datasets`, `GET /api/datasets/:id/preview` |
| 查询 | `POST /api/query`, `GET /api/query/history` |
| 仪表板 | `GET/POST /api/dashboards`, `GET/PATCH /api/dashboards/:id` |
| 分析 | `POST /api/ai/ask` |
| 治理 | `GET /api/audit`, `GET /api/search?q=` |

JSON 修改请求除登录外需携带来自 `/api/me` 的 `x-csrf-token`，所有资源 ID 在服务端重新验证所属租户。查询请求示例：

```json
{"datasetId":"<你的数据集 ID>","dimensions":["region"],"metrics":["revenue"],"filters":[{"field":"region","op":"eq","value":"华东"}],"limit":20}
```

## 本次边界与下一步

`docs/IMPLEMENTATION.md` 维护与功能台账 ID 对应的实现范围。M0-01/M0-04/M0-05 的基础能力、M1 的只读查询最小闭环属于本批；OIDC、细粒度 ACL、外部数据连接器、表关系建模、完整传统 BI 编辑器、AIPro 无限画布等尚未开发。不要将示例 UI 当成“156 个页面已复刻”。