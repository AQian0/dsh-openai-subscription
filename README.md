# dsh-openai-subscription

用 OpenAI（ChatGPT Plus / Pro / Team）订阅账号登录 DeepSeek Harness（DSH）的插件。走 OpenAI 官方 OAuth 设备码流程，复用 DSH 内置 pi 依赖（`@earendil-works/pi-ai`）里的 Codex 登录实现，凭证写入 DSH 凭证库。

## 功能

- 设置页新增「**OpenAI 订阅登录**」入口：一键发起登录、显示设备验证码与登录链接、取消、结果反馈
- 登录成功后展示账号 ID 与访问令牌到期时间，此时隐藏「使用 OpenAI 账号登录」按钮，并提供「退出登录」清除本机凭证
- 「刷新授权」按钮：优先读取 pi-ai 实际使用的最新 refresh token 静默续期，并用并发校验避免旧刷新结果覆盖新登录或自动续期结果
- **登录即接通模型列表（全自动）**：授权/刷新成功时把订阅凭证按 pi-ai 的形状镜像写入 `llm-pi-ai/openai-codex`（DSH 官方 `dsh-llm-pi-ai` 适配器按请求解析的地址），并通过设置服务静默添加 `llm-pi-ai.providers.openai-codex`（热重载）——二者都不需要用户手动改配置，登录后 GPT 系列模型直接出现在模型选择器，在窗口内切换即可
- 退出登录时：先取消在途授权，再删除本机凭证与模型适配器凭证；只有确认适配器凭证已删除才报告成功，并仅撤回带插件所有权标记的默认空路由
- 凭证以 `kind: grant` 记录写入 DSH 凭证库（key：`dsh-openai-subscription/chatgpt`），不落明文到仓库或配置文件之外
- 若宿主组合挂载了 `authorization` 服务，同时注册官方 `AuthorizationFlow`（设备码登录 / 刷新）
- RPC 带 12 秒超时与卸载取消；授权确认后才开始单飞轮询，瞬时网络错误自动重试，避免慢请求堆积或旧响应覆盖新状态

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

1. Host 半区（`src/host.ts`，TypeScript 源码，`tsc` 原地编译产出 `src/host.js`）是一个 cordis **类插件**（`TypertRemoteService` 子类），挂载后提供 `openaiSubscription` 服务，并以**源模式**暴露 `openaiSubscription/status | authorize | poll | cancel | logout` 五个 Typert Remote 端点——网关直接从 `@Remote` 标记发现，无需生成 typert 工件
2. 登录时通过 `shell` 服务起 `node` 子进程，动态导入 DSH 内置的 `@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js`，复用其 `openaiCodexOAuth`（Codex CLI 公开 client + `auth.openai.com` 设备码端点）
3. 用户打开 `auth.openai.com/codex/device` 用订阅账号登录并输入验证码；插件轮询 `deviceauth/token`，用返回的 authorization code 在 `oauth/token` 交换 access/refresh token
4. 授权/刷新成功时把同一条 grant 按 pi-ai 的凭证形状（`type: oauth` + access/refresh/expires/accountId）写入 `llm-pi-ai/openai-codex`——这是 DSH 官方 `dsh-llm-pi-ai` 适配器为 `openai-codex` 路由实际解析与自动续期的记录地址；手动刷新优先读取此记录，并在回写时校验 refresh token 未被并发更新
5. 凭证就绪后通过带 revision 校验的 `settings.mutate` 静默添加 `llm-pi-ai.providers.openai-codex`（设置文档热重载），并在插件记录中保存路由所有权；已存在的 provider 配置与用户自定义 profile 一律不动
6. 退出登录时先取消两条授权路径，再删除适配器凭证和插件凭证；仅当路由确由本插件创建且仍为空配置时才撤回 `openai-codex`
7. Client 半区（`src/client.ts`，`dsh.client` 双面包，原地编译为 `src/client.js`）在设置页全程展示登录状态，通过 `connection.rpc.call('/api', 'openaiSubscription/*', { args }, signal)` 调用宿主

## 凭证与安全

- 存储位置：本插件记录在 `~/.dsh/.credentials.yaml` 的 `records.dsh-openai-subscription/chatgpt`，`kind: grant`，payload 字段：`provider / loginMethod / accountId / access / refresh / expires / obtainedAt / refreshedAt / managedPiRoute`；适配器实际消费的授权记录在同一文件的 `records.llm-pi-ai/openai-codex`，按 pi-ai 凭证形状存储，状态与手动刷新优先以它为准
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
├── tsconfig.json      # TypeScript 配置（严格模式，原地编译到 src/*.js / *.d.ts）
├── src/
│   ├── host.ts        # Host 半区：类插件 + 源模式 Typert Remote + OAuth 驱动 + 凭证写入
│   ├── oauth.ts       # OAuth 子进程返回值的运行时校验与刷新字段合并
│   └── client.ts      # Client 半区：__ModuleLoader__ 表 + 设置页 UI + connection RPC
│                      # （编译产物 src/*.js / src/*.d.ts 随源码一起提交）
├── tests/
│   ├── host.test.mjs  # Host 状态、取消/退出顺序与路由所有权测试
│   └── oauth.test.mjs # OAuth 边界校验测试（Node 内置 test runner）
├── LICENSE            # MIT
└── README.md
```

## 开发（本仓库）

源码为 TypeScript；`tsc` 将 `src/*.ts` 原地编译为同名 `.js` / `.d.ts`，运行时入口路径（`package.json` 的 `./src/host.js`、`./src/client.js`）保持稳定，宿主无需感知编译步骤：

```bash
bun install        # 或 npm install / pnpm install（devDependencies 含类型来源包）
bun run build      # tsc -p tsconfig.json，产出 src/*.js + *.d.ts
bun run typecheck  # 仅类型检查，不产出
bun run test       # Node 内置 test runner，验证 Host 生命周期与 OAuth 边界
bun run check      # typecheck + build + test；发布前 prepack 也会执行
```

- **编译产物随源码一起提交**（`src/*.js` / `src/*.d.ts` 入库），安装时不依赖任何 npm 生命周期钩子：`bun` / `pnpm` 默认拦截依赖安装脚本、`npm i --ignore-scripts`、离线 git 安装等场景全部可用。修改 `src/*.ts` 后运行 `bun run check` 再把产物与源码一起提交；`prepack` 会在打包发布前重复执行同一门禁
- 工具链为 **TypeScript 7**（原生编译器，`typescript@^7.0.2`）；本仓库代码同时通过 tsc 5.9 验证，产物逐字节一致
- Host 半区类型直接来自 DSH 各接缝包自带的 `.d.ts`（`dsh-credentials` / `dsh-shell` / `dsh-authorization` / `dsh-settings` / `cordis-plugin-timer` / `dsh-typert-protocol`），全部为 devDependencies，不引入运行时依赖

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
