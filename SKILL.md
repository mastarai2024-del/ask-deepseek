---
name: ask-deepseek
description: "当用户说“问问DS”“问下DS”“问问 DeepSeek”“让 DeepSeek 复核”或明确要求咨询 DeepSeek 时（也可显式调用 $ask-deepseek / Ask_deepseek），使用已登录的 chat.deepseek.com 网页获取第二意见，并由 Codex 独立核验；不用于让 DeepSeek 操作本机。"
---

# Ask DeepSeek

把 DeepSeek 网页端当作第二意见来源。DeepSeek 的回答不是事实、代码变更或发布决定；Codex 必须自行核验并负责最终操作。

## 范围与安全边界

- 仅在用户明确要求咨询 DeepSeek，或出现“问问DS”“问下DS”“问问 DeepSeek”“让 DeepSeek 复核”“用 DS 看一下”等表达时使用。
- 适配器通过已登录的 `chat.deepseek.com` 网页工作，不使用 DeepSeek API，不读取、复制或导出 Cookie、Bearer Token、密码、API Key，也不绕过登录、验证码、额度或平台限制。
- 适配器运行时不安装全局 Oracle，不修改 `~/.oracle`、DSH 或其他全局配置；技能目录只存放本技能代码和会话文件。
- 不让 DeepSeek 直接读写本机、执行命令、提交 Git、管理账号或代替 Codex 发布。
- 发送前检查问题和附件。密钥、Cookie、密码、客户资料、个人资料和不必要的完整私有仓库必须先移除或脱敏；无法安全脱敏时，先把拟发送范围告知用户并请求确认。
- `--send` 是真实发送闸门。只有用户明确表达咨询意图且内容安全时才使用；否则只做本地渲染。

## 模式选择与发送门禁

- 默认使用 DeepSeek 的“专家模式”。用户明确要求“快速模式”时才使用 `--mode quick`；明确要求“专家模式”时使用 `--mode expert`。只支持这两种模式，“识图模式”等其他状态不能自动发送。
- 在填入问题之前，适配器会从真实页面的可访问性树中确认唯一的 `role=radio` 控件“专家模式”和“快速模式”，并读取各自的 `checked` 状态。
- 当前模式与期望模式不一致时，只会对唯一可验证的目标模式控件做一次语义点击，再重新检查状态。只有期望模式已选中、另一模式未选中时才允许继续填充和发送。
- 控件缺失、重复、状态冲突、切换后未确认或页面结构变化时，停止在发送前，不使用坐标猜测点击，不填入问题，不发送任何内容，也不会静默改用另一种模式。
- 渲染时写入所选的 `expectedMode`；成功发送后只有 `verifiedMode === expectedMode` 才是实际发送的证据。`probe` 也会报告当前可识别的模式，但它不发送消息。

## 适配器位置与前提

默认使用技能自带的适配器；复制技能到其他环境时可用 `ASK_DEEPSEEK_TOOL_DIR` 指向另一份兼容适配器：

```bash
TOOL_DIR="${ASK_DEEPSEEK_TOOL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/ask-deepseek/tool}"
test -f "$TOOL_DIR/bin/deepseek-oracle.mjs" || {
  echo "Ask DeepSeek adapter not found: $TOOL_DIR" >&2
  exit 1
}
```

自动发送通道需要本机可用的 `ego-browser` 和已登录的 DeepSeek 页面。没有这两项时，不尝试安装、导入 Cookie 或调用私有接口，改为生成手动粘贴包，让用户在自己的 DeepSeek 网页中发送并把回答贴回。

## 调用流程

1. **改写问题并限量选取附件。** 把当前任务改写成具体、可核验的问题，只附加完成判断所需的文件；可重复使用 `--file`，不要把整个私有仓库发送出去。

2. **本地渲染。** `render` 不联网，只生成带行号的 `prompt.md` 和 `meta.json`，并打印 session ID。未指定 `--mode` 时会写入 `expert`；用户明确要求快速模式时，在 `render` 和 `ask` 使用 `--mode quick`。渲染后检查待发送内容：

   ```bash
   TOOL_DIR="${ASK_DEEPSEEK_TOOL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/ask-deepseek/tool}"
   node "$TOOL_DIR/bin/deepseek-oracle.mjs" render \
     --prompt "<经过脱敏的审阅问题>" \
     --file "/absolute/path/to/relevant/file"
   ```

   用户明确指定快速模式时：

   ```bash
   node "$TOOL_DIR/bin/deepseek-oracle.mjs" render \
     --prompt "<经过脱敏的审阅问题>" \
     --file "/absolute/path/to/relevant/file" \
     --mode quick
   ```

3. **明确发送。** 用户已明确说“问问DS”等关键词、附件已脱敏且范围清楚时，使用渲染得到的 session ID：

   ```bash
   TOOL_DIR="${ASK_DEEPSEEK_TOOL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/ask-deepseek/tool}"
   node "$TOOL_DIR/bin/deepseek-oracle.mjs" ask \
     --session "<session-id>" \
     --send
   ```

   `ask` 不带 `--mode` 时沿用 render 写入的 `expectedMode`；用户明确更改模式时才传入 `--mode expert` 或 `--mode quick`。

   若内容敏感、范围不清或可能大范围外发，先列出问题摘要和文件清单，等待用户确认，不发送。

4. **独立核验。** 阅读命令输出和 `sessions/<session-id>/answer.md`，并确认 `meta.json` 中 `expectedMode === verifiedMode`。再检查回答是否引用真实文件和行号、是否把推断写成事实、建议是否适用于当前版本。必要时查阅一手资料、运行测试或复现问题，再决定采纳、修改或拒绝。

5. **不确定状态只读恢复。** 点击发送后超时、进程中断或状态为 `uncertain` 时，禁止再次 `ask --send`。先取得准确的 DeepSeek 对话 URL，再恢复已有回答：

   ```bash
   TOOL_DIR="${ASK_DEEPSEEK_TOOL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/ask-deepseek/tool}"
   node "$TOOL_DIR/bin/deepseek-oracle.mjs" recover \
     --session "<session-id>" \
     --url "https://chat.deepseek.com/a/chat/s/<conversation-id>"
   ```

   `recover` 只读已有对话，不重新提交问题。

## 会话状态

适配器在 `sessions/<session-id>/meta.json` 中记录状态：

- `rendered`：只完成本地渲染，或在模式门禁中失败；尚未发送。
- `submitting`：已进入发送流程，结果尚未确定；禁止重复发送。
- `uncertain`：点击后无法确认结果；禁止重复发送，只能用准确 URL 做只读恢复。
- `completed`：回答已保存；禁止重复发送同一 session。

所选模式无法确认时，没有点击发送，session 会回到 `rendered` 并记录原因；用户确认页面已切换或页面结构恢复后才能重新发起。点击发送后失败才会保留为 `uncertain`。不要手动修改 `meta.json` 绕过保护。成功任务空间会清理；不确定任务空间会保留以便恢复。

## 故障处理

- 未登录：让用户在 Ego 浏览器的 DeepSeek 页面完成正常登录，不索取或处理登录凭证。
- 所选模式检测或切换失败：停止在发送前，报告可观察到的原因；不要改用另一种模式、坐标点击或自动重试。
- 页面选择器、发送按钮、提交状态或回答状态无法唯一确认：停止，保留 session，不猜测点击，不自动重试。
- 工具不存在或 `ego-browser` 不可用：说明自动通道不可用，提供手动粘贴包；不要自动安装全局组件或修改其他会话配置。
- DeepSeek 的建议始终标为“未验证第二意见”，不能替代 Codex 的测试、审查和发布门禁。

适配器的详细接口和限制见 [`tool/README.md`](tool/README.md)。
