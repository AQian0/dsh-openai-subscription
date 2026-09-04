# dsh-openai-subscription

用 OpenAI（ChatGPT Plus / Pro / Team）订阅账号登录 DeepSeek Harness（DSH）的插件。走 OpenAI 官方 OAuth 设备码流程，复用 DSH 内置 pi 依赖（`@earendil-works/pi-ai`）里的 Codex 登录实现，凭证写入 DSH 凭证库。

## 功能

- 设置页新增「**OpenAI 订阅登录**」入口：一键发起登录、显示设备验证码与登录链接、取消、结果反馈
- 登录成功后展示账号 ID 与访问令牌到期时间
- 「刷新授权」按钮：用 refresh token 静默续期
- 凭证以 `kind: grant` 记录写入 DSH 凭证库（key：`openai.subscription`），不落明文到仓库或配置文件之外
- 若宿主组合挂载了 `authorization` 服务，同时注册官方 `AuthorizationFlow`（设备码登录 / 刷新）

## 工作原理

1. Host 半区（`src/host.js`）通过 `shell` 服务起一个 `node` 子进程，动态导入 DSH 内置的 `@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js`，复用其 `openaiCodexOAuth` 实现（Codex CLI 公开 client + `auth.openai.com` 设备码端点）
2. 向 `auth.openai.com/api/accounts/deviceauth/usercode` 申请设备码，用户打开 `auth.openai.com/codex/device` 用订阅账号登录并输入验证码
3. 轮询 `deviceauth/token` 直到授权完成，用返回的 authorization code 在 `oauth/token` 交换 access/refresh token
4. 凭证写入 `credentials` 服务；Client 半区（`src/client.js`）在设置页全程展示状态

## 快速开始（动态挂载）

本仓库当前以**动态 Cordis 插件**形态分发，直接在 DSH 界面挂载即可（无需重启服务）：

1. 在 DSH 的会话中依次把 `src/host.js` 与 `src/client.js` 的内容用动态插件工具定义（`cordis_define` 的 `code.host` / `code.client`，用任一 3–6 位小写字母前缀，如 `oasub`）
2. 运行该 Package（`cordis_run`），按提示在界面批准 Client 激活
3. 打开 **设置 → OpenAI 订阅登录**，点「使用 OpenAI 账号登录」，在打开的页面用 ChatGPT 订阅账号完成授权

> 注意：动态插件是进程级的临时扩展，重启 DSH 后需重新挂载。组合级挂载（`cordis.yml` 插件行 + `dsh.client` 双面包）是路线图上的下一步，见下文「路线图」。

## 凭证与安全

- 存储位置：`~/.dsh/.credentials.yaml` 的 `records.openai.subscription`，`kind: grant`，payload 字段：`provider / loginMethod / accountId / access / refresh / expires / obtainedAt / refreshedAt`
- 消费方读取方式（宿主插件内）：

  ```js
  const record = await ctx.get('credentials').readRecord('openai.subscription')
  // record.payload: { access, refresh, expires, accountId, ... }
  ```

- 本插件从不把 token 写入日志、仓库或网页以外的存储；`openai.status` RPC 只返回非敏感字段（accountId、到期时间等）
- 设备验证码 15 分钟有效；登录请求本身 15 分钟超时

## 目录结构

```
├── package.json       # 包元数据与 exports（./host、./client）
├── src/
│   ├── host.js        # Host 半区：OAuth 驱动、凭证写入、RPC 桥
│   └── client.js      # Client 半区：设置页 UI
├── LICENSE            # MIT
└── README.md
```

## 环境要求

- DSH（含内置 `@earendil-works/pi-ai` ≥ 0.84）
- 宿主机器有 `node`（PATH 可用）且能访问 `auth.openai.com` / `api.openai.com`
- 一个 ChatGPT Plus / Pro / Team 订阅账号，且账号未禁用设备码登录

## 路线图

- [ ] 组合级挂载：Host 半区改挂 typert Remote 服务替代 `harness.handle` 桥，`cordis.yml` 增加插件行
- [ ] Client 半区接入 `dsh.client` 双面包构建管线（`__ModuleLoader__` CJS 表），去掉对动态内置（`host` / `styles` / `React` 全局）的依赖
- [ ] 凭证 key 迁移为更长的命名空间（如 `openai-subscription/chatgpt`），兼容旧 key
- [ ] 增加浏览器登录方式（localhost 回调）作为设备码的备选

## License

MIT
