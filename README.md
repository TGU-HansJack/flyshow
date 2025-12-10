# Flyshow

Flyshow 是为笔记应用 **flyMD** 设计的一套「一键发布」方案，包括：

- `plugin/`：flyMD 客户端发布插件，将当前笔记列表以 Markdown 形式推送到服务端；
- `server/`：接收笔记并生成静态站点的 Node.js 后端；
- `templates/`：内置 Flyshow 主题包（可直接导入到服务端使用）。

> 提示：`server/README.md` 中包含更详细的后端说明与部署文档。

---

## 新插件测试：Flyshow（网站发布）

### 1. 插件安装
测试插件可以直接从 GitHub 下载

### 2. 注册账号
访问以下网址注册账号：
https://p.hast.one/panel

可用邀请码：
- 9c78a2e566f9
- 1beb27723bd6
- 710bc9438357

### 3. 自定义主题
默认采用 Typecho 风格主题，您可以导出主题后进行自定义修改（注意保留文章列表部分）

---

## 目录结构

- `plugin/`：flyMD 插件源码（`manifest.json`、`main.js`）
- `server/`：后端服务（API、静态站生成逻辑）
- `server/theme-template/`：示例主题模板
- `templates/`：已打包好的主题 zip 文件

---

## 快速开始

### 1. 启动后端（flyshow-server）

```bash
cd server
cp .env.example .env  # 可按需修改端口/账号等
npm install
npm run dev           # 默认端口 8787
```

更多环境变量、API、部署到 Vercel / 服务器的说明，请查看 `server/README.md`。

### 2. 安装 flyMD 插件

当前仓库中的 `plugin/` 目录为开发版插件源码，常见安装方式示例：

- 将 `plugin/` 打包为 zip，在 flyMD 中选择「从本地安装插件」；
- 或参考 flyMD 官方文档，将该目录放入其插件目录后重启应用。

安装完成后，在插件设置中：

1. 填写服务端地址，例如 `http://127.0.0.1:8787`
2. 填写账号/密码或 Token（需与 server 侧 `.env` 或安装配置保持一致）
3. 选择笔记/目录，使用插件菜单进行发布

---

## 开发与调试

- 插件开发：修改 `plugin/main.js` 后重载 flyMD 插件即可生效。
- 后端开发：在 `server/` 中使用 `npm run dev`，支持热重载（依据项目脚手架配置）。

欢迎根据自己的部署环境自定义 `templates/` 中的主题或编写新的主题模板。
