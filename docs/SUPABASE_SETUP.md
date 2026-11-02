# Supabase 项目配置

本文用于把 SyncCut 的 M2 云端基础设施连接到一个新的 Supabase 项目。

## 1. 创建项目

1. 打开 https://supabase.com/dashboard
2. 登录后选择 New project。
3. 项目名称建议使用 `sync-cut-prod`；如果只是先测试，可使用 `sync-cut-dev`。
4. 设置数据库密码并妥善保存在密码管理器中，不要提交到 GitHub。
5. 区域选择靠近主要协作成员的区域。创建后等待项目初始化完成。

建议先创建开发环境，不要直接把真实素材放进测试项目。

## 2. 执行数据库迁移

在 Supabase 项目中打开 SQL Editor，按顺序执行仓库里的迁移：

1. `supabase/migrations/0001_init.sql`
2. `supabase/migrations/0002_m2_cloud_foundation.sql`

每份 SQL 都应完整执行。若执行失败，先保留错误信息，不要跳过失败语句继续执行。

迁移会创建用户资料表、工作区所有者自动加入逻辑、音频素材元数据字段、私有音频存储桶和存储访问策略，并开启相关表的 Realtime 发布。

## 3. 配置身份认证

在 Supabase Dashboard 的 Authentication 设置中：

- 启用 Email provider。
- 开发阶段可先保留邮箱验证；注册后需要完成邮箱验证。
- 配置 Site URL。
- 将本地开发地址（例如 `http://localhost:5173`）加入 Redirect URLs。
- 部署后再把正式站点域名加入 Redirect URLs。

不要为了省事长期关闭邮箱验证。

## 4. 获取浏览器端连接参数

在 Project Settings → API 中获取：

- Project URL
- Publishable key（旧项目可能显示 anon key）

将它们配置到本地 Web 环境变量：

```bash
VITE_SUPABASE_URL=https://你的项目ID.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=你的_publishable_key
```

不要把以下内容放入浏览器环境变量或提交到 GitHub：

- Secret key
- service_role key
- 数据库密码
- SMTP 密码
- 任何可绕过 RLS 的服务端凭据

浏览器端只使用 publishable key；用户数据隔离由数据库 RLS 策略执行。

## 5. 存储规则

迁移会创建私有 bucket：`sync-cut-assets`。

对象路径固定为：

```text
workspace_id/project_id/asset_id/version_id/original-filename
```

初始单文件限制为 50 MiB，只允许常见音频 MIME 类型。大文件断点续传将在后续 Mac 助手/上传阶段单独实现。不要把 bucket 改为 public。

## 6. 当前阶段边界

完成上述配置后，云端数据库和存储规则才具备运行条件。Web 登录、工作区、项目和素材界面仍需连接 Supabase 客户端并完成实际联调。

此阶段不会自动部署 Supabase，也不会修改用户的剪映工程。
