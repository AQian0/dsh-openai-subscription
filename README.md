# dsh-openai-subscription

English | [中文](README.zh.md)

Use a ChatGPT subscription in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through OpenAI device authorization. No API key is required. After sign-in, the plugin attempts to add supported GPT models to the DSH model picker without manual provider setup.

## Features

- Sign in with a ChatGPT plan that includes Codex access
- Attempt to enable the `openai-codex` provider and supported GPT models automatically
- View account status, refresh authorization, or sign out from DSH settings
- Keep access and refresh tokens in the local DSH credential store

## Requirements

- DSH CLI 0.1.2-rc.1 or newer
- `pnpm` available on `PATH` for plugin installation
- Node.js 22.19 or newer available as `node`
- A [ChatGPT plan with Codex access](https://help.openai.com/en/articles/11369540-use-codex-with-a-chatgpt-plan) and device-code authorization enabled
- Network access to `auth.openai.com` and `chatgpt.com`

Install or update DSH when needed:

```sh
npm install -g pnpm @deepseek-ai/dsh@next
```

## Installation

Install the plugin into the Web profile:

```sh
dsh plugin --profile web add dsh-openai-subscription
```

Restart `dsh web`, then refresh the page. DSH registers the plugin automatically; no profile edits are required.

## Usage

1. Open **Settings → ChatGPT 订阅登录** (ChatGPT Subscription Sign-in).
2. Select **使用 ChatGPT 账号登录** (Sign in with ChatGPT).
3. Open the displayed link and enter the device code with your ChatGPT account.
4. Return to DSH after authorization completes and select a supported GPT model.

Use **刷新授权** (Refresh authorization) if the session cannot renew automatically. Use **退出登录** (Sign out) before changing accounts or uninstalling the plugin.

## Uninstallation

Sign out from the settings page first so the stored authorization is removed, then run:

```sh
dsh plugin --profile web remove dsh-openai-subscription
```

Restart the Web profile afterward.

## Troubleshooting

- **The settings entry is missing:** confirm the plugin is installed in the `web` profile with `dsh plugin --profile web why dsh-openai-subscription`, then restart DSH and refresh the page.
- **Authorization cannot start:** update DSH, confirm `node --version` meets the requirement, and check access to the OpenAI authentication service.
- **The device code is rejected:** enable device-code authorization in the ChatGPT security settings and start a new sign-in.
- **Refresh fails:** sign out and complete device authorization again.

## Security and privacy

Your password is entered only on OpenAI's website; the plugin never receives it. OAuth credentials are stored in the local DSH credential store, and the status interface never returns token values. Do not share the temporary device code.

OpenAI's terms, privacy policy, model availability, and usage limits still apply. This is an independent community plugin and is not affiliated with or endorsed by OpenAI or DeepSeek.

## License

MIT — see [LICENSE](LICENSE).
