import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DEEPSEEK_MODE,
  DEEPSEEK_MODE_LABELS,
  inspectDeepSeekMode,
  isSupportedDeepSeekMode,
  newAssistantText,
  selectSendButton,
} from "../src/deepseek-page.mjs";
import { buildConsultScript, buildRecoverScript, formatUnstructuredResultError, parsePrefixedJson, shouldCleanupConsult, shouldCleanupRecovery } from "../src/ego-transport.mjs";

function radio(name, checked, backendDOMNodeId) {
  return {
    role: { value: "radio" },
    name: { value: name },
    backendDOMNodeId,
    properties: [{ name: "checked", value: { value: checked } }],
  };
}

test("inspectDeepSeekMode confirms the observed Expert Mode evidence", () => {
  const state = inspectDeepSeekMode({
    nodes: [
      radio(DEEPSEEK_MODE_LABELS.quick, "false", 967),
      radio(DEEPSEEK_MODE_LABELS.expert, "true", 991),
      radio("识图模式", "false", 1019),
    ],
  });
  assert.equal(DEFAULT_DEEPSEEK_MODE, "expert");
  assert.equal(isSupportedDeepSeekMode("expert"), true);
  assert.equal(isSupportedDeepSeekMode("quick"), true);
  assert.equal(isSupportedDeepSeekMode("other"), false);
  assert.equal(state.mode, "expert");
  assert.equal(state.expert[0].backendDOMNodeId, 991);
  assert.equal(state.quick[0].checked, false);
});

test("inspectDeepSeekMode detects Fast Mode but fails closed on ambiguous evidence", () => {
  const fast = inspectDeepSeekMode({
    nodes: [
      radio(DEEPSEEK_MODE_LABELS.quick, true, 1),
      radio(DEEPSEEK_MODE_LABELS.expert, false, 2),
    ],
  });
  assert.equal(fast.mode, "quick");

  const contradictory = inspectDeepSeekMode({
    nodes: [
      radio(DEEPSEEK_MODE_LABELS.quick, true, 1),
      radio(DEEPSEEK_MODE_LABELS.expert, true, 2),
    ],
  });
  assert.equal(contradictory.mode, "unknown");

  const missing = inspectDeepSeekMode({ nodes: [radio(DEEPSEEK_MODE_LABELS.quick, true, 1)] });
  assert.equal(missing.mode, "unknown");
});

test("selectSendButton chooses the rightmost aligned control", () => {
  const inputBox = { left: 346, right: 1096, top: 420, bottom: 542 };
  const attachment = { backendDOMNodeId: 644, box: { left: 1017, right: 1052, top: 496, bottom: 530 } };
  const send = { backendDOMNodeId: 651, box: { left: 1061, right: 1096, top: 496, bottom: 530 } };
  assert.equal(selectSendButton(inputBox, [attachment, send]).backendDOMNodeId, 651);
});

test("selectSendButton handles a tall multiline composer", () => {
  const inputBox = { left: 349.5, right: 1095.5, top: 298, bottom: 622 };
  const attachment = { backendDOMNodeId: 367, box: { left: 1017.5, right: 1051.5, top: 634, bottom: 668 } };
  const send = { backendDOMNodeId: 374, box: { left: 1061.5, right: 1095.5, top: 634, bottom: 668 } };
  assert.equal(selectSendButton(inputBox, [attachment, send]).backendDOMNodeId, 374);
});

test("newAssistantText starts after a standalone run marker", () => {
  const before = ["旧对话", "内容由 AI 生成，请仔细甄别"];
  const after = [
    ...before,
    "第一段问题",
    "第二段附件",
    "[DEEPSEEK_ORACLE_RUN:test-123]",
    "已思考（用时 1 秒）",
    "这是本次回答",
    "内容由 AI 生成，请仔细甄别",
  ];
  assert.deepEqual(
    newAssistantText(before, after, "[DEEPSEEK_ORACLE_RUN:test-123]"),
    ["已思考（用时 1 秒）", "这是本次回答"],
  );
});

test("newAssistantText handles a run marker embedded in a long user node", () => {
  const marker = "[DEEPSEEK_ORACLE_RUN:test-embedded]";
  const before = ["旧对话"];
  const after = ["旧对话", `多行问题和附件内容……${marker}`, "最终回答"];
  assert.deepEqual(newAssistantText(before, after, marker), ["最终回答"]);
});

test("generated Ego consult script is syntactically valid", () => {
  const script = buildConsultScript({
    taskName: "syntax check",
    prompt: "first line\nsecond line",
    marker: "[DEEPSEEK_ORACLE_RUN:test]",
    responseTimeoutMs: 1000,
  });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(script));
  assert.match(script, /await click\("@" \+ candidates\[0\]\.backendDOMNodeId/);
  assert.doesNotMatch(script, /Input\.dispatchMouseEvent/);
  assert.match(script, /\.ds-assistant-message-main-content/);
  assert.match(script, /const EXPECTED_MODE = "expert"/);
  assert.match(script, /ensureExpectedMode/);
  assert.match(script, /select DeepSeek mode/);
  const quickScript = buildConsultScript({
    taskName: "quick mode accepted",
    prompt: "test",
    marker: "[DEEPSEEK_ORACLE_RUN:test]",
    responseTimeoutMs: 1000,
    expectedMode: "quick",
  });
  assert.match(quickScript, /const EXPECTED_MODE = "quick"/);
  assert.throws(
    () => buildConsultScript({
      taskName: "unsupported mode rejected",
      prompt: "test",
      marker: "[DEEPSEEK_ORACLE_RUN:test]",
      responseTimeoutMs: 1000,
      expectedMode: "other",
    }),
    /Unsupported DeepSeek mode/,
  );
});

test("parsePrefixedJson ignores unrelated browser output", () => {
  const output = "stdout content\n\nstderr content\nDEEPSEEK_ORACLE_RESULT={\"answer\":\"OK\"}\n";
  assert.deepEqual(parsePrefixedJson(output, "DEEPSEEK_ORACLE_RESULT="), { answer: "OK" });
  assert.equal(parsePrefixedJson("DEEPSEEK_ORACLE_RESULT={broken", "DEEPSEEK_ORACLE_RESULT="), null);
});

test("generated recovery script is read-only and syntactically valid", () => {
  const script = buildRecoverScript({
    taskName: "recovery syntax check",
    marker: "[DEEPSEEK_ORACLE_RUN:test]",
    chatUrl: "https://chat.deepseek.com/a/chat/s/test",
  });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(script));
  assert.match(script, /ds-assistant-message-main-content/);
  assert.doesNotMatch(script, /fillInput|await click/);
});

test("an unstructured consult result fails closed as sent/uncertain", () => {
  const source = requireSource("../src/ego-transport.mjs");
  assert.match(source, /error\.sent = true/);
  assert.match(formatUnstructuredResultError(0), /state is uncertain/);
  assert.equal(shouldCleanupConsult({ result: null, failure: { sent: true }, hardStop: false }), false);
  assert.equal(shouldCleanupConsult({ result: null, failure: { sent: false }, hardStop: false }), true);
  assert.equal(shouldCleanupConsult({ result: null, failure: null, hardStop: false }), false);
  assert.equal(shouldCleanupConsult({ result: { answer: "OK" }, failure: null, hardStop: false }), true);
  assert.equal(shouldCleanupRecovery({ result: null, failure: null, hardStop: true }), false);
  assert.equal(shouldCleanupRecovery({ result: { answer: "OK" }, failure: null, hardStop: false }), true);
});

test("the optional CDP path does not assume a missing command exists", () => {
  const source = requireSource("../src/chrome.mjs");
  assert.match(source, /spawnSync\("which", \[candidate\]/);
});

function requireSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
