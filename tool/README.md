# DeepSeek Web Oracle

`Ask DeepSeek` 技能的本地文本打包器与 EGO Lite 网页适配器。

DeepSeek 网页当前使用单一统一模型。适配器确认唯一输入框、发送状态和回答容器，不查找或切换旧版模式。

## 命令

本地打包，不联网：

```bash
node bin/deepseek-oracle.mjs render \
  --prompt "审查这个变更的边界条件和回归风险" \
  --file ../some-project/src
```

输出：

```text
sessions/<session-id>/prompt.md
sessions/<session-id>/meta.json
```

用户已明确授权咨询后发送：

```bash
node bin/deepseek-oracle.mjs ask \
  --session <session-id> \
  --send
```

发送必须显式带 `--send`。工具通过 EGO Lite 打开 `https://chat.deepseek.com/`，并按以下契约工作：

- 唯一输入框：`textarea[name="search"]`
- 可访问性名称：“给 DeepSeek 发送消息”
- 回答容器：`.ds-assistant-message-main-content`
- 提交证据：本次运行标记出现在对话中且输入框清空

“深度思考”和“智能搜索”是独立的 `aria-pressed` 开关，不是模型模式。`ask` 保留页面已有状态；用户要求精确状态时，由技能通过真实页面设置并复核。

`ask` 只封装 EGO Lite。若 EGO Lite 不可用，调用方按技能的浏览器路由改用当前 Codex 会话可控的 Chrome，再降级到 Codex 内置浏览器；外部适配器不会尝试接管这两个会话。

## 不确定状态

`meta.json` 使用 `rendered`、`submitting`、`uncertain` 和 `completed` 四种状态。点击发送后若结果未知，工具保留任务空间并拒绝重发。

确认准确对话 URL 后只读恢复：

```bash
node bin/deepseek-oracle.mjs recover \
  --session <session-id> \
  --url "https://chat.deepseek.com/a/chat/s/<conversation-id>"
```

`recover` 先确认对话包含本 session 的运行标记，再保存最后一条回答，不提交新问题。

## 可选 CDP 诊断

```bash
node bin/deepseek-oracle.mjs launch --port 9227
node bin/deepseek-oracle.mjs probe --port 9227
```

`launch` 使用 `browser-profile/` 专用 profile；用户需自行登录。它会在 macOS、Linux 和 Windows 的常见 Chrome 安装位置及 PATH 中查找可执行文件。`probe` 只读取统一输入区与能力标签计数，结果写入 `last-probe.json`，不发送消息。

## 验证

```bash
npm test
```

## 边界

- 不使用 API Key 或 DeepSeek 私有 API。
- 不读取正常浏览器 Cookie。
- 不绕过登录、验证码、额度或平台限制。
- 页面、提交或回答证据不唯一时停止。
- `sessions/`、`browser-profile/`、`last-probe.json` 和日志不得提交或外发。
