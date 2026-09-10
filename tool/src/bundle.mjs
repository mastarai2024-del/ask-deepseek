import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "sessions", "browser-profile"]);

function displayPath(filePath, cwd) {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

function isText(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

async function walk(target, cwd, found) {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(path.join(target, entry.name), cwd, found);
      }
    }
    return;
  }
  if (!stat.isFile()) return;
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${displayPath(target, cwd)} exceeds the 1 MiB per-file limit.`);
  }
  const content = await fs.readFile(target);
  if (!isText(content)) {
    throw new Error(`${displayPath(target, cwd)} is binary and cannot be included.`);
  }
  found.push({ path: target, displayPath: displayPath(target, cwd), content: content.toString("utf8") });
}

export async function collectFiles(inputs, cwd = process.cwd()) {
  if (!inputs.length) throw new Error("At least one --file path is required.");
  const found = [];
  for (const input of inputs) {
    await walk(path.resolve(cwd, input), cwd, found);
  }
  const unique = new Map(found.map((file) => [file.path, file]));
  return [...unique.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

function numberLines(content) {
  return content.split(/\r?\n/).map((line, index) => `${String(index + 1).padStart(5)} | ${line}`).join("\n");
}

export function buildBundle({ prompt, files }) {
  const sections = files.map((file) => [
    `### File: ${file.displayPath}`,
    `Lines: ${file.content.split(/\r?\n/).length}`,
    "```text",
    numberLines(file.content),
    "```",
  ].join("\n"));

  return [
    "你是独立技术审阅者。只根据下方问题和文件回答；区分事实、推断与待核实项。",
    "给出可执行结论，并用 `文件路径:行号` 引用证据。不要索取、复述或暴露凭证、Cookie、密码及个人资料。",
    "",
    "## 问题",
    prompt,
    "",
    "## 附件",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

export async function writeBundle({ rootDir, prompt, files }) {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(rootDir, "sessions", id);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const bundle = buildBundle({ prompt, files });
  await fs.writeFile(path.join(runDir, "prompt.md"), bundle, { mode: 0o600 });
  await fs.writeFile(path.join(runDir, "meta.json"), JSON.stringify({
    id,
    createdAt: new Date().toISOString(),
    state: "rendered",
    files: files.map((file) => file.displayPath),
  }, null, 2) + "\n", { mode: 0o600 });
  return { id, runDir, bundle };
}
