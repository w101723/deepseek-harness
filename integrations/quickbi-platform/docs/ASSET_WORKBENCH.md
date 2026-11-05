# Phase 1 · 数据源和数据集工作台（2026-11-05）

本批优先实现用户提供的 Quick BI 两类页面的**功能流程**，不是复制其商标、专有代码或 1:1 视觉素材。ETL 不在范围内。

## 数据源管理

- 左侧「我的数据源」列表与「模板数据源」（仅本系统内置的 `demo-sqlite` 样例源，**不是** Quick BI 模板市场）选项卡；名称搜索、连接元数据。
- 右侧按源检索真实 `information_schema.tables`，服务端搜索/分页（默认 15 条/页）、排序；单独发现被选中表的字段和只读预览。
- 新建直连 PostgreSQL/MySQL/TiDB/StarRocks、测试连接；重命名与备注（乐观锁）、删除（被数据集引用时返回 409）。
- 不在浏览器展示连接口令；管理操作必须属于当前租户，写入角色为 editor/admin，源密码由原服务 AES-GCM 加密存储。
- SQL 创建数据集采用受限语法 `SELECT col[, col] FROM schema.table`。只在元数据中验证表和列，生成普通受控语义数据集，**不执行输入的 SQL 原文**。不支持 JOIN、WHERE、CTE、表达式、任意 SQL 自由查询。

## 数据集管理

- 工作空间级目录树：根目录、子文件夹、目录更名/移动/删除空文件夹，拒绝自循环和子循环。
- 数据集表格：名称、类型、所有者、修改者、修改时间、数据源；名称搜索、按创建时间/最近修改/名称排序、仅查看我创建的。
- 从数据表/SQL 创建；数据集重命名、移动（限当前工作空间）、复制、删除；更新使用版本检查；删除前检查分析会话/主题、调度、查询历史和看板引用，拒绝级联破坏已存在的分析证据。
- 现有数据集和数据源的元数据在升级时回填，不修改原始对象 ID 或已存数据；原有查询和 AIPro 仍调用相同 `QuerySpec`。
- viewer 可读取当前租户**已授权**的数据集，文件夹清单只包含其能看到的数据集的路径，不能修改资源。完整用户组 ACL 仍另行规划。

## API

- `GET/POST /api/assets/folders`；`PATCH/DELETE /api/assets/folders/:id`
- `GET /api/assets/datasets`；`POST /api/assets/datasets/table`、`POST /api/assets/datasets/sql`
- `PATCH/DELETE /api/assets/datasets/:id`；`POST /api/assets/datasets/:id/duplicate`
- `GET /api/assets/sources`；`PATCH/DELETE /api/assets/sources/:id`
- `GET /api/assets/sources/:id/tables?page=1&pageSize=15&q=...&sort=name`
- `GET /api/assets/sources/:id/preview?schema=...&table=...`

所有变更 API 走现有登录会话、CSRF、Origin 校验、审计。SQL 数据集定义有特定语法限制，不等价于无限制的 SQL 数据集设计器。

## 验证与限制

- `npm test` 包含新增 `test/asset-workbench.test.mjs`，校验目录循环、跨租户、viewer 拒绝、版本冲突、受限 SQL、预览与引用删除保护。
- GitHub Actions 的 PostgreSQL 16/MySQL 8.4 实库集成作业继续沿用，并新增真实表索引与 SQL 数据集路径测试（如已在对应测试文件中合入）。
- 大型库的表浏览采用服务端分页；表数量 `COUNT(*)` 每页查询，后续可按实际性能添加缓存与更复杂 Schema 过滤。只读列预览仍有 15 行限制。
- 编辑现有连接的主机/用户/密码、跨工作空间转移、完整 SQL 建模、文件夹权限继承、表级分页权限配置均不在本批验收范围。