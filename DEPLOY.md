# Dokploy 部署指南

## 部署步骤

### 1. 在 Dokploy 中创建应用

1. 登录你的 Dokploy 面板：`https://deploy.1dr.top`
2. 点击"创建应用"
3. 选择"Git"作为构建源
4. 填入仓库地址：`https://github.com/mxbyshell/workerchat-with-e2ee.git`
5. 选择分支：`main` 或 `master`

### 2. 配置构建设置

在 Dokploy 的应用设置中：

- **构建类型**: Dockerfile
- **Dockerfile 路径**: `./Dockerfile`
- **端口**: `3000`

### 3. 配置域名

1. 在应用设置中添加域名
2. 输入你的域名（例如：`chat.yourdomain.com`）
3. 启用 HTTPS

### 4. 部署应用

点击"部署"按钮，Dokploy 会自动：
1. 拉取代码
2. 构建 Docker 镜像
3. 启动容器
4. 配置反向代理

### 5. 验证部署

访问你的域名，应该能看到聊天室界面。

## 技术说明

### 架构变更

原项目基于 Cloudflare Workers + Durable Objects，为了适配 Dokploy，做了以下修改：

1. **后端替换**: 使用 Node.js + `ws` 库替代 Cloudflare Workers
2. **存储替换**: 使用内存存储替代 Durable Objects（房间数据存储在内存中）
3. **静态文件**: 使用 Node.js 内置的 `http` 模块提供静态文件服务

### 注意事项

- 当前使用内存存储房间数据，重启后数据会丢失
- 如需持久化，建议添加 Redis 支持
- 所有消息都是端到端加密的，服务器无法读取消息内容

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| PORT | 3000 | 服务器端口 |
| NODE_ENV | production | 运行环境 |

## 本地测试

```bash
# 安装依赖
npm install

# 启动服务器
node server.js

# 访问 http://localhost:3000
```
