# dsh-openai-subscription

[English](README.md) | 中文

通过 OpenAI 设备授权，在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中使用 ChatGPT 订阅。无需 API 密钥。登录后，插件会尝试自动将受支持的 GPT 模型加入 DSH 模型选择器。

## 功能

- 使用包含 Codex 权限的 ChatGPT 套餐登录
- 尝试自动启用 `openai-codex` 提供商和受支持的 GPT 模型
- 在 DSH 设置中查看账号状态、刷新授权或退出登录
- 将访问令牌和刷新令牌保存在本机 DSH 凭证库中

## 使用要求

- DSH CLI 0.1.2-rc.1 或更高版本
- `PATH` 中可用的 `pnpm`，用于安装插件
- `node` 命令对应 Node.js 22.19 或更高版本
- [包含 Codex 权限的 ChatGPT 套餐](https://help.openai.com/en/articles/11369540-use-codex-with-a-chatgpt-plan)，并已启用设备码授权
- 能够访问 `auth.openai.com` 和 `chatgpt.com`

如需安装或更新 DSH：

```sh
npm install -g pnpm @deepseek-ai/dsh@next
```

## 安装

将插件安装到 Web profile：

```sh
dsh plugin --profile web add dsh-openai-subscription
```

重启 `dsh web`，然后刷新页面。DSH 会自动注册插件，无需手动修改 profile。

## 使用

1. 打开 **设置 → ChatGPT 订阅登录**。
2. 点击 **使用 ChatGPT 账号登录**。
3. 打开页面中显示的链接，使用 ChatGPT 账号输入设备码。
4. 授权完成后返回 DSH，选择受支持的 GPT 模型。

会话无法自动续期时，可点击 **刷新授权**。更换账号或卸载插件前，请先点击 **退出登录**。

## 卸载

先在设置页退出登录以删除本机授权，再执行：

```sh
dsh plugin --profile web remove dsh-openai-subscription
```

随后重启 Web profile。

## 故障排查

- **设置中没有登录入口：** 使用 `dsh plugin --profile web why dsh-openai-subscription` 确认插件已安装到 `web` profile，然后重启 DSH 并刷新页面。
- **无法开始授权：** 更新 DSH，确认 `node --version` 满足要求，并检查 OpenAI 登录服务是否可访问。
- **设备码被拒绝：** 在 ChatGPT 安全设置中启用设备码授权，然后重新登录。
- **刷新授权失败：** 退出登录后重新完成设备授权。

## 安全与隐私

密码只在 OpenAI 官方页面输入，本插件不会接触密码。OAuth 凭证保存在本机 DSH 凭证库中，状态接口不会返回令牌内容。设备验证码在有效期内属于敏感信息，请勿分享。

使用过程仍受 OpenAI 的条款、隐私政策、模型可用性和用量限制约束。本项目是独立的社区插件，与 OpenAI 或 DeepSeek 无隶属或背书关系。

## 许可证

MIT——见 [LICENSE](LICENSE)。
