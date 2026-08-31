# DeepSeek Web Oracle

这是一个由 `Ask DeepSeek` 技能调用的 DeepSeek 网页端适配器，借鉴 Oracle 的两段式流程：

1. 本地将问题和指定文件渲染为带行号的 Markdown 包。
2. 仅在你显式允许时，使用隔离的 Ego 浏览器任务空间连接 `chat.deepseek.com`。

它不使用 API Key，不读取或复制主浏览器 Cookie，不调用 DeepSeek 私有 API。会话记录和可选诊断 profile 只写入本适配器目录下的 `sessions/`、`browser-profile/` 等路径；默认登录态由 Ego 浏览器任务空间提供。

## 当前状态

`render`、`launch`、`probe`、`ask` 与 `recover` 已完成。已在真实 DeepSeek 页面验证长文本输入、发送控件定位、消息提交、最终回答读取，以及无发送的模式状态切换验证；发送必须显式带 `--send`，选择器或回复状态不明确时会停止。

默认的 `ask` / `recover` 通道使用 Ego 浏览器任务空间。`launch` / `probe` 是独立 Chrome + CDP 的低层诊断命令，不是默认发送通道。

未指定模式时，`render` 和 `ask` 默认使用“专家模式”。用户明确要求快速模式时，可传入 `--mode quick`；明确要求专家模式时，可传入 `--mode expert`。发送前，适配器会确认唯一的“专家模式”和“快速模式” radio 控件及其 `checked` 状态；如果当前模式不符合期望，只会对可唯一确认的目标控件点击一次，再次确认目标模式已选。控件缺失、重复、状态矛盾或切换未确认时，工具会在发送前停止，不会静默改用另一种模式，也不会使用坐标猜测点击。

## 使用

在此目录执行（或从技能目录调用）。下面是不带参数时的默认专家模式：

```bash
node bin/deepseek-oracle.mjs render \
  --prompt "审查这个变更的边界条件和回归风险" \
  --file ../some-project/src
```

这会在 `sessions/<时间>/prompt.md` 写入将要发送的完整内容。它不会连接 DeepSeek，并会打印可直接传给 `ask` 的 `Session ID`。

用户明确要求快速模式时，在渲染阶段指定：

```bash
node bin/deepseek-oracle.mjs render \
  --prompt "审查这个变更的边界条件和回归风险" \
  --file ../some-project/src \
  --mode quick
```

`meta.json` 会记录该次会话的 `expectedMode`。`ask` 不带 `--mode` 时沿用它；用户明确更改模式时，`ask` 也可带 `--mode expert` 或 `--mode quick`。

可选：启动专用 Chrome 做 CDP 诊断：

```bash
node bin/deepseek-oracle.mjs launch
```

在打开的诊断窗口中自行登录 DeepSeek。登录后运行：

```bash
node bin/deepseek-oracle.mjs probe
```

`probe` 会将匿名的页面控件特征和可识别的当前模式保存为 `last-probe.json`，用于实现并验证精确的发送/回复抓取逻辑。不要把 `browser-profile/`、`sessions/` 或探测结果提交、上传或分享。

提交已经渲染的 session：

```bash
node bin/deepseek-oracle.mjs ask \
  --session <id> \
  --send
```

用户明确要求快速模式且尚未在 render 阶段指定时，可显式选择：

```bash
node bin/deepseek-oracle.mjs ask \
  --session <id> \
  --send \
  --mode quick
```

如果所选模式无法确认，session 会留在 `rendered`，因为尚未发送；不要改用另一种模式。只有点击发送后超时，session 才会标记为 `uncertain`，工具拒绝自动重发。确认 DeepSeek 对话 URL 后可只读恢复：

```bash
node bin/deepseek-oracle.mjs recover \
  --session <id> \
  --url https://chat.deepseek.com/a/chat/s/<conversation-id>
```

## 验证

```bash
npm test
```

## 不是的功能

- 不是 DeepSeek API 客户端。
- 不绕过登录、验证码、账户额度或平台限制。
- 不会从正常 Chrome profile 读取 Cookie。
- 支持用户明确选择的专家模式或快速模式，不支持其他模式的自动发送。
- 页面选择器、提交状态或回答状态无法唯一确认时，会停止并保留 session，不会猜测点击或重复请求。
