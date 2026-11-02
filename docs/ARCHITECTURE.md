# SyncCut 技术架构

## 总体结构

Web Workspace
- Auth、Workspace、Project、Shared Document
- Asset Catalog、Version History、Timeline Presets
- Sync Job API

Cloud
- Supabase Auth
- PostgreSQL + Row Level Security
- Realtime：结构化记录变更、在线状态和任务状态
- Private Storage：素材文件
- Edge Functions：设备鉴权、签名下载地址和可信任务更新

macOS Sync Agent
- Device Pairing
- Download Queue、Resume、SHA-256
- Local Content Cache
- Jianying Media Import Adapter
- Jianying Timeline Adapter

## 为什么首期不用 CRDT

首期核心对象是结构化素材记录、标签、元数据和时间轴参数，而不是多人同时编辑长篇富文本。使用 PostgreSQL + Realtime + version 乐观锁即可，冲突处理更简单。将来需要自由文本、块级文档或多人同时编辑复杂表格时，再评估 Tiptap + Yjs。

## 云端

- Supabase Auth：成员身份和会话。
- PostgreSQL：工作区、项目、文档、素材、版本、设备和任务。
- Realtime：订阅项目素材变化与任务状态。
- Storage：私有 bucket，随机对象 key，不公开原始路径。
- 下载：由服务端生成短时 signed URL；设备令牌不暴露给浏览器。

## Mac 助手

- SwiftUI 菜单栏应用。
- 使用设备配对码绑定工作区；服务端仅保存设备令牌哈希。
- 后台任务按 device ID 过滤。
- 缓存目录：~/Library/Application Support/SyncCut/Cache/
- 临时文件先写入 .partial，校验完成后原子移动。
- 同一内容按 SHA-256 去重；文件名冲突不覆盖。
- 网络中断后可续传；任务使用幂等键避免重复执行。

## 剪映适配边界

剪映没有可供本产品直接依赖的公开稳定桌面 SDK。媒体导入与时间轴编辑分开实现、分开验收：
- 媒体导入：验证 macOS Accessibility / UI Automation 能否稳定定位导入入口和文件选择器。
- 时间轴套用：使用独立的版本适配器；所有项目写入都在副本中完成。
- 不支持的剪映版本拒绝执行，不猜测工程结构后强行写入。
- 适配器不读取账号凭据，不修改官方应用包，不绕过授权或付费限制。
- 每次执行保存剪映版本、工程哈希、素材清单、操作日志和结果。

## 同步任务协议

任务类型：import_media、apply_timeline。
状态：queued、downloading、verifying、importing、applying、completed、failed、cancelled。

每个任务包含 workspace_id、project_id、device_id、idempotency_key、素材版本列表和可选时间轴参数。每个素材单独记录结果，支持部分成功和幂等重试。
