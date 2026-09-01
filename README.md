# Ask DeepSeek

一个私有、fail-closed 的 Codex Skill，用来把经过脱敏的技术问题交给已登录的 DeepSeek 网页端做第二意见，再由 Codex 独立核验。它不把 DeepSeek 的回答直接当成事实，也不让 DeepSeek 操作本机。

## 适合什么场景

当你说下面这类话时，Skill 会被触发：

- “问问 DS……”
- “问下 DeepSeek……”
- “让 DeepSeek 复核这个判断。”
- 显式调用 `$ask-deepseek`。

典型用途是请 DeepSeek 审查一个设计判断、报错解释、边界条件或技术取舍。Codex 会先把上下文改写成具体问题，生成带行号的附件包，再在已登录的 `chat.deepseek.com` 页面发送；拿到回答后，Codex 仍会检查证据、版本匹配度和可执行性，必要时运行测试或查阅一手资料。

它不适合这些情况：

- 让 DeepSeek 直接修改文件、执行命令、提交 Git 或发布内容。
- 需要密钥、Cookie、客户资料、完整私有仓库或其他无法脱敏的数据。
- 想绕过 DeepSeek 登录、验证码、额度、网页限制或私有 API。

## 工作方式

```text
Codex 请求
  ↓
重写问题，选择最小附件
  ↓
render 本地打包（不联网）
  ↓
模式门禁：专家模式 / 快速模式
  ↓
已登录 Codex 内置浏览器发送
  ↓
读取稳定回答
  ↓
Codex 独立核验并采纳、修改或拒绝
```

默认咨询使用 DeepSeek 的“专家模式”。只有用户明确要求时才切换到“快速模式”；其他模式不会自动发送。发送前会从页面可访问性树确认两个唯一的 radio 控件——“专家模式”和“快速模式”——并核对 `checked` 状态。控件缺失、重复、状态冲突或切换后仍未确认时，流程会在发送前停止，不会猜坐标，也不会静默换用另一种模式。

## 目录结构

```text
.
├── SKILL.md                # Codex Skill 入口和安全边界
├── agents/openai.yaml      # Agent 界面元数据
└── tool/
    ├── bin/deepseek-oracle.mjs
    ├── src/bundle.mjs              # 本地问题与文件打包
    ├── src/deepseek-page.mjs      # 模式、发送按钮、回答提取的纯逻辑
    ├── src/ego-transport.mjs      # 旧版 EGO 备用通道
    ├── src/chrome.mjs             # 可选 CDP 诊断
    └── test/
```

当前版本优先使用 Codex 内置浏览器完成自动咨询。`tool/bin/deepseek-oracle.mjs ask` 是旧版 EGO 备用接口；单独的 Node CLI 拿不到 Codex 内置浏览器句柄，所以不应把它当作内置浏览器发送器。

## 安装

这是 Skill 仓库，不是 npm 包。把整个目录放在你的 Codex 技能目录中，保持 `SKILL.md` 位于仓库根目录：

```bash
gh repo clone mastarai2024-del/ask-deepseek \
  ~/.codex/skills/ask-deepseek
```

仓库当前是私有的，克隆需要 GitHub 访问权限。如果目录已经存在，用 Git 的常规更新流程拉取；不要直接覆盖已有本地修改。

## 本地打包

`render` 不联网、不调用模型，只生成待发送内容：

```bash
cd ~/.codex/skills/ask-deepseek/tool
node bin/deepseek-oracle.mjs render \
  --prompt "审查这个变更的并发边界和回归风险" \
  --file /absolute/path/to/relevant/file.ts
```

渲染结果会写入：

```text
tool/sessions/<session-id>/prompt.md
tool/sessions/<session-id>/meta.json
```

输出包含会话 ID。`prompt.md` 是带行号的 Markdown 包；`meta.json` 记录状态、期望模式、时间戳和附件路径。

默认专家模式。用户明确要求快速模式时：

```bash
node bin/deepseek-oracle.mjs render \
  --prompt "快速检查这个正则是否覆盖 BOM 和 CRLF" \
  --file /absolute/path/to/parser.mjs \
  --mode quick
```

附件规则由 `tool/src/bundle.mjs` 执行：

- `--file` 可以重复使用，目录会递归收集。
- 自动跳过 `.git`、`node_modules`、`sessions` 和 `browser-profile`。
- 单个文件上限 1 MiB。
- 拒绝二进制文件。
- 相同路径去重，输出按显示路径排序。

发送前仍然要人工检查 `prompt.md`。该命令不会自动判断商业秘密、个人资料或上下文中偶然出现的敏感信息。

## 会话状态

`meta.json` 的状态机是防重发设计：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `rendered` | 只完成本地渲染，或发送前门禁失败 | 检查内容后可重新发起 |
| `submitting` | 已进入发送流程，结果未确定 | 禁止重发 |
| `uncertain` | 点击发送后无法确认结果 | 只允许只读恢复 |
| `completed` | 回答已保存 | 禁止重发同一会话 |

状态文件权限是 `0600`，会话数据保留在本仓库的 `tool/sessions/` 下并已被 Git 忽略。不要手工改 `meta.json` 绕过保护。

## EGO 备用通道与诊断

正常单次咨询应使用 Codex 内置浏览器。只有在用户明确要求批量/脚本化，或确认内置浏览器不可用并同意备用通道时，才使用旧版 EGO 接口：

```bash
node bin/deepseek-oracle.mjs ask \
  --session <session-id> \
  --send
```

这个命令必须带 `--send`。发送结果无法确认时，会话会停在 `uncertain`；确认准确的 DeepSeek 对话 URL 后，可只读恢复已有回答：

```bash
node bin/deepseek-oracle.mjs recover \
  --session <session-id> \
  --url "https://chat.deepseek.com/a/chat/s/<conversation-id>"
```

`recover` 不重新提交问题。它先确认目标页面包含本次运行标记，再保存最后的回答。

还有两个低层诊断命令用于专用 Chrome + CDP：

```bash
node bin/deepseek-oracle.mjs launch --port 9227
node bin/deepseek-oracle.mjs probe --port 9227
```

`launch` 使用仓库内的独立 `tool/browser-profile/`，不会导入正常 Chrome profile 的 Cookie。你需要自己在打开的窗口里登录。`probe` 只读取页面控件特征和当前模式，不发送消息。

## 安全模型

- 不需要、不读取、不保存 DeepSeek API Key。
- 不读取或复制正常浏览器 Cookie。
- 不调用 DeepSeek 私有 API。
- 不绕过登录、验证码、额度或平台限制。
- 不安装全局 Oracle，也不修改 `~/.oracle`、DSH 或其他全局配置。
- 自动发送必须通过模式与发送控件门禁；证据不足时停止。
- 会话、浏览器 profile、日志和探测结果只保存在本仓库，且不应提交、上传或分享。

DeepSeek 的回答始终是“未验证的第二意见”。是否采纳、如何实现、是否发布，仍由 Codex 和用户负责。

## 验证

需要 Node.js 24 或更新版本：

```bash
cd tool
npm test
```

测试覆盖：

- 问题包生成、行号和模式元数据。
- 专家/快速模式的可访问性证据检查。
- 发送按钮定位和多行输入框场景。
- 新回答提取。
- EGO 发送、恢复和清理脚本的语法与 fail-closed 行为。
- 结构化结果解析。

## 仓库边界

这个仓库是私有 Skill，不发布 npm 包，也没有包含登录凭证。`sessions/`、`browser-profile/`、`last-probe.json` 和 `*.log` 属于本机运行数据，不要提交或外发。
