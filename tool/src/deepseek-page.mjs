export const DEFAULT_DEEPSEEK_MODE = "expert";

export const DEEPSEEK_MODE_LABELS = Object.freeze({
  expert: "专家模式",
  quick: "快速模式",
});

export const SUPPORTED_DEEPSEEK_MODES = Object.freeze(Object.keys(DEEPSEEK_MODE_LABELS));

export function isSupportedDeepSeekMode(mode) {
  return SUPPORTED_DEEPSEEK_MODES.includes(mode);
}

function center(box) {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

function checkedValue(node) {
  const value = node.properties?.find((property) => property.name === "checked")?.value?.value;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function modeRadioNodes(tree, name) {
  return tree.nodes
    .filter((node) => node.role?.value === "radio" && String(node.name?.value ?? "") === name)
    .map((node) => ({
      name,
      checked: checkedValue(node),
      backendDOMNodeId: node.backendDOMNodeId ?? null,
    }));
}

export function inspectDeepSeekMode(tree) {
  const expertNodes = modeRadioNodes(tree, DEEPSEEK_MODE_LABELS.expert);
  const quickNodes = modeRadioNodes(tree, DEEPSEEK_MODE_LABELS.quick);
  const details = { expert: expertNodes, quick: quickNodes };

  if (expertNodes.length !== 1 || quickNodes.length !== 1) {
    return { mode: "unknown", reason: "Expert and quick mode controls must each be uniquely identifiable.", ...details };
  }

  const [expert] = expertNodes;
  const [quick] = quickNodes;
  if (expert.checked === true && quick.checked === false) return { mode: "expert", reason: null, ...details };
  if (quick.checked === true && expert.checked === false) return { mode: "quick", reason: null, ...details };
  return { mode: "unknown", reason: "Expert and quick mode selection states are missing or contradictory.", ...details };
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
