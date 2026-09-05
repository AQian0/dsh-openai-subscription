# dsh-openai-subscription

[English](README.md) | 中文

通过 OpenAI 设备授权，在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中使用包含 Codex 权限的 ChatGPT 订阅。无需 API 密钥，也无需手动声明新出现的账号模型。

## 功能

- 使用包含 Codex 权限的 ChatGPT 套餐连接 DSH
- 从 ChatGPT Codex 后端动态读取当前账号可见的模型
- 将动态模型与 DSH 实际安装版本的 `openai-codex` 内置目录安全合并
- 在后续同步中保留用户新增模型、字段编辑和删除选择
- 提供连接、模型同步、授权恢复和本机断开操作
- 根据 DSH 当前语言显示中文或英文界面
- 将访问令牌和刷新令牌保存在本机 DSH 凭证库中

## 使用要求

- DSH CLI 0.1.2-rc.1 或更高版本
- `PATH` 中可用的 `pnpm`，用于安装插件
- `node` 命令对应 Node.js 22.19 或更高版本
- [包含 Codex 权限的 ChatGPT 套餐](https://help.openai.com/en/articles/11369540-use-codex-with-a-chatgpt-plan)，并已启用设备码授权
- 能够访问 `auth.openai.com` 和 `chatgpt.com`

## 安装

将插件安装到 Web profile：

```sh
dsh plugin --profile web add dsh-openai-subscription
```

重启 `dsh web`，然后刷新现有页面。DSH 会自动注册插件，无需手动修改 profile。

## 使用

1. 打开 **设置 → ChatGPT 订阅**。
2. 点击 **连接 ChatGPT**。
3. 打开验证页面，使用 ChatGPT 账号输入页面中的一次性设备码。
4. 授权完成后返回 DSH；插件会自动获取并同步模型。
5. 在 DSH 的模型选择器中选择可用模型。

`llm-pi-ai` 会在模型请求期间自动续期可刷新的 OAuth 凭证。设置页中的 **刷新授权** 主要用于授权异常时的手动恢复。

### 模型同步规则

DSH 的 `openai-codex.models` 是完整替代列表，而不是可追加列表；只手动添加一个模型会遮蔽原来的隐式内置目录。此插件因此写入一份完整、可追踪的快照：

- 账号端返回且 `visibility=list` 的模型作为动态来源。
- DSH 当前安装的 `llm-pi-ai` 内置模型会补充账号响应中完全未提及的 ID。
- 账号端明确标记为隐藏的 ID 不会被内置目录重新加入。
- 同一 ID 的账号端元数据优先于内置元数据；内置专属条目只写 `{ id }`，其余能力仍由 `llm-pi-ai` 补全。
- 后续同步执行字段级三方合并：用户改过的字段、本地新增条目以及从非空列表中删除的模型都会保留。
- 获取、解析或设置写入失败时，不会用不完整结果覆盖现有模型设置。

如果登录前已经存在用户层或 profile 基础层的显式 `models` 列表，插件不会在首次自动同步时推断它是“额外模型”还是有意的 allow-list。此时设置页会显示需要同步；点击 **同步模型** 并确认，才会把现有条目作为本地配置合并进去。

### 断开连接

**断开连接** 只删除本机保存的授权，以及仍未被用户修改的插件管理模型项。它会保留本地自定义模型和 provider 字段，也不会注销或删除 ChatGPT 账号。操作前会显示确认提示。

更换账号或卸载插件前，建议先断开连接。

## 卸载

先在设置页点击 **断开连接**，再执行：

```sh
dsh plugin --profile web remove dsh-openai-subscription
```

随后重启 Web profile 并刷新页面。

## 故障排查

- **设置中没有入口：** 使用 `dsh plugin --profile web why dsh-openai-subscription` 确认插件已安装到 `web` profile，然后重启 DSH 并刷新页面。
- **无法开始授权：** 确认 `node --version` 满足要求，并检查 OpenAI 登录服务是否可访问。
- **设备码被拒绝：** 在 ChatGPT 安全设置中启用设备码授权，然后重新连接。
- **模型需要同步：** 点击 **同步模型**。若已有显式模型列表，请阅读确认提示后继续；插件会保留本地编辑。
- **模型同步失败：** 现有设置会保持不变。检查 `chatgpt.com` 的网络访问和授权状态，稍后重试；必要时先刷新授权。
- **授权无法恢复：** 断开连接后重新完成设备授权。

## 兼容性说明

动态目录使用 ChatGPT 官方 Codex 客户端所使用的后端接口，但它不是公开、稳定承诺的 OpenAI API，未来可能变化。接口不提供完整的输出上限、费用或 wire compatibility 元数据；已知模型由 `llm-pi-ai` 补全，未知模型使用适配器默认值。目录中出现模型也不保证当前安装的适配器支持其所有新能力。

## 安全与隐私

密码只在 OpenAI 官方页面输入，本插件不会接触密码。OAuth 凭证保存在本机 DSH 凭证库中。设置页状态接口只返回“是否连接、是否可刷新、模型是否同步、模型数量”等语义信息，不返回令牌、内部账号 ID 或精确令牌到期时间。设备验证码在有效期内属于敏感信息，请勿分享。

使用过程仍受 OpenAI 的条款、隐私政策、模型可用性和用量限制约束。本项目是独立的社区插件，与 OpenAI 或 DeepSeek 无隶属或背书关系。

## 许可证

MIT——见 [LICENSE](LICENSE)。
