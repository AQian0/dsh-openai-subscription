# dsh-openai-subscription

用 OpenAI（ChatGPT Plus / Pro / Team）订阅账号登录 DeepSeek Harness（DSH）的插件。走 OpenAI 官方 OAuth 设备码流程，复用 DSH 内置 pi 依赖（`@earendil-works/pi-ai`）里的 Codex 登录实现，凭证写入 DSH 凭证库。

## 功能

- 设置页新增「**OpenAI 订阅登录**」入口：一键发起登录、显示设备验证码与登录链接、取消、结果反馈
- 登录成功后展示账号 ID 与访问令牌到期时间
- 「刷新授权」按钮：用 refresh token 静默续期
- 凭证以 `kind: grant` 记录写入 DSH 凭证库（key：`dsh-openai-subscription/chatgpt`），不落明文到仓库或配置文件之外
- 若宿主组合挂载了 `authorization` 服务，同时注册官方 `AuthorizationFlow`（设备码登录 / 刷新）

## 安装（组合级挂载）

```bash
# 1. 安装进 profile（等价于在 profile 目录里 pnpm add）
dsh plugin add dsh-openai-subscription

# 2. 挂载：二选一
#   A. 把包加进 profile 的 bundle 列表（自动应用本包的 cordis.patch.yml）
#      profile 目录 package.json → dsh.profile.bundles 数组追加 "dsh-openai-subscription"
#   B. 在 profile 的 cordis.patch.yml 里加一行（无需列为 bundle）
#      - insert:
#          - id: openai-subscription
#            name: 'dsh-openai-subscription'

# 3. 重启该 profile，打开 设置 → OpenAI 订阅登录
```

> npm 发布建议用自己的 scope（如 `@aqian0/dsh-openai-subscription`），上面命令中的包名相应替换。

## 工作原理

1. Host 半区（`src/host.js`）是一个 cordis **类插件**（`TypertRemoteService` 子类），挂载后提供 `openaiSubscription` 服务，并以**源模式**暴露 `openaiSubscription/status | authorize | poll | cancel` 四个 Typert Remote 端点——网关直接从 `@Remote` 标记发现，无需生成 typert 工件
2. 登录时通过 `shell` 服务起 `node` 子进程，动态导入 DSH 内置的 `@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js`，复用其 `openaiCodexOAuth`（Codex CLI 公开 client + `auth.openai.com` 设备码端点）
3. 用户打开 `auth.openai.com/codex/device` 用订阅账号登录并输入验证码；插件轮询 `deviceauth/token`，用返回的 authorization code 在 `oauth/token` 交换 access/refresh token
4. Client 半区（`src/client.js`，`dsh.client` 双面包）在设置页全程展示状态，通过 `connection.rpc.call('/api', 'openaiSubscription/*', { args }, signal)` 调用宿主

## 凭证与安全

- 存储位置：`~/.dsh/.credentials.yaml` 的 `records.dsh-openai-subscription/chatgpt`，`kind: grant`，payload 字段：`provider / loginMethod / accountId / access / refresh / expires / obtainedAt / refreshedAt`
- 消费方读取方式（宿主插件内）：

  ```js
  const record = await ctx.get('credentials').readRecord('dsh-openai-subscription/chatgpt')
  // record.payload: { access, refresh, expires, accountId, ... }
  ```

- 本插件从不把 token 写入日志或仓库；`status` 端点只返回非敏感字段（accountId、到期时间等）
- 设备验证码 15 分钟有效；登录请求本身 15 分钟超时

## 目录结构

```
├── package.json       # 包元数据；dsh.bundle.patch 与 dsh.client 声明；exports（. / ./host / ./client）
├── cordis.patch.yml   # bundle patch：openai-subscription 插件行
├── src/
│   ├── host.js        # Host 半区：类插件 + 源模式 Typert Remote + OAuth 驱动 + 凭证写入
│   └── client.js      # Client 半区：__ModuleLoader__ 表 + 设置页 UI + connection RPC
├── LICENSE            # MIT
└── README.md
```

## 环境要求

- DSH（含内置 `@earendil-works/pi-ai` ≥ 0.84；`typert` / `api-gateway` / `client-connection` 等 web 基础行）
- 宿主机器有 `node`（PATH 可用）且能访问 `auth.openai.com` / `api.openai.com`
- 一个 ChatGPT Plus / Pro / Team 订阅账号，且账号未禁用设备码登录

## 路线图

- [x] 凭证 key 迁移为 `<scope>/<id>` 命名空间（`dsh-openai-subscription/chatgpt`），旧点号 key 已不再被 DSH 接受
- [ ] 增加浏览器登录方式（localhost 回调）作为设备码的备选
- [ ] 严格模式 typert 工件（`./typert` / `./remote` + zod codec）替代源模式

## License

MIT
