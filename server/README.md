# flyshow-server

flyshow 发布插件的后端，接收 Markdown 列表并生成静态数字花园站点。默认在 `site/` 输出静态页，可直接推送到 Vercel/静态空间。

## 快速开始
```bash
cd flyshow-server
npm install
npm run dev  # 默认端口 8787
```

插件设置中填写服务器地址（如 `http://127.0.0.1:8787`）和账号/密码即可发布；多用户模式下管理员生成邀请码，普通用户自助注册再登录。

## 环境变量
- `PORT`：监听端口，默认 `8787`
- `FLYSHOW_USER` / `FLYSHOW_PASS`：单用户模式账号密码
- `FLYSHOW_TOKEN`：单用户可选 Token，插件可用 Bearer 或 `X-Flyshow-Token`
- `FLYSHOW_MULTI`：`true` 开启多用户模式（站点路径 `/用户名/...`）
- `FLYSHOW_ADMIN_USER` / `FLYSHOW_ADMIN_PASS`：多用户管理员账号
- `FLYSHOW_DATA_DIR`：数据与状态存储目录，默认 `./data`
- `FLYSHOW_OUT_DIR`：静态站点输出目录，默认 `./site`
- MySQL（存储用户/Token/邀请码/站点模式）：`FLYSHOW_DB_HOST`、`FLYSHOW_DB_PORT`、`FLYSHOW_DB_USER`、`FLYSHOW_DB_PASS`、`FLYSHOW_DB_NAME`、`FLYSHOW_DB_PREFIX`
- 可直接复制 `.env.example` 为 `.env`，修改后 `npm run dev` 会自动加载

## 多用户认证与控制台
- `/panel`：简易控制台，可登录获取 token、创建邀请码、注册、注销设备 token。
- 接口：`/api/login` 获取 Bearer token；`/api/register` 邀请码注册；`/api/invite` 创建邀请码（管理员）；`/api/users` 查看用户列表（管理员）；`/api/devices/revoke` 注销设备 token（管理员）。
- 单用户模式兼容原 Basic/Token 方式。

## 初次安装
- 启动服务后访问 `/install`，填写站点名、模式（单/多用户）及账号密码，提交后会写入数据库并初始化管理员/单用户账号。
- 安装完成后访问 `/panel` 登录，或插件端填写相同账号密码获取 token。

## API
- `POST /api/publish`：接收 `{ notes: [{ relativePath, content, hash, title }], configText }`，生成站点并返回 `statuses`
- `GET /api/status`：返回服务器保存的发布状态 map（按用户隔离）
- `GET /health`：健康检查，返回是否多用户

## 目录结构
- `data/`：持久化笔记与 `status.json`
- `data/config.mjs`：插件推送的站点配置
- `site/`：生成的静态站，可直接部署

## 部署到 Vercel（静态托管）
1. 本地运行 `npm run dev` 或调用 `/api/publish` 生成 `site/`
2. 将 `site/` 提交到独立仓库或设置 Vercel 项目根目录指向 `flyshow-server/site`
3. Vercel 项目配置：
   - Build Command: `""`（空，直接使用已有静态文件）
   - Output Directory: `site`
4. 部署后，插件继续将内容推送到你的服务器，生成的 `site/` 同步到 Vercel 仓库即可更新线上站点

> 也可以将本服务部署到其它长期运行的 Node 环境，直接对外提供 API 与静态站点。

## 本地 / 服务器运行示例
1) 复制环境变量模板  
```bash
cd flyshow-server
cp .env.example .env
# 根据需要修改 .env（端口、单/多用户、账号密码、数据/站点目录）
```

2) 安装依赖并启动  
```bash
npm install
npm run dev   # 或 PORT=9000 npm run dev
```

3) 目录挂载（适合 Docker / 守护进程）  
- `FLYSHOW_DATA_DIR`（默认 `./data`）存放笔记和 `status.json`；挂载到宿主可持久化状态。  
- `FLYSHOW_OUT_DIR`（默认 `./site`）存放生成的静态站；可挂载给 Nginx/静态服务或同步到 Vercel 仓库。  

4) 访问  
- API：`http://<host>:<PORT>/api/publish`、`/api/status`  
- 站点：`http://<host>:<PORT>/`（单用户）或 `http://<host>:<PORT>/<username>/`（多用户）  

5) 简单 Dockerfile（可选）  
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src ./src
COPY .env.example ./
EXPOSE 8787
CMD ["npm", "run", "start"]
```
运行示例：  
```bash
docker build -t flyshow-server .
docker run -d --name flyshow \
  -p 8787:8787 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/site:/app/site \
  --env-file .env \
  flyshow-server
```
