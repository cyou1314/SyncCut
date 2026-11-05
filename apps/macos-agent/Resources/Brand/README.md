# SyncCut 图标

- `SyncCut-Mac.png`：macOS 图标源图。
- `SyncCut.icns`：macOS 应用包图标。
- `SyncCut-Feishu.png`：飞书后台上传用的无圆角方形图标。

本项目目前通过 SwiftPM 构建可执行文件，没有正式的 `.app` 打包流程。未来打包应用时，将 `SyncCut.icns` 复制到应用包 `Contents/Resources/`，在 `Info.plist` 设置 `CFBundleIconFile` 为 `SyncCut.icns`，然后对最终应用包签名。仅运行 `swift build` 不会自动生成带图标的应用包。
