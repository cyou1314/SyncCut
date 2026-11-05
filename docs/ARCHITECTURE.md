# SyncCut 技术架构（飞书优先）

## 1. 总体结构

```text
Feishu Bitable (team source of truth)
  ├─ Projects / episodes / scenes
  ├─ Music / SFX / voice / ambience rows
  ├─ Audio attachments
  ├─ Timeline placement fields
  └─ Workflow: record added/updated -> HTTP request
                    |
                    v
SyncCut Control Plane (Node.js + PostgreSQL)
  ├─ Feishu tenant connections and encrypted credentials
  ├─ Webhook inbox + idempotency
  ├─ Bitable record/attachment adapter
  ├─ Normalized asset/version index
  ├─ Sync job queue + audit log
  └─ Tenant / member / device authorization
                    |
                    v
SyncCut macOS Agent
  ├─ Device pairing and tenant binding
  ├─ Job polling / download / retry
  ├─ SHA-256 verification and content cache
  ├─ Jianying media import adapter
  └─ Jianying timeline adapter (project copy only)
                    |
                    v
              Jianying for Mac
```

## 2. 产品边界

### 飞书负责

- 团队身份、成员协作和日常素材管理。
- 多维表格中的项目、集数、场景、镜头、素材类型、标签、备注。
- 音频附件和时间轴套用参数。
- 记录新增/修改后的自动化触发。

### SyncCut 负责

- 飞书连接和授权凭证生命周期。
- 将飞书记录映射为稳定的素材/版本模型。
- 处理变更通知、去重、重试和补偿同步。
- Mac 设备配对、租户隔离和任务分发。
- 本地缓存、哈希校验和剪映自动化。
- 提供轻量控制台：连接状态、设备、同步任务、错误日志、字段映射。

SyncCut 不再复制开发一套飞书文档编辑器或通用在线素材表格。

## 3. 数据所有权

**飞书多维表格是团队业务数据的唯一主数据源。**

SyncCut PostgreSQL 只保存运行所需的控制面和派生索引：
- Feishu tenant / connection / Base / table 映射；
- Feishu record_id 与 SyncCut asset_id 的映射；
- 已观察到的附件版本、file_token、SHA-256、元数据；
- Mac 设备、同步任务、事件收件箱和审计日志。

不得把 SyncCut 缓存索引当作飞书数据的权威副本。用户在飞书删除或修改记录后，SyncCut 根据同步策略更新索引；已被剪映工程引用的本地文件不自动删除。

## 4. 多租户模型

- `tenant`：一个接入 SyncCut 的飞书企业/团队。
- `feishu_connection`：租户授权的应用身份、Base、table、字段映射和 Webhook secret。
- `tenant_member`：飞书用户在该租户中的身份与 SyncCut 角色。
- `device`：绑定租户的 Mac 助手设备。
- `sync_job`：必须绑定 tenant_id、connection_id 和 device_id。
- `asset` / `asset_version`：通过 connection_id + record_id 对应飞书记录。

所有数据库读写必须从已验证的登录态或设备令牌解析 tenant_id，禁止接受客户端任意指定 tenant_id 后直接查询。数据库不向浏览器或 Mac 直接开放。

### 接入阶段

**阶段一：单企业试点**
- 使用飞书企业自建应用。
- 在飞书开发者后台开通所需多维表格和云空间权限。
- 对目标 Base 将应用添加为文档应用并授予所需权限。
- 使用服务端应用凭证获取并缓存当前租户访问令牌。

**阶段二：多企业接入**
- 将飞书集成升级为应用商店应用/适用的跨租户安装模式。
- 每个租户独立安装、授权和绑定自己的 Base。
- 为每个租户单独维护令牌、事件密钥、设备和数据范围。
- 完成飞书应用审核、权限范围说明和跨租户安全测试后，才开放其他团队注册。

不要把单企业自建应用的 tenant_access_token 当作可跨企业使用的全局 Token。

## 5. 飞书认证与凭证

- App ID / App Secret 只保存在服务端环境或密钥管理系统。
- 初始自建应用使用飞书当前文档推荐的应用身份凭证流程；Token 缓存时间必须读取响应中的 expires_in，不能硬编码。
- Bitable API 的访问身份必须对目标 Base 具有文档权限。对于非应用自有资源，需要按飞书文档要求将应用加入目标 Base，或使用经用户授权的身份。
- 凭证落库前使用 AES-256-GCM 等认证加密；数据库仅存密文、nonce 和 tag。
- 不在日志、前端、Mac 配置文件或 Git 仓库中输出 App Secret、Access Token、Refresh Token。

## 6. 同步策略

### 初始全量同步

1. 管理员在 SyncCut 绑定 Base 的 app_token、table_id 和字段映射。
2. SyncCut 分页读取记录。
3. 解析素材类型、项目、集数、场景、镜头、附件和时间轴参数。
4. 为每条记录创建或更新内部索引。
5. 下载附件时记录 file_token、文件名、大小、MIME 和 SHA-256；下载失败可重试。

### 增量同步（首选）

1. 在飞书多维表格创建工作流/自动化。
2. 触发条件选择新增记录、修改记录或满足条件的记录变更。
3. 执行操作选择发送 HTTP 请求，指向 SyncCut 为该连接生成的 Webhook URL。
4. 使用独立 Bearer secret 做请求鉴权。
5. 请求体只传递 record_id、更新时间、事件类型等轻量字段。
6. SyncCut 立即持久化事件并返回 2xx；后台读取完整记录和附件信息。

### 补偿同步

定时分页读取记录的更新时间或执行轻量全量比对，补偿 Webhook 未送达、自动化运行失败或短暂网络中断造成的差异。Webhook 不能作为唯一的数据完整性保障。

## 7. Bitable 附件

- 一个素材记录默认对应一个主音频附件；多附件处理规则在字段映射中明确配置。
- Bitable 附件字段包含 file_token。SyncCut 读取记录后，通过飞书媒体接口下载。
- 开启多维表格高级权限时，下载请求可能需要使用记录响应提供的 extra 参数；适配器必须保留并按飞书要求传递。
- 不通过 Webhook 传音频二进制。Webhook 仅触发记录刷新。
- Mac 下载后计算 SHA-256，按内容哈希去重缓存。

## 8. Mac 任务执行

任务类型：
- `import_media`：批量导入剪映媒体库。
- `apply_timeline`：将音频片段按参数写入工程副本。

任务状态：
`queued -> downloading -> verifying -> importing/applying -> completed/failed`

- 任务创建时冻结 asset_version。
- 每个任务具备 idempotency_key。
- 设备只拉取自己所属租户、已授权设备的任务。
- 下载文件先写入 .partial，校验后原子移动。
- 时间轴操作默认复制工程，不覆盖源项目。
- 未知剪映版本拒绝时间轴写入。

## 9. API 服务与存储

- API：Node.js 22+、原生 HTTP、PostgreSQL。
- PostgreSQL：仅保存控制面数据和同步索引，不直接向客户端开放。
- 飞书多维表格仍是业务元数据的唯一主数据源。
- M2.2 起，云端对象存储保存已同步附件的不可变副本及历史版本，供 Mac Agent 使用短期签名 URL 下载；PostgreSQL 只保存对象 key、大小和 SHA-256，不存储音频二进制。
- 对象存储按 tenant/asset/version 隔离；文件上传完成且哈希记录提交后，才向 Mac 发布 sync_assets 下载任务。Mac 仅通过 15 分钟签名 URL 下载，不持有对象存储密钥。
- 飞书附件保留为源附件，云端对象存储是 SyncCut 的分发副本，不取代飞书源记录。

## 10. 可靠性与安全

- Webhook bearer secret 每条连接独立，数据库只存 SHA-256。
- Webhook 事件以 connection_id + event_key 去重。
- 飞书 API 错误按限流/可重试/权限错误分类；429 和临时 5xx 退避重试。
- 记录飞书 X-Tt-Logid（若返回），便于排查。
- 所有跨租户查询都显式限定 tenant_id。
- 设备令牌仅保存哈希，可撤销和轮换。
- 原始音频与剪映工程不被覆盖。

## 11. 不再采用的方案

- Supabase Auth / Storage 不再作为主协作和素材系统。
- 不再自建通用多人文档编辑器。
- 不把飞书多维表格记录变更假设为直接可用的开放平台事件；首期用多维表格工作流/自动化 HTTP 请求触发，辅以补偿同步。
- Tiptap/Yjs 暂不引入，飞书已经承担协作编辑。


## 个人版接入方向

个人用户优先使用飞书商店应用的用户身份授权；个人身份与企业身份按应用和身份类型隔离，工作区不等同于企业租户。企业自建应用路径仍保留用于单企业试点。个人授权和资源访问依赖飞书商店应用的创建、审核及真实账号联调，当前不能视为已完成。
