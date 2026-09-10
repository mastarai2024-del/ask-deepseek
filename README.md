# Ask DeepSeek

一个私有、fail-closed 的 Codex Skill：把经过脱敏的问题交给已登录的 DeepSeek 网页统一模型做第二意见，再由 Codex 独立核验。DeepSeek 不获得本机执行权。

## 触发方式

- “问问 DS……”
- “让 DeepSeek 复核这个判断。”
- 显式调用 `$ask-deepseek`。

维护或测试本技能本身不会触发真实发送。只有用户明确要求咨询 DeepSeek，发送门禁才成立。

## 2026-09-10 页面升级

DeepSeek 网页已改为单一统一模型。仓库已移除旧版模式选择、参数、元数据门禁和相应测试。

当前实测页面契约：

- 输入框：`textarea[name="search"]`
- 输入框可访问性名称：“给 DeepSeek 发送消息”
- 独立能力开关：“深度思考”“智能搜索”，状态来自 `aria-pressed`
- 回答容器：`.ds-assistant-message-main-content`

升级横幅不是稳定选择器。运行时只依赖输入、发送、提交和回答的可观察状态。

## 工作流

```text
用户明确要求咨询
  ↓
脱敏问题与最小附件
  ↓
render 本地打包（不联网）
  ↓
EGO Lite 核验统一输入区与独立能力开关
  ↓
唯一发送一次并确认提交
  ↓
读取稳定回答
  ↓
Codex 独立核验
```

默认浏览器通道是 EGO Lite 的独立任务空间。登录、验证码或用户接管时遵守 EGO Lite 交接边界；任务完成后关闭本任务创建且无需保留的页面。只有 EGO Lite 不可用时，说明原因后才使用其他已授权浏览器或手动粘贴。

## 目录

```text
.
├── SKILL.md
├── agents/openai.yaml
└── tool/
    ├── bin/deepseek-oracle.mjs
    ├── src/bundle.mjs
    ├── src/deepseek-page.mjs
    ├── src/ego-transport.mjs
    ├── src/chrome.mjs
    └── test/
```

## 安装

这是 Skill 仓库，不是 npm 包。把整个目录克隆到 Codex 技能目录：

```bash
gh repo clone mastarai2024-del/ask-deepseek \
  ~/.codex/skills/ask-deepseek
```

仓库是私有的，克隆需要对应的 GitHub 权限。已有目录先检查本地修改，再按正常 Git 流程更新。

## 本地打包

`render` 不联网、不调用模型：

```bash
cd ~/.codex/skills/ask-deepseek/tool
node bin/deepseek-oracle.mjs render \
  --prompt "审查这个变更的并发边界和回归风险" \
  --file /absolute/path/to/relevant/file.ts
```

输出位于：

```text
tool/sessions/<session-id>/prompt.md
tool/sessions/<session-id>/meta.json
```

附件规则：

- `--file` 可重复；目录会递归收集。
- 跳过 `.git`、`node_modules`、`sessions` 和 `browser-profile`。
- 单文件上限 1 MiB；拒绝二进制文件。
- 路径去重并稳定排序。

发送前仍需检查 `prompt.md`。工具不会自动识别所有商业秘密或个人资料。

## 发送与恢复

只有用户已明确授权咨询时才运行：

```bash
node bin/deepseek-oracle.mjs ask \
  --session <session-id> \
  --send
```

`ask` 通过 EGO Lite 打开已登录页面，确认唯一统一输入框，填入问题，定位发送控件并读取稳定回答；它保留页面已有的独立开关状态，也没有旧版模式参数。需要指定开关状态时，由技能按真实页面流程设置并复核。

会话状态：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `rendered` | 只完成本地打包，或发送前停止 | 检查后可重新发起 |
| `submitting` | 已进入发送流程，结果未确定 | 禁止重发 |
| `uncertain` | 点击后无法确认 | 只读恢复 |
| `completed` | 回答已保存 | 禁止重复发送 |

只读恢复：

```bash
node bin/deepseek-oracle.mjs recover \
  --session <session-id> \
  --url "https://chat.deepseek.com/a/chat/s/<conversation-id>"
```

`recover` 不重新提交问题。

## 诊断

`launch` 和 `probe` 是可选的专用 Chrome + CDP 诊断通道：

```bash
node bin/deepseek-oracle.mjs launch --port 9227
node bin/deepseek-oracle.mjs probe --port 9227
```

专用 profile 位于 `tool/browser-profile/`，不会导入正常 Chrome profile 的 Cookie。`probe` 只记录统一页面契约和匿名控件计数，不发送消息。

## 安全边界

- 不读取或保存 DeepSeek API Key、Cookie 或登录密码。
- 不调用 DeepSeek 私有 API，不绕过登录、验证码、额度或平台限制。
- 不让 DeepSeek 操作本机、Git、账号或发布流程。
- 只发送脱敏后的最小必要内容。
- 点击后状态不确定时禁止自动重发。
- `sessions/`、`browser-profile/`、`last-probe.json` 和日志属于本机运行数据，不提交或外发。

## 验证

需要 Node.js 24 或更新版本：

```bash
cd tool
npm test
```

测试覆盖本地打包、统一页面识别、发送按钮定位、多行输入、回答提取、EGO 发送与只读恢复脚本，以及不确定状态下的防重发行为。
