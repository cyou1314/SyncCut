# SyncCut — 多人协作素材工作台

SyncCut 面向短剧和视频制作团队，提供多人协作的音乐、音效、配音与环境音素材清单，并通过 macOS 本地助手将素材批量导入剪映，或按参数套用到时间轴。

## 当前状态

当前仓库是 MVP 交互原型和工程骨架，不是已经上线的 SaaS 产品。

- apps/web/index.html：无依赖的本地交互原型。
- apps/macos-agent/：macOS 菜单栏助手起始工程。
- packages/shared/：Web 与 Mac 之间共享的数据契约。
- supabase/migrations/：数据库初始结构与 RLS 策略。
- docs/：产品需求、技术架构、开源调研和剪映适配边界。

## 运行原型

无需安装依赖。下载仓库后，直接用浏览器打开 apps/web/index.html。

可以体验素材筛选、搜索、本地音频上传与试听、批量选择、时间轴参数设置，以及两种套用流程的演示确认。当前原型不会连接云端或实际操作剪映。

## 首期范围

1. 在线工作区、项目和共享素材清单。
2. 多人实时查看素材新增和修改。
3. 素材版本历史、标签、备注和试听。
4. 一键导入剪映素材库。
5. 按时间、轨道、音量、淡入淡出参数套用到剪映时间轴。
6. macOS 本地助手负责下载、校验、缓存和剪映桌面端适配。

首期仅支持 macOS。Windows 客户端、多人远程控制同一台剪映、自动混音和自动生成音频不在首期范围。

## 技术路线

- Web：React + TypeScript（原型阶段使用无依赖 HTML）。
- Cloud：Supabase Auth、PostgreSQL、Storage、Realtime。
- Upload：tus-js-client + Supabase Storage TUS。
- Audio UI：wavesurfer.js。
- Mac Agent：SwiftUI、Swift Concurrency、CryptoKit。
- Jianying：版本化 macOS Accessibility / UI Automation Adapter。

## 安全原则

- 不覆盖源音频、源视频和剪映原始工程。
- 时间轴套用默认生成独立工程副本。
- 文件使用 SHA-256 校验和内容哈希去重。
- 云端素材使用私有存储桶和短时签名下载地址。
- 不上传剪映账号 Cookie、登录凭据或官方程序库。
- 未验证的剪映版本拒绝执行时间轴写入。

## 里程碑

- [x] M0：产品结构和关键工作流确定。
- [x] M1：可交互 Web 原型与初始数据模型。
- [ ] M2：云端账号、项目、素材库和实时更新。
- [ ] M3：Mac 助手配对、下载、校验和缓存。
- [ ] M4：剪映批量导入适配器。
- [ ] M5：时间轴套用适配器与验收。

## 项目许可证

SyncCut 自身的项目许可证尚未由仓库所有者确认，因此暂不添加 LICENSE 文件。公开仓库不代表自动授予他人复制或商用权利。第三方依赖许可证独立适用。
