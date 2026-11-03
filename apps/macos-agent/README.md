# SyncCut macOS Agent

macOS 13+ 菜单栏助手。当前先提供本地素材导入和内容哈希缓存；团队配对、云端任务与剪映自动化仍在后续阶段。

## 当前可用功能

### 菜单栏本地导入（CSV + 音频目录）

启动后点击菜单栏 SyncCut 图标，在“本地素材导入”区域依次选择：

1. **素材清单**：CSV 文件（UTF-8，支持中文列名）。
2. **音频目录**：包含音频附件的文件夹，可递归扫描子目录。
3. **素材库**：用于保存导入音频版本和 `manifest.json` 的目标文件夹。

点击“检查并预览”后，助手会显示可导入数量、新素材、已有素材和逐行错误。只有预览无错误时才可点击“确认导入”。

支持音频：MP3、WAV、M4A、AAC、AIFF/AIF、FLAC、OGG、OPUS。

导入安全规则：
- 按附件文件名精确匹配；重名不猜测，报告错误。
- SHA-256 校验源文件及复制结果。
- 相同音频不重复创建版本；元数据变化只更新 manifest。
- 音频内容变化时新增版本，保留历史版本。
- 不删除、不移动、不覆盖原始音频。
- 预览后如果源文件变化，拒绝导入并要求重新预览。
- 通过系统文件选择器获取访问权限，并在操作结束后释放权限。

### 本地缓存

- 缓存按 SHA-256 内容寻址。
- 命中缓存时重新计算哈希，不信任仅凭文件名存在的缓存。
- 缓存损坏时重新复制并校验。

## 命令行高级导入

XLSX 与 ZIP 目前通过 API 包中的命令行入口执行，支持 CSV/XLSX + 音频目录或 ZIP：

```bash
cd apps/api
npm run import:media -- --table "/path/素材清单.xlsx" --audio-zip "/path/音频附件.zip" --library "$HOME/Music/SyncCut-Media"
```

命令行会先预览；只有输入大写 `IMPORT` 才执行写入。详细规则见 `apps/api/LOCAL_IMPORT.md`。

## 本机编译与启动

需要 Mac + Xcode Command Line Tools。在本目录运行：

```bash
swift build
swift run
```

CI 已在 macOS runner 上执行 Swift 构建；实际菜单栏交互和文件访问仍需在真实 Mac 上验收。

## 尚未实现

- 菜单栏界面直接选择 XLSX 和 ZIP（当前 UI 是 CSV + 文件夹）。
- SyncCut 设备配对、设备令牌和云端任务订阅。
- 飞书附件下载。
- 剪映 UI 自动化、素材批量导入和时间轴写入。
- 独立签名/公证的可分发 .app 安装包。

飞书 App Secret 和访问 Token 不应存放在 Mac 助手中。Mac 端后续只持有可撤销的 SyncCut 设备令牌。
