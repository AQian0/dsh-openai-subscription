# DSH settings icon extension / 设置图标接口扩展

## Why / 原因

The tested DSH settings shell hardcodes a gear for unknown section IDs. Its
list-slot registry drops unknown metadata, and the shell copies only the ID,
order, and text label into navigation rows. Merely adding `icon` in this plugin
therefore cannot change the sidebar.

当前测试的 DSH 会为第三方设置项固定显示齿轮，而且插槽注册表不保留 `icon`
字段。插件单独提供图标不够，必须同时扩展注册表和导航渲染器。

This **local extension**, not an already-supported upstream API, adds optional
list metadata:

```ts
type SlotIcon = (props: { size: number; className?: string }) => unknown
// settings.section registration:
{ id: 'openai-subscription', label: () => t('nav'), icon: OpenAIIcon }
```

The icon callback must be a pure render function **without React hooks**. It is
called with size `16` and the host's navigation class. The plugin's header uses
the same SVG at size `24`. Labels remain localized strings, built-in icons keep
their existing fallbacks, and older hosts simply ignore `icon`.

图标回调必须是**不使用 Hooks 的纯渲染函数**。它接收宿主尺寸和 CSS 类；原有
设置项的图标不变，标签仍是本地化字符串。未扩展的 DSH 仍显示齿轮，不影响授权
和模型管理功能。没有富文本标签、选择器隐藏、DOM 观察器或远程图片等兼容技巧。

## Opt-in installation / 显式安装

`ROOT` is the DSH installation directory **containing `node_modules`**, not this
plugin repository or a DSH profile directory. Replace the sample path below
with the actual installation path. Run the script from this package directory:

```sh
node scripts/patch-dsh-settings-icons.mjs --root /path/to/dsh --check
node scripts/patch-dsh-settings-icons.mjs --root /path/to/dsh --apply
```

For a Bun global installation, that root is typically `~/.bun/install/global`.
Confirm the actual installation location before applying.

`--check` validates without writing. `--apply` is idempotent for the same patch.
The script requires `@babel/parser` and `esbuild` resolvable from `ROOT`; both
were already installed in the tested environment. It does not install tools,
access credentials, change account settings, restart DSH, or launch a server.
It is never invoked automatically by plugin installation.

`--check` 只检查，`--apply` 才修改，重复执行不会叠加补丁。构建工具必须已存在于
DSH 安装目录，脚本不会联网安装。它不读取凭证、不修改账号设置，也不重启服务。

Supported package versions (also guarded by exact SHA-256 file hashes):

| Package | Tested version |
| --- | --- |
| `@deepseek-ai/dsh-client-ui-slots` | `0.1.0-rc.7` |
| `@deepseek-ai/dsh-client-ui-settings-general` | `0.1.2-rc.1` |
| `@deepseek-ai/dsh-client-ui-settings` | `0.1.2-rc.1` |
| `@deepseek-ai/dsh-web-frontend` | `0.1.2-rc.1` |

The script refuses unknown builds, including modified files with the same
version. Do not bypass its guards after a DSH upgrade; review the upstream API
and update the patch deliberately, or remove it when upstream supports icons.

脚本同时校验版本和文件哈希，即使版本号相同但内容不同也会拒绝修改。升级 DSH
后不要绕过检查；需要重新审查补丁，或在上游正式支持图标后移除本机扩展。

## Rebuild and refresh / 构建与刷新

This installation ships compiled packages, not the original Web source tree.
The script updates the runtime registry, type contracts, and settings renderer.
It also locates the shell-static registry structurally with an AST parser and
regenerates the Web shell using esbuild. A new content-addressed asset is written,
the original asset is retained, and `index.html` switches last. It does not patch
minifier symbol names blindly or substitute a different Web server.

这里安装的是编译后的 DSH 包，不是完整前端源码。扩展除修改插槽、类型和设置
渲染器外，还通过 AST 定位静态注册表并用 esbuild 重新生成 Web 产物。新文件
采用内容哈希命名，保留原文件，最后切换 HTML 入口。

Rebuild/reinstall this plugin's client bundle as well. The tested DSH client-HMR
file poller notices modified built plugin bundles, but the **shell change always
requires refreshing the existing DSH page**. If that poller is disabled, arrange
a DSH restart yourself before refreshing. Editing TypeScript alone does not
rebuild installed plugin bundles; no automatic source-watcher behavior is assumed.

插件自身也要重新构建并安装。当前测试环境的文件监听会拾取已构建插件的变化，
但 **Web 壳层修改必须刷新现有页面**；没有监听时，还需自行安排重启 DSH。
仅修改 TypeScript 源码不会更新已安装的 GUI，脚本也不会自动重启正在进行的会话。

## Backup and restore / 备份与还原

Original files and an integrity manifest are stored outside this repository at
`~/.cache/dsh-settings-icons/<installation-hash>/v1`, or the explicit
`--backup-dir /path/to/backup`. Preserve this directory. The script reports its
exact path. Restore using the same root and backup directory:

```sh
node scripts/patch-dsh-settings-icons.mjs --root /path/to/dsh --restore
```

Restore verifies both the installed patch and original backups before writing;
it refuses to overwrite later changes. It restores only the DSH extension, not
the independently installed plugin. Refresh the existing page afterwards.

备份路径在项目之外，需妥善保留。还原前会验证当前文件和备份，避免覆盖后来
的修改。`--restore` 只还原 DSH 扩展，不回退插件自身；完成后刷新原页面。
