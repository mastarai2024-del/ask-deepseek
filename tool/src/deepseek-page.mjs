export const DEEPSEEK_COMPOSER_SELECTOR = 'textarea[name="search"]';
export const DEEPSEEK_COMPOSER_NAME = "给 DeepSeek 发送消息";
export const DEEPSEEK_CAPABILITY_LABELS = Object.freeze({
  deepThinking: "深度思考",
  webSearch: "智能搜索",
});

function center(box) {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

function normalizedName(node) {
  return String(node.name?.value ?? "").trim();
}

export function inspectDeepSeekPage(tree) {
  const composers = tree.nodes
    .filter((node) => node.role?.value === "textbox" && normalizedName(node) === DEEPSEEK_COMPOSER_NAME)
    .map((node) => ({ backendDOMNodeId: node.backendDOMNodeId ?? null }));
  const text = staticTextValues(tree);

  return {
    contract: composers.length === 1 ? "unified-model" : "unknown",
    composerCount: composers.length,
    composer: composers[0] ?? null,
    capabilityLabels: {
      deepThinking: text.filter((value) => value === DEEPSEEK_CAPABILITY_LABELS.deepThinking).length,
      webSearch: text.filter((value) => value === DEEPSEEK_CAPABILITY_LABELS.webSearch).length,
    },
  };
}

export function staticTextValues(tree) {
  return tree.nodes.filter((node) => node.role?.value === "StaticText").map((node) => String(node.name?.value ?? "")).filter(Boolean);
}

export function newAssistantText(before, after, submittedPrompt) {
  const prior = new Set(before);
  const start = after.findLastIndex((text) => text.includes(submittedPrompt));
  return start < 0 ? [] : after.slice(start + 1).filter((text) => !prior.has(text));
}

export function selectSendButton(inputBox, buttons) {
  const candidates = buttons.filter((button) => {
    const point = center(button.box);
    const verticallyAdjacent = point.y >= inputBox.top - 20 && point.y <= inputBox.bottom + 80;
    return verticallyAdjacent && point.x >= inputBox.left + (inputBox.right - inputBox.left) * 0.72;
  });
  if (candidates.length === 0) throw new Error("No DeepSeek send button was found near the composer.");
  candidates.sort((a, b) => center(b.box).x - center(a.box).x);
  if (candidates.length > 1 && center(candidates[0].box).x - center(candidates[1].box).x < 8) {
    throw new Error("DeepSeek send button candidates are positionally ambiguous.");
  }
  return candidates[0];
}
