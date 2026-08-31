import { spawn } from "node:child_process";
import {
  DEFAULT_DEEPSEEK_MODE,
  DEEPSEEK_MODE_LABELS,
  isSupportedDeepSeekMode,
} from "./deepseek-page.mjs";

const RESULT_PREFIX = "DEEPSEEK_ORACLE_RESULT=";
const ERROR_PREFIX = "DEEPSEEK_ORACLE_ERROR=";

export function parsePrefixedJson(output, prefix) {
  const line = output.split(/\r?\n/).filter((item) => item.startsWith(prefix)).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
}

function runEgoScript(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      error.sent = false;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const error = new Error("Ego browser consultation timed out; the message may still be running. Do not resend it.");
        error.sent = true;
        reject(error);
      }
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

export function buildConsultScript({ taskName, prompt, marker, responseTimeoutMs, expectedMode = DEFAULT_DEEPSEEK_MODE }) {
  if (!isSupportedDeepSeekMode(expectedMode)) {
    throw new Error(`Unsupported DeepSeek mode: ${expectedMode}. Use expert or quick.`);
  }
  return `
const TASK_NAME = ${JSON.stringify(taskName)}
const PROMPT = ${JSON.stringify(prompt)}
const MARKER = ${JSON.stringify(marker)}
const EXPECTED_MODE = ${JSON.stringify(expectedMode)}
const EXPECTED_MODE_LABEL = ${JSON.stringify(DEEPSEEK_MODE_LABELS[expectedMode])}
const EXPERT_MODE_LABEL = ${JSON.stringify(DEEPSEEK_MODE_LABELS.expert)}
const QUICK_MODE_LABEL = ${JSON.stringify(DEEPSEEK_MODE_LABELS.quick)}
const PAYLOAD = PROMPT + "\\n\\n请勿在回答中复述以下运行标记。\\n" + MARKER
const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)}
const ERROR_PREFIX = ${JSON.stringify(ERROR_PREFIX)}
const RESPONSE_TIMEOUT_MS = ${responseTimeoutMs}
let sent = false
let currentUrl = ""
let verifiedMode = null

const boxFromQuad = (quad) => {
  const xs = quad.filter((_, index) => index % 2 === 0)
  const ys = quad.filter((_, index) => index % 2 === 1)
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}

const center = (box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 })

const checkedValue = (node) => {
  const value = (node.properties || []).find((property) => property.name === "checked")?.value?.value
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return null
}

const modeRadioNodes = (tree, name) => tree.nodes
  .filter((node) => node.role?.value === "radio" && String(node.name?.value || "") === name)
  .map((node) => ({ name, checked: checkedValue(node), backendDOMNodeId: node.backendDOMNodeId || null }))

const inspectMode = (tree) => {
  const expert = modeRadioNodes(tree, EXPERT_MODE_LABEL)
  const quick = modeRadioNodes(tree, QUICK_MODE_LABEL)
  if (expert.length !== 1 || quick.length !== 1) {
    return { mode: "unknown", reason: "Expert and quick mode controls must each be uniquely identifiable.", expert, quick }
  }
  if (expert[0].checked === true && quick[0].checked === false) return { mode: "expert", reason: null, expert, quick }
  if (quick[0].checked === true && expert[0].checked === false) return { mode: "quick", reason: null, expert, quick }
  return { mode: "unknown", reason: "Expert and quick mode selection states are missing or contradictory.", expert, quick }
}

const readModeState = async () => inspectMode(await cdp("Accessibility.getFullAXTree"))

const ensureExpectedMode = async () => {
  let state = await readModeState()
  if (state.mode === EXPECTED_MODE) {
    verifiedMode = state.mode
    return state
  }
  const expectedControl = state[EXPECTED_MODE]?.[0]
  if (!expectedControl?.backendDOMNodeId || !["expert", "quick"].includes(state.mode)) {
    throw new Error("DeepSeek " + EXPECTED_MODE_LABEL + " could not be uniquely confirmed (" + state.reason + "). No question was sent.")
  }

  await snapshotText()
  await click("@" + expectedControl.backendDOMNodeId, { label: "select DeepSeek mode" })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await wait(0.5)
    state = await readModeState()
    if (state.mode === EXPECTED_MODE) {
      verifiedMode = state.mode
      return state
    }
  }
  throw new Error("DeepSeek " + EXPECTED_MODE_LABEL + " could not be confirmed after switching. No question was sent.")
}

const readPageState = async () => {
  const expression = "(() => {" +
    "const marker = " + JSON.stringify(MARKER) + ";" +
    "const answers = [...document.querySelectorAll('.ds-assistant-message-main-content')].map((el) => (el.innerText || '').trim()).filter(Boolean);" +
    "const composer = document.querySelector('textarea[name=\\\"search\\\"]');" +
    "return { markerPresent: (document.body.innerText || '').includes(marker), composerLength: composer?.value?.length ?? -1, assistantCount: answers.length, lastAnswer: answers.at(-1) || '', url: location.href };" +
    "})()"
  const response = await cdp("Runtime.evaluate", { expression, returnByValue: true })
  if (response.exceptionDetails) throw new Error("Unable to read DeepSeek page state.")
  return response.result.value
}

try {
  await useOrCreateTaskSpace(TASK_NAME)
  await openOrReuseTab("https://chat.deepseek.com/", { wait: true, timeout: 20 })
  const info = await pageInfo()
  currentUrl = String(info.url || "")
  if (String(info.url || "").includes("sign_in")) throw new Error("DeepSeek login is required in the Ego browser.")
  await ensureExpectedMode()
  const beforeState = await readPageState()
  const beforeTree = await cdp("Accessibility.getFullAXTree")
  const composer = beforeTree.nodes.find((node) => node.role?.value === "textbox" && node.backendDOMNodeId)
  if (!composer) throw new Error("DeepSeek composer was not found.")

  await fillInput('textarea[name="search"]', PAYLOAD)
  await wait(0.5)
  const tree = await cdp("Accessibility.getFullAXTree")
  const liveComposer = tree.nodes.find((node) => node.role?.value === "textbox" && node.backendDOMNodeId)
  if (!liveComposer) throw new Error("DeepSeek composer disappeared before send.")
  const inputModel = await cdp("DOM.getBoxModel", { backendNodeId: liveComposer.backendDOMNodeId })
  const inputBox = boxFromQuad(inputModel.model.content)
  const candidates = []
  for (const node of tree.nodes) {
    if (node.role?.value !== "button" || !node.backendDOMNodeId) continue
    try {
      const model = await cdp("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId })
      const box = boxFromQuad(model.model.content)
      const point = center(box)
      const verticallyAdjacent = point.y >= inputBox.top - 20 && point.y <= inputBox.bottom + 80
      if (verticallyAdjacent && point.x >= inputBox.left + (inputBox.right - inputBox.left) * 0.72) {
        candidates.push({ backendDOMNodeId: node.backendDOMNodeId, box, point })
      }
    } catch {}
  }
  if (!candidates.length) throw new Error("No DeepSeek send button was found near the composer.")
  candidates.sort((a, b) => b.point.x - a.point.x)
  if (candidates.length > 1 && candidates[0].point.x - candidates[1].point.x < 8) throw new Error("DeepSeek send button candidates are ambiguous.")
  await snapshotText()
  await click("@" + candidates[0].backendDOMNodeId, { label: "send DeepSeek consultation" })
  sent = true

  let committed = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await readPageState()
    if (state.markerPresent && state.composerLength === 0) { committed = true; break }
    await wait(0.5)
  }
  if (!committed) throw new Error("DeepSeek did not expose the submitted run marker; send state is uncertain.")

  const startedAt = Date.now()
  let previous = ""
  let stableSince = 0
  let resultEmitted = false
  while (Date.now() - startedAt < RESPONSE_TIMEOUT_MS) {
    const state = await readPageState()
    const answer = state.assistantCount > beforeState.assistantCount ? state.lastAnswer : ""
    if (answer && answer === previous) {
      if (!stableSince) stableSince = Date.now()
      if (Date.now() - stableSince >= 6000) {
        cliLog(RESULT_PREFIX + JSON.stringify({
          answer,
          url: state.url,
          sent: true,
          expectedMode: EXPECTED_MODE,
          verifiedMode,
        }))
        resultEmitted = true
        break
      }
    } else {
      stableSince = 0
    }
    previous = answer
    await wait(0.5)
  }
  if (!resultEmitted) throw new Error("DeepSeek response did not stabilize before timeout; do not resend this session.")
} catch (error) {
  try { currentUrl = String((await pageInfo()).url || currentUrl) } catch {}
  cliLog(ERROR_PREFIX + JSON.stringify({
    message: String(error?.message || error),
    sent,
    url: currentUrl,
    expectedMode: EXPECTED_MODE,
    verifiedMode,
  }))
}
`;
}

export function shouldCleanupConsult({ result, failure, hardStop }) {
  // A successful result is safe to close. A failed/unknown run is only safe to
  // close when the script proved it never clicked Send. Preserve the task
  // space for read-only recovery whenever send state is uncertain.
  return Boolean(result) || (!hardStop && Boolean(failure) && failure.sent === false);
}

export function formatUnstructuredResultError(code) {
  return `Ego browser returned no structured result (exit ${code}); send state is uncertain. Do not resend this session.`;
}

export function shouldCleanupRecovery({ result, failure, hardStop }) {
  return !hardStop && Boolean(result || failure);
}

export function buildRecoverScript({ taskName, marker, chatUrl }) {
  return `
const TASK_NAME = ${JSON.stringify(taskName)}
const MARKER = ${JSON.stringify(marker)}
const CHAT_URL = ${JSON.stringify(chatUrl)}
const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)}
const ERROR_PREFIX = ${JSON.stringify(ERROR_PREFIX)}
try {
  await useOrCreateTaskSpace(TASK_NAME)
  await openOrReuseTab(CHAT_URL, { wait: true, timeout: 20 })
  const expression = "(() => {" +
    "const marker = " + JSON.stringify(MARKER) + ";" +
    "const answers = [...document.querySelectorAll('.ds-assistant-message-main-content')].map((el) => (el.innerText || '').trim()).filter(Boolean);" +
    "return { markerPresent: (document.body.innerText || '').includes(marker), answer: answers.at(-1) || '', url: location.href };" +
    "})()"
  const response = await cdp("Runtime.evaluate", { expression, returnByValue: true })
  const state = response.result?.value
  if (!state?.markerPresent) throw new Error("The requested DeepSeek conversation does not contain this session marker.")
  if (!state.answer) throw new Error("The DeepSeek conversation does not contain a final answer.")
  cliLog(RESULT_PREFIX + JSON.stringify({ answer: state.answer, url: state.url, sent: false }))
} catch (error) {
  cliLog(ERROR_PREFIX + JSON.stringify({ message: String(error?.message || error), sent: false }))
}
`;
}

async function cleanupTask(taskName) {
  const script = `
const result = await completeTaskSpace(${JSON.stringify(taskName)}, { keep: false })
cliLog(JSON.stringify(result))
`;
  try {
    await runEgoScript(script, 15_000);
  } catch {
    // Cleanup failure does not erase a completed consultation result.
  }
}

export async function consultViaEgo({
  prompt,
  sessionId,
  responseTimeoutMs = 120_000,
  expectedMode = DEFAULT_DEEPSEEK_MODE,
}) {
  if (!isSupportedDeepSeekMode(expectedMode)) {
    throw new Error(`Unsupported DeepSeek mode: ${expectedMode}. Use expert or quick.`);
  }
  const taskName = `DeepSeek Oracle ${sessionId}`;
  const marker = `[DEEPSEEK_ORACLE_RUN:${sessionId}]`;
  const script = buildConsultScript({ taskName, prompt, marker, responseTimeoutMs, expectedMode });
  let processResult;
  try {
    processResult = await runEgoScript(script, responseTimeoutMs + 30_000);
  } catch (error) {
    if (error.sent === undefined) error.sent = false;
    throw error;
  }
  const combinedOutput = `${processResult.stdout}\n${processResult.stderr}`;
  const result = parsePrefixedJson(combinedOutput, RESULT_PREFIX);
  const failure = parsePrefixedJson(combinedOutput, ERROR_PREFIX);
  const hardStop = /user is controlling|hard stop|taken control/i.test(combinedOutput);
  const validResult = result?.expectedMode === expectedMode && result.verifiedMode === expectedMode;
  if (shouldCleanupConsult({ result: validResult ? result : null, failure, hardStop })) await cleanupTask(taskName);
  if (result) {
    if (!validResult) {
      const error = new Error(`DeepSeek submitted a response without verified ${expectedMode} mode; do not reuse this session.`);
      error.sent = true;
      error.url = result.url || null;
      throw error;
    }
    return result;
  }
  if (failure) {
    const error = new Error(failure.message);
    error.sent = Boolean(failure.sent);
    error.url = failure.url || null;
    error.expectedMode = failure.expectedMode || null;
    error.verifiedMode = failure.verifiedMode || null;
    throw error;
  }
  const error = new Error(hardStop
    ? "The user took control of the Ego browser task. Resume only after explicit confirmation."
    : formatUnstructuredResultError(processResult.code));
  error.sent = true;
  throw error;
}

export async function recoverViaEgo({ sessionId, chatUrl }) {
  const taskName = `DeepSeek Oracle recovery ${sessionId}`;
  const marker = `[DEEPSEEK_ORACLE_RUN:${sessionId}]`;
  const script = buildRecoverScript({ taskName, marker, chatUrl });
  const processResult = await runEgoScript(script, 30_000);
  const combinedOutput = `${processResult.stdout}\n${processResult.stderr}`;
  const result = parsePrefixedJson(combinedOutput, RESULT_PREFIX);
  const failure = parsePrefixedJson(combinedOutput, ERROR_PREFIX);
  const hardStop = /user is controlling|hard stop|taken control/i.test(combinedOutput);
  if (shouldCleanupRecovery({ result, failure, hardStop })) await cleanupTask(taskName);
  if (result) return result;
  if (failure) throw new Error(failure.message);
  if (hardStop) throw new Error("The user took control of the Ego browser recovery task. Resume only after explicit confirmation.");
  throw new Error(`Ego browser recovery returned no structured result (exit ${processResult.code}).`);
}
