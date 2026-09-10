---
name: ask-deepseek
description: "当用户明确说“问问 DS/DeepSeek”、要求 DeepSeek 复核或显式调用 $ask-deepseek 时，使用已登录的 chat.deepseek.com 统一模型获取第二意见，并由 Codex 独立核验；不用于让 DeepSeek 操作本机。"
---

# Ask DeepSeek

把 DeepSeek 网页端当作未验证的第二意见来源。Codex 保留执行、核验和最终判断责任。

## 范围与发送授权

- 仅在用户明确要求咨询 DeepSeek 时发送；讨论、维护或测试本技能本身不等于授权发送问题。
- 按“浏览器路由”选择页面通道；只在当前用户明确授权咨询后发送。
- 不读取、复制或导出 Cookie、Bearer Token、密码、API Key，不绕过登录、验证码、额度或平台限制。
- DeepSeek 只接收完成判断所需的脱敏问题和最小附件。密钥、客户资料、个人资料和不必要的完整私有仓库留在本机。
- DeepSeek 不直接读写本机、执行命令、提交 Git、管理账号或发布。

## 浏览器路由

每次咨询在发送前选择一个可控浏览器，并在该次会话内保持同一通道：

1. **EGO Lite 优先。** 可创建受控任务空间、已登录且页面可唯一核验时，用 EGO Lite。它隔离任务标签页并继承登录态。
2. **Chrome 次选。** EGO Lite 未安装、启动失败、不可受控，或无法完成发送前核验时，先说明具体原因，再使用当前 Codex 会话可控的 Chrome。复用已授权的 Chrome 登录态；若需要登录、验证码或二次验证，把 Chrome 交给用户完成。
3. **Codex 内置浏览器兜底。** Chrome 不存在、未向当前会话开放控制权，或同样无法完成发送前核验时，使用当前 Codex 会话的内置浏览器。它只能由该会话直接操控，不能假设外部 Node 适配器可控制它。

发送后状态未知、用户接管浏览器或页面提交证据不唯一时，保留该通道用于只读恢复，不切换到下一层，也不重发。

Windows 采用同一顺序：先实际检查 EGO Lite 是否可用；否则检查当前会话的 Chrome 能力或常见 Chrome 安装路径；最后使用 Codex 内置浏览器。不要把 macOS 安装脚本的限制推断为 Windows 上 EGO Lite 或 Chrome 的可用性结论。

任务结束后，只关闭本次由代理创建且不再需要的页面或任务空间；保留用户原有页面和共享浏览器实例。

## 当前页面契约

2026-09-10 已在真实页面核验以下结构：

- 网页使用单一统一模型。发送流程不再查找、切换或验证旧版模式控件，也不传递模式参数。
- 唯一输入框为 `textarea[name="search"]`，可访问性名称去除首尾空格后为“给 DeepSeek 发送消息”。
- “深度思考”和“智能搜索”是两个独立开关；真实状态取各自唯一 `[aria-pressed]` 控件，不根据颜色或横幅推断。
- 稳定回答位于 `.ds-assistant-message-main-content`。
- 顶部升级横幅可能消失，只能作为页面变更证据，不能作为运行前提。

旧版模式用语只表示用户希望回答更简短或更深入，不对应任何网页模式选择。

## 调用流程

1. **准备问题。** 把任务改写成具体、可核验的问题；只选取必要文本文件。图片等二进制附件通过网页上传控件处理，不塞进文本包。

2. **打开并核验页面。** 按“浏览器路由”打开或复用 `https://chat.deepseek.com/`。确认已登录、页面只有一个目标输入框；未登录时把当前浏览器交给用户正常登录，不索取凭证。

3. **设置独立能力。**
   - 代码审查、方案判断和复杂推理默认开启“深度思考”；明显简单的问题可关闭。
   - 需要当前网页资料时开启“智能搜索”；只审本地材料时关闭。
   - 用户明确指定开关状态时必须遵从。只有精确文本唯一且 `aria-pressed` 可读时才点击一次，并在点击后复核；无法确认所需状态时停在发送前。

4. **发送门禁。** 填入脱敏问题和必要附件，回读输入内容，唯一确认发送按钮后点击一次。点击后以输入框清空、本次问题出现在对话中或对话 URL 变化确认已提交。任何提交状态不确定都禁止重发。

5. **读取与核验。** 等待本次回答容器出现并稳定，读取完整回答。检查引用、版本、事实与推断；必要时查一手资料、运行测试或复现问题，再决定采纳、修改或拒绝。

用户接管 EGO Lite 后是硬停止；只有用户明确说继续，才能按 `ego-browser` 的接管流程恢复。Chrome 或内置浏览器发生同类接管时同样暂停，直到用户明确继续。

## 本地文本打包器

有文本附件时，可先用自带适配器生成带行号的问题包：

```bash
TOOL_DIR="${ASK_DEEPSEEK_TOOL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/ask-deepseek/tool}"
node "$TOOL_DIR/bin/deepseek-oracle.mjs" render \
  --prompt "<经过脱敏的审阅问题>" \
  --file "/absolute/path/to/relevant/file"
```

`render` 不联网，只写入 `tool/sessions/<session-id>/prompt.md` 和 `meta.json`。检查内容后，只有当前用户请求已明确授权咨询时才可发送：

```bash
node "$TOOL_DIR/bin/deepseek-oracle.mjs" ask \
  --session "<session-id>" \
  --send
```

适配器的 `ask` 使用 EGO Lite 和统一模型页面契约，并保留页面已有的独立开关状态。它不能替代 Chrome 或 Codex 内置浏览器的会话级控制；EGO Lite 不可用时，由上面的浏览器路由继续执行。用户要求精确开关状态时，使用所选浏览器的真实页面流程设置并复核，不接受旧版模式参数。

## 不确定状态与恢复

适配器状态为：

- `rendered`：只完成本地打包，或发送前门禁失败。
- `submitting`：已进入发送流程，结果尚未确定。
- `uncertain`：点击后无法确认结果；禁止重发。
- `completed`：回答已保存；禁止重复发送同一 session。

`submitting` 或 `uncertain` 只能对准确的已有对话 URL 做只读恢复：

```bash
node "$TOOL_DIR/bin/deepseek-oracle.mjs" recover \
  --session "<session-id>" \
  --url "https://chat.deepseek.com/a/chat/s/<conversation-id>"
```

不手改 `meta.json` 绕过防重发保护。页面选择器、发送按钮或回答状态无法唯一确认时，保留证据并停止。

适配器接口见 [`tool/README.md`](tool/README.md)。
