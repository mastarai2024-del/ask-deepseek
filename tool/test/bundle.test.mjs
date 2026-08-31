import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBundle, writeBundle } from "../src/bundle.mjs";

test("buildBundle preserves prompt and stable line numbers", () => {
  const bundle = buildBundle({
    prompt: "Find the defect.",
    files: [{ displayPath: "src/example.js", content: "first\nsecond" }],
  });
  assert.match(bundle, /## 问题\nFind the defect/);
  assert.match(bundle, /### File: src\/example\.js/);
  assert.match(bundle, /\s1 \| first/);
  assert.match(bundle, /\s2 \| second/);
});

test("writeBundle preserves the selected DeepSeek mode in session metadata", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "deepseek-oracle-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const result = await writeBundle({
    rootDir,
    prompt: "Check the selected mode.",
    files: [{ displayPath: "sample.txt", content: "sample" }],
    expectedMode: "quick",
  });
  const meta = JSON.parse(await readFile(path.join(result.runDir, "meta.json"), "utf8"));
  assert.equal(meta.expectedMode, "quick");
});
