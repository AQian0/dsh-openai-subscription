# dsh-openai-subscription

English | [中文](README.zh.md)

Use a ChatGPT subscription with Codex access in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through OpenAI device authorization. No API key or manual declaration of newly available account models is required.

## Features

- Connect DSH to a ChatGPT plan that includes Codex access
- Dynamically read account-visible models from the ChatGPT Codex backend
- Safely merge live models with the `openai-codex` catalog from DSH's installed adapter version
- Preserve user-added models, field edits, and deletion choices across later syncs
- Provide focused actions for connecting, model sync, authorization recovery, and local disconnect
- Follow the current DSH locale in Chinese and English
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

Restart `dsh web`, then refresh the existing page. DSH registers the plugin automatically; no profile edits are required.

## Usage

1. Open **Settings → ChatGPT Subscription**.
2. Select **Connect ChatGPT**.
3. Open the verification page and enter the displayed one-time device code with your ChatGPT account.
4. Return to DSH after authorization completes; the plugin fetches and syncs models automatically.
5. Select an available model from the DSH model picker.

`llm-pi-ai` automatically renews refreshable OAuth credentials during model requests. **Refresh authorization** in this settings page is primarily a manual recovery action.

### Model synchronization rules

DSH treats `openai-codex.models` as a complete replacement list, not an additive list. Adding one model manually therefore hides the previous implicit built-in catalog. This plugin writes a complete, owned snapshot instead:

- Models returned by the account endpoint with `visibility=list` are the dynamic source.
- Built-in model IDs from DSH's currently installed `llm-pi-ai` adapter supplement IDs the account response does not mention at all.
- An ID explicitly marked hidden by the account endpoint is never resurrected from the built-in catalog.
- Account metadata wins for the same ID. Built-in-only rows are written as `{ id }` so `llm-pi-ai` continues supplying their complete capabilities.
- Later syncs use a field-level three-way merge. User-edited fields, local additions, and models removed from a non-empty explicit list remain preserved.
- Fetch, parse, or settings-write failures never replace current settings with a partial result.

If an explicit `models` list already exists in either the user layer or a profile base layer before the first sync, the plugin cannot safely infer whether it is an intentional allow-list or a list of additions. Automatic sign-in sync leaves it untouched. The settings page then shows that syncing is needed; selecting **Sync models** and confirming explicitly opts into merging the existing entries as local configuration.

### Disconnecting

**Disconnect** removes only locally stored authorization and unchanged model rows managed by this plugin. It preserves locally customized models and provider fields, and it neither signs out of nor deletes the ChatGPT account. A confirmation is shown first.

Disconnect before changing accounts or uninstalling the plugin.

## Uninstallation

Select **Disconnect** in the settings page first, then run:

```sh
dsh plugin --profile web remove dsh-openai-subscription
```

Restart the Web profile and refresh the page afterward.

## Troubleshooting

- **The settings entry is missing:** confirm the plugin is installed in the `web` profile with `dsh plugin --profile web why dsh-openai-subscription`, then restart DSH and refresh the page.
- **Authorization cannot start:** update DSH, confirm `node --version` meets the requirement, and check access to the OpenAI authentication service.
- **The device code is rejected:** enable device-code authorization in ChatGPT security settings and start a new connection.
- **Models need syncing:** select **Sync models**. If an explicit list already exists, review the confirmation and continue; local edits are preserved.
- **Model sync fails:** existing settings remain unchanged. Check access to `chatgpt.com` and authorization status, then retry; refresh authorization first if needed.
- **Authorization cannot recover:** disconnect and complete device authorization again.

## Compatibility notes

Dynamic discovery uses the backend endpoint used by the official ChatGPT Codex client, but that endpoint is not a public, stability-guaranteed OpenAI API and may change. It does not provide complete output-limit, cost, or wire-compatibility metadata. `llm-pi-ai` fills metadata for known models; unknown models use adapter defaults. Catalog presence also does not guarantee that an older adapter supports every new model capability, so update DSH first when calls reveal compatibility problems.

## Security and privacy

Your password is entered only on OpenAI's website; the plugin never receives it. OAuth credentials remain in the local DSH credential store. The settings status API returns only semantic facts such as connection, refresh capability, model-sync state, and model count. It does not return tokens, internal account IDs, or exact token-expiry timestamps. Do not share the temporary device code.

OpenAI's terms, privacy policy, model availability, and usage limits still apply. This is an independent community plugin and is not affiliated with or endorsed by OpenAI or DeepSeek.

## License

MIT — see [LICENSE](LICENSE).
