# 飞书接入配置（首期单团队试点）

## 目标

先把一个飞书企业/团队的多维表格接入 SyncCut。此阶段使用企业自建应用，验证读取记录、下载音频附件和自动化通知。跨企业接入需要后续升级为适用的应用商店应用并完成审核。

## 1. 创建飞书应用

1. 打开 https://open.feishu.cn/app
2. 创建企业自建应用，名称建议 `SyncCut Connector`。
3. 记录 App ID 和 App Secret。
4. 启用机器人能力（访问非应用自有云文档时，飞书文档要求应用具备相应能力）。
5. 在权限管理中按需申请：
   - 查看、评论、编辑和管理多维表格；
   - 读取多维表格记录及字段；
   - 下载云空间/多维表格附件所需权限；
   - 获取当前应用/用户的必要身份信息（仅在确实需要时申请）。
6. 发布/启用应用版本，并由企业管理员完成所需授权。

权限名称以飞书开发者后台当前显示为准。只申请 SyncCut 实际调用的最小权限，不要勾选无关通讯录、消息或人事权限。

## 2. 授予目标 Base 权限

如果目标多维表格不是应用自己创建的资源，需按飞书权限规则为应用授予目标文档访问权限：

1. 打开目标多维表格。
2. 进入右上角更多菜单。
3. 选择“添加文档应用”。
4. 搜索并添加 SyncCut Connector。
5. 授予完成读取记录、读取附件所需的权限；若要回写同步状态，再额外授予对应编辑权限。

如果飞书管理员不允许添加文档应用，可评估由 Base 所有者授权的 user_access_token 方案；不得尝试绕过文档权限。

## 3. 服务端配置

将 App ID / App Secret 配置在 API 服务端密钥管理中。开发环境可写入 `apps/api/.env`，该文件已被 Git 忽略。

不要把 App Secret、tenant_access_token、user_access_token 放进浏览器环境变量、Mac 客户端配置或 GitHub。

自建应用当前应用身份 Token 流程：
- 使用飞书官方当前文档指定的 OAuth token endpoint；
- 读取响应中的 `expires_in` 缓存，不硬编码过期时间；
- 服务端在过期前重新获取；当前尚无自动错误重试。

## 4. 配置多维表格

1. 根据 `docs/BITABLE_TEMPLATE.md` 创建素材数据表。
2. 每条记录对应一个主素材，附件字段放主音频文件。
3. 记录 Base 的 app_token 和素材表 table_id。
4. 在 SyncCut 控制台创建连接并保存字段映射。
5. 不要把 Base 设为公开链接来替代 API 授权。

## 5. 实时触发工作流（设想，尚未验证）

以下工作流能力和变量是否可用需在实际飞书企业版本中确认；目前也没有处理 inbox 的 worker。

在素材表所在的多维表格中创建工作流/自动化：

1. 触发条件：添加新记录时。
2. 再创建一条流程或使用支持的触发条件：修改记录时。
3. 执行操作：发送 HTTP 请求。
4. 请求方法：POST。
5. URL：使用 SyncCut 为该连接生成的 Webhook URL。
6. 请求头：`Authorization: Bearer <该连接的专属 webhook secret>`。
7. 请求体类型：raw / JSON。
8. 请求体示例：

```json
{
  "event_type": "record.updated",
  "record_id": "{{触发记录的 record_id}}",
  "modified_time": "{{触发记录的更新时间}}",
  "app_token": "你的 Base app_token",
  "table_id": "你的素材 table_id"
}
```

请在飞书工作流编辑器中使用字段变量选择器插入真实变量，不要照抄花括号占位符。新增记录流程可将 event_type 改为 `record.created`。

Webhook 只传记录标识和更新时间，不传音频文件内容。SyncCut 收到通知后再调用 Bitable API 查询记录和附件。

## 6. 可靠性

- 工作流 Webhook 是待验证的快速触发候选方案，不是飞书原生事件接口。
- SyncCut 仍需定时执行补偿扫描，避免自动化未运行、请求超时或网络故障导致漏同步。
- 飞书工作流 HTTP 请求有请求体大小和执行时长限制；只发送轻量 JSON。
- 对同一数据表的写操作应串行或限流，避免飞书返回写冲突。
- 若 Base 开启高级权限，附件下载可能要求使用记录响应提供的 extra 参数。

## 7. 多团队开放阶段

首期自建应用只验证当前企业。后续其他团队接入时：
1. 评估并创建飞书应用商店应用；
2. 每个企业独立安装并授权；
3. 每个企业绑定自己的 Base 和素材表；
4. 每个租户独立保存授权凭证、Webhook secret、成员和设备；
5. 完成飞书审核、权限说明、租户隔离和撤销授权测试。

当前不要把单企业自建应用凭证复用于其他企业。

## 当前实现状态（M2.1 开发中）

控制台仍为演示原型，尚不能保存连接或发起同步。服务端提供试点命令 `node src/pilot-cli.mjs inspect` 和 `sync`，只可由可信的服务端管理员运行；不能将密钥交给浏览器。先应用 0001 和 0002 迁移，建立 tenant，并在服务端设置 `DATABASE_URL`、`SYNC_TENANT_ID`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_BASE_TOKEN`；检查指定数据表时还需 `FEISHU_TABLE_ID`。`inspect` 输出 Base、数据表和字段 ID。同步时设置 `FEISHU_FIELD_MAPPING` 为 JSON，键为 `name`, `kind`, `attachment`, `project`, `episode`, `scene`, `shot`, `tags`, `notes`, `start`, `inPoint`, `outPoint`, `track`, `volume`, `fadeIn`, `fadeOut`, `modified`，值为对应字段 ID；前三项必填。还需设置 32 字节 base64 的 `SYNC_CREDENTIAL_ENCRYPTION_KEY` 和独立的至少 32 字符随机 `SYNC_WEBHOOK_SECRET`。命令只读取环境变量；不要在 shell 历史或仓库中写入实际密钥。

现有 Webhook 是自定义 Bearer 认证的工作流 HTTP 入口，**不是飞书原生事件订阅**。工作流能否配置自定义 HTTP 请求头及变量取决于实际企业版本和能力，尚未实测；如果不支持，不要启用该方案。目前也没有消费 inbox 的后台 worker、定时补偿扫描或状态回写，不能将该入口视为已完成实时同步。
