# 开源项目调研与采用建议

调研日期：2026-11-02
项目：SyncCut（多人协作素材平台 + macOS 剪映同步助手）

结论：有成熟开源组件可支持素材试听、波形、断点续传上传、协作和 macOS 辅助功能；目前没有可直接替代 SyncCut、且已验证能在目标剪映版本稳定实现一键导入和时间轴套用的完整项目。

## 推荐采用

| 组件 | 仓库 | 许可证 | 用途 | 决策 |
|---|---|---|---|---|
| wavesurfer.js | https://github.com/katspaugh/wavesurfer.js | BSD-3-Clause | 音频试听、波形、区域标记 | 推荐 |
| tus-js-client | https://github.com/tus/tus-js-client | MIT | 大文件断点续传上传 | 推荐 |
| AXSwift | https://github.com/tmandry/AXSwift | MIT | macOS Accessibility API 封装 | 候选，需本机验证 |
| Supabase Realtime | https://github.com/supabase/realtime | Apache-2.0 | 数据库变更、Presence、广播 | 使用 Supabase 服务 |

## 采用说明

### wavesurfer.js
交互式音频波形和播放，适合素材试听、标记片段区间和预览淡入淡出。它不是音频剪辑或混音引擎。采用 npm 包并保留 BSD-3-Clause 版权和许可声明。

### tus-js-client + Supabase Storage
用于 WAV、MP3、配音等较大文件的断点续传。替换素材时使用新对象路径保留旧版本，不默认覆盖。

### AXSwift
Swift 封装 macOS Accessibility 客户端 API。它只解决系统 API 调用，不保证剪映暴露完整稳定的可访问控件。先验证用户实际安装的剪映版本，再决定是否作为正式依赖。

## 暂缓研究

Tiptap + Yjs / Hocuspocus 可用于真正的富文本块文档协同编辑。首期素材行、标签、版本和时间轴参数使用 PostgreSQL + Realtime + 乐观锁即可，不先引入 CRDT。

## 剪映相关项目：只参考，不直接集成

- pyJianYingDraft：https://github.com/GuanYixuan/pyJianYingDraft
- capcut-draft：https://github.com/ss-cmd/capcut-draft

仅参考公开文档中的概念和兼容性说明。SyncCut 不采用剪映/CapCut CLI，不复制第三方桥接代码、二进制或专有资源。所有写入方式必须独立验证并在工程副本中执行。

## 供应链要求

1. 不把第三方仓库源码直接复制进来。
2. 添加依赖时固定版本或 commit，并保存 LICENSE / NOTICE。
3. 保留 MIT、BSD-3-Clause、Apache-2.0 要求的版权和许可文本。
4. 剪映工程格式和第三方桥接先审查许可、来源和兼容性。
5. SyncCut 自身许可证由项目所有者确认后再添加。
