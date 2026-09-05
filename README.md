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
- DSH running under Node.js 22.19 or newer; authorization reuses that process's Node executable instead of a different `node` on `PATH`
- A [ChatGPT plan with Codex access](https://help.openai.com/en/articles/11369540-use-codex-with-a-chatgpt-plan) and device-code authorization enabled
- Network access to `auth.openai.com` and `chatgpt.com`

### Platforms and deployment

| Environment | Implementation and requirements |
| --- | --- |
| Linux / macOS | DSH's default Bash executor; no GNU `readlink` or separate `pi` CLI required. |
| Windows | DSH's default PowerShell executor and Windows Node; installation paths may contain spaces, Unicode, or apostrophes. Custom Bash executors are not part of this default configuration. |
| WSL / SSH / containers | Execution follows the DSH host's OS. Verification can happen in a browser on another device; no browser-to-host OAuth callback port is needed. |
| Mobile / remote Web | Use the existing DSH Web settings page. If clipboard access is unavailable, the device code is selected for manual copying. |

Discovery prefers the running DSH and its `llm-pi-ai` dependency, following symlinks and pnpm virtual-store dependencies. Fallbacks include npm/nvm, `NODE_PATH`, pnpm, bun, and Windows user installation roots. It never executes a discovered `pi` program.

CI is configured for Linux/macOS/Windows × Node.js 22.19/24 × npm/pnpm builds and mocked regression tests; this matrix does not imply real OpenAI sign-in has been validated on every platform. The Web settings entry is not a native TUI/ACP settings interface.

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

### Status and recovery

- Settings distinguish saved authorization, expired or unknown token lifetime, model-sync results, and missing host services. Saved authorization does not guarantee account access or remaining quota.
- Refreshing/reopening the page or reconnecting Web can recover pending device authorization from the host. Device codes are not stored in browser storage and are removed from host progress snapshots when authorization ends.
- Polling uses bounded backoff. Repeated failures or the waiting limit expose **Resume status checks** instead of retrying forever or treating an old connection as a successful new authorization. Device authorization waits up to 15 minutes.
- A sync/disconnect timeout does not prove that the host operation failed. Reload status before deciding whether to retry; the plugin does not automatically repeat mutations or silently cancel sign-in.
- Host-side locking prevents sign-in, sync, and disconnect from overwriting one another across settings pages. Disconnect remains available after a partial credential save.

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
- **Sign-in cannot start / missing component or service:** check the Node version running DSH and its credential, Shell, and model-adapter services; update or restart DSH. A separate `pi` CLI is not required.
- **Device authorization disabled (`device-auth-disabled`):** enable it in ChatGPT security settings, then connect again.
- **Expired authorization (`authorization-expired`):** refresh authorization; if rejected, disconnect and sign in again.
- **Access denied (`access-denied`):** check Codex/workspace access and DSH execution permissions. HTTP 403 does not necessarily mean an expired token; the plugin never automatically relaxes sandbox permissions.
- **Network / timeout (`network` / `timeout`):** check DNS, TLS, proxies, and access from the DSH host to `auth.openai.com` and `chatgpt.com`. Browser connectivity does not prove host connectivity.
- **Rate limited (`rate-limited`):** wait before retrying; do not repeatedly click or loop authorization refreshes.
- **Models need syncing:** select **Sync models** and review the confirmation. Existing allow-lists are merged only after explicit confirmation.
- **Invalid or empty model response:** incomplete responses do not replace the existing catalog; retry later or check plan access.
- **Ownership save failed (`ownership-save-failed`):** the complete model list was written, but its ownership snapshot was not. Fix credential-store writes before syncing again; do not assume the list is unchanged. Cleanup conservatively keeps entries with uncertain ownership.
- **Credential save or cleanup failed:** fix DSH credential-store permissions and retry; the retained Disconnect action allows cleanup to continue. Never paste tokens or device codes for troubleshooting.

## Compatibility notes

Dynamic discovery uses the backend endpoint used by the official ChatGPT Codex client, but that endpoint is not a public, stability-guaranteed OpenAI API and may change. It does not provide complete output-limit, cost, or wire-compatibility metadata. `llm-pi-ai` fills metadata for known models; unknown models use adapter defaults. Catalog presence also does not guarantee that the installed adapter supports every new model capability.

## Security and privacy

Your password is entered only on OpenAI's website; the plugin never receives it. Verification links are restricted to OpenAI's official device-authorization page. “Local” means the DSH host, not the browser device in a remote deployment. OAuth credentials remain in that host's DSH credential store and travel through subprocess stdin/stdout, not command arguments or environment variables. The settings status API returns semantic facts such as connection, token-lifetime category, refresh capability, and model state—not tokens, internal account IDs, or exact expiry timestamps. Plugin error feedback and logs use safe categories instead of forwarding raw upstream diagnostics. Do not share the temporary device code.

OpenAI's terms, privacy policy, model availability, and usage limits still apply. This is an independent community plugin and is not affiliated with or endorsed by OpenAI or DeepSeek.

## Development and validation

After installing dependencies, run `npm run check` (or `pnpm run check`) for typechecking, build, and regression tests. Use `npm pack --dry-run --ignore-scripts` to inspect published files. Tests mock OAuth, network, and credential services; they do not access real accounts. After editing the plugin, rebuild and reinstall/load that version, restart `dsh web`, and refresh the existing page. Editing source alone does not update the installed GUI plugin.

## License

MIT — see [LICENSE](LICENSE).
