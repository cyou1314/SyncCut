# SyncCut macOS Agent

菜单栏应用起始骨架，目标 macOS 13+。

## 产品职责

- 连接指定 SyncCut 团队。
- 从 SyncCut API 拉取该团队授权的任务。
- 下载飞书多维表格附件并校验 SHA-256。
- 按内容哈希缓存音频。
- 将素材批量导入剪映，或在工程副本中执行时间轴套用。

飞书 App Secret 和访问 Token 不应存放在 Mac 助手中。Mac 只持有可撤销的 SyncCut 设备令牌。

## 当前已有

- 菜单栏入口。
- 本地缓存目录初始化。
- SHA-256 内容校验和按哈希缓存的基础实现。

## 当前没有

- SyncCut 设备配对和设备令牌。
- 云端任务订阅/轮询。
- 飞书附件下载。
- 剪映 UI 自动化。
- 时间轴写入。

## 本机编译

需要 Mac + Xcode Command Line Tools。在本目录运行：

```bash
swift build
swift run
```

此工程尚未在实际 Mac 环境编译验收。
