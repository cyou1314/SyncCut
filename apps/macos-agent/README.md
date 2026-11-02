# SyncCut macOS Agent

菜单栏应用起始骨架，目标 macOS 13+。

## 当前已有
- 菜单栏入口。
- 本地缓存目录初始化。
- SHA-256 内容校验和按哈希缓存的基础实现。

## 当前没有
- 登录和设备配对。
- 云端任务订阅。
- 下载和断点续传。
- 剪映 UI 自动化。
- 时间轴写入。

## 本机编译

需要 Mac + Xcode Command Line Tools。在本目录运行：

swift build
swift run

此工程尚未在实际 Mac 环境编译验收。
