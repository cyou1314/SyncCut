# SyncCut 本地素材导入

## 支持的输入

- 素材清单：CSV 或 XLSX（读取第一个工作表）。
- 音频来源：本地目录或 ZIP 压缩包（二选一）。
- 支持 MP3、WAV、M4A、AAC、AIFF/AIF、FLAC、OGG、OPUS。
- 表格附件列按文件名精确匹配；重名文件不猜测，直接报错。
- ZIP/XLSX 使用系统 `unzip`，不新增 npm 运行时依赖。macOS/Linux 可用；Windows 当前不支持此导入路径。

## 运行

在 `apps/api` 目录：

```bash
npm run import:media -- --table "/path/素材清单.xlsx" --audio-dir "/path/音频文件夹" --library "$HOME/Music/SyncCut-Media"
```

ZIP 输入：

```bash
npm run import:media -- --table "/path/素材清单.csv" --audio-zip "/path/音频附件.zip" --library "$HOME/Music/SyncCut-Media"
```

程序先显示导入预览、匹配数量和逐行错误。只有输入大写 `IMPORT` 才会执行复制；其他输入均取消。素材源目录与素材库目录不能互相包含。

## 版本与安全规则

- 导入前检查素材 ID、附件匹配、音轨和时间轴参数。
- 每个文件计算 SHA-256，复制后再次校验。
- 相同音频内容不新增版本；仅元数据变化只更新 manifest。
- 音频内容变化时新增版本，保留旧版本。
- 原始文件不删除、不移动、不覆盖。
- ZIP 解压到临时工作区，限制条目数、单文件大小和总音频大小；确认成功或取消后清理临时目录。
- XLSX 最大 32 MiB，不执行公式，只读取缓存值；不支持宏、加密工作簿或外部链接计算。
- ZIP 单文件最大 512 MiB、音频总量最大 2 GiB、条目最多 20,000。
- 无显式 `SyncCut ID` 时，按项目/集数/场景/镜头/名称派生 ID。正式素材表建议增加稳定 ID 列。

## 当前边界

这是本地命令行导入入口，供 Mac 本地工作流先行验证。尚未接入 Web 控制台、PostgreSQL 索引、Mac 菜单栏界面或剪映自动化。不会自动把素材写入剪映。
