# SyncCut 本地素材导入（第二版）

## 支持的输入

- 素材清单：CSV 或 XLSX，读取工作簿中的第一个工作表。
- 音频来源：一个本地文件夹，或一个 ZIP 压缩包。
- 支持音频扩展名：MP3、WAV、M4A、AAC、AIFF/AIF、FLAC、OGG、OPUS。
- 表格字段支持中文模板列名，也兼容代码字段名；附件列按文件名精确匹配。
- ZIP/XLSX 读取依赖操作系统的 unzip 命令；macOS 通常自带。Node.js 运行环境还需允许启动该系统命令。

## 导入流程

1. previewImport 读取 CSV/XLSX，并扫描文件夹或将 ZIP 中的音频安全写入临时工作区。
2. 生成逐行预览：可导入项、错误项、重名文件和素材 ID 冲突。
3. 人工检查后，才调用 applyImportPlan 并显式确认。
4. 导入文件复制到本地素材库，逐个计算并复核 SHA-256。
5. 同一素材内容未变时不产生新音频版本；元数据变化只更新 manifest。
6. 音频内容变化时新增版本，旧版本和源文件均保留。

使用示例：

    import { previewImport, applyImportPlan } from './src/local-importer.mjs';

    const plan = await previewImport({
      tablePath: '/path/to/素材清单.xlsx',
      audioZipPath: '/path/to/音频附件.zip',
      // 也可以改用 audioDirectory: '/path/to/音频文件夹'
      manifestPath: '/path/to/SyncCut-Media/manifest.json',
    });
    console.log(plan.summary, plan.errors);

    // 检查预览后再执行；有任何行错误时必须先修复表格/附件。
    const result = await applyImportPlan({
      plan,
      libraryDirectory: '/path/to/SyncCut-Media',
      manifestPath: '/path/to/SyncCut-Media/manifest.json',
      confirm: true,
    });
    console.log(result);

如果预览后取消导入，应调用 cleanupImportPreview(plan) 清理 ZIP 解压临时目录。成功导入时该目录会自动清理。使用 audioDirectory 时不会复制或修改源目录。readImportManifest() 可读取现有素材清单；manifest 不存在时返回空素材列表。

## 安全与限制

- ZIP 通过系统 unzip 命令读取，不会直接把压缩包路径解压到用户指定目录。
- 拒绝路径穿越、重复条目路径、异常文件名、损坏条目和空音频文件；ZIP 解压过程限制单文件和总输出大小。
- ZIP 最多 20,000 个条目；单个音频最多 512 MiB；解压音频总量最多 2 GiB。
- XLSX 文件最大 32 MiB；不执行公式，只读取单元格缓存值；不支持宏、加密工作簿或外部链接计算。
- XLSX 当前读取第一个工作表；不自动猜测其他工作表，也不支持复杂合并表头。
- 无显式 SyncCut ID 时，使用项目/集数/场景/镜头/名称派生 ID。正式素材表建议增加稳定的 SyncCut ID 列，避免改名后被识别为新素材。
- 导入清单是本地 JSON manifest；本模块尚未接入 Web 控制台、PostgreSQL 或 macOS 助手，也不会自动操作剪映。
- 不删除、不移动、不覆盖原始音频或已有版本。批次失败时可能留下未被 manifest 引用的孤立副本；确认 manifest 前不会将其视为已导入素材。

Node.js 22+，不新增第三方 npm 运行时依赖。
