#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { collectFiles, writeBundle } from "../src/bundle.mjs";
import { CdpClient, chromeReady, launchChrome } from "../src/chrome.mjs";
import {
  DEFAULT_DEEPSEEK_MODE,
  inspectDeepSeekMode,
  isSupportedDeepSeekMode,
  staticTextValues,
} from "../src/deepseek-page.mjs";
import { consultViaEgo, recoverViaEgo } from "../src/ego-transport.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function usage(exitCode = 0) {
  console.log(`Usage:
  deepseek-oracle render --prompt "..." --file path [--file path] [--mode expert|quick]
  deepseek-oracle launch [--port 9227] [--chrome-path /path/to/Chrome]
  deepseek-oracle probe --port 9227
  deepseek-oracle ask --session <id> --send [--mode expert|quick] [--port 9227]
  deepseek-oracle recover --session <id> [--url https://chat.deepseek.com/a/chat/s/...]

All state stays under ${rootDir}. render never contacts DeepSeek.
The default mode is Expert Mode. ask verifies the requested mode before it fills or sends a prompt.`);
  process.exit(exitCode);
}

function parse(args) {
  const values = { files: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--file") values.files.push(args[++i]);
    else if (arg === "--prompt" || arg === "-p") values.prompt = args[++i];
    else if (arg === "--port") values.port = Number(args[++i]);
    else if (arg === "--chrome-path") values.chromePath = args[++i];
    else if (arg === "--session") values.session = args[++i];
    else if (arg === "--url") values.url = args[++i];
    else if (arg === "--mode") values.mode = args[++i];
    else if (arg === "--send") values.send = true;
    else if (arg === "--help" || arg === "-h") usage();
    else if (!values.command) values.command = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return values;
}

function resolveMode(mode) {
  const expectedMode = mode ?? DEFAULT_DEEPSEEK_MODE;
  if (!isSupportedDeepSeekMode(expectedMode)) {
    throw new Error(`Unsupported DeepSeek mode: ${expectedMode}. Use expert or quick.`);
  }
  return expectedMode;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (!options.command) usage(1);
  if (options.command === "render") {
    if (!options.prompt) throw new Error("render requires --prompt.");
    const files = await collectFiles(options.files);
    const expectedMode = resolveMode(options.mode);
    const result = await writeBundle({ rootDir, prompt: options.prompt, files, expectedMode });
    console.log(`Rendered ${files.length} file(s); no model was contacted.`);
    console.log(`Session ID: ${result.id}`);
    console.log(path.join(result.runDir, "prompt.md"));
    return;
  }
  if (options.command === "launch") {
    const result = launchChrome({ rootDir, port: options.port, chromePath: options.chromePath });
    console.log(`Opened a dedicated DeepSeek Chrome profile (pid ${result.pid}, port ${result.port}).`);
    console.log("Log in yourself in that window. This tool never imports your normal Chrome cookies.");
    return;
  }
  if (options.command === "probe") {
    const port = options.port ?? 9227;
    await chromeReady(port);
    const client = await CdpClient.connect(port);
    const tree = await client.command("Accessibility.getFullAXTree");
    client.close();
    const mode = inspectDeepSeekMode(tree);
    const probe = {
      staticTextCount: staticTextValues(tree).length,
      hasComposer: tree.nodes.some((node) => node.role?.value === "textbox"),
      mode,
    };
    await fs.writeFile(path.join(rootDir, "last-probe.json"), JSON.stringify(probe, null, 2) + "\n", { mode: 0o600 });
    console.log(`DeepSeek probe passed: composer=${probe.hasComposer}, mode=${mode.mode}, staticTextCount=${probe.staticTextCount}. No message was sent.`);
    return;
  }
  if (options.command === "ask") {
    if (!options.session) throw new Error("ask requires --session.");
    if (!options.send) throw new Error("ask refuses to submit without the explicit --send flag.");
    if (!/^[0-9TZ-]+$/.test(options.session)) throw new Error("Invalid session id.");
    const runDir = path.join(rootDir, "sessions", options.session);
    const prompt = await fs.readFile(path.join(runDir, "prompt.md"), "utf8");
    const metaPath = path.join(runDir, "meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    if (["submitting", "uncertain", "completed"].includes(meta.state)) {
      throw new Error(`Session ${options.session} is ${meta.state}; refusing a duplicate submission.`);
    }
    const expectedMode = resolveMode(options.mode ?? meta.expectedMode);
    meta.expectedMode = expectedMode;
    delete meta.verifiedMode;
    delete meta.modeVerifiedAt;
    meta.state = "submitting";
    meta.submittedAt = new Date().toISOString();
    delete meta.lastError;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
    try {
      const result = await consultViaEgo({
        prompt,
        sessionId: options.session,
        expectedMode,
      });
      await fs.writeFile(path.join(runDir, "answer.md"), result.answer + "\n", { mode: 0o600 });
      meta.state = "completed";
      meta.completedAt = new Date().toISOString();
      meta.chatUrl = result.url;
      meta.verifiedMode = result.verifiedMode;
      meta.modeVerifiedAt = new Date().toISOString();
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
      console.log(result.answer);
    } catch (error) {
      meta.state = error.sent ? "uncertain" : "rendered";
      meta.lastError = error.message;
      if (error.sent && error.verifiedMode) {
        meta.verifiedMode = error.verifiedMode;
        meta.modeVerifiedAt = new Date().toISOString();
      }
      if (error.url?.startsWith("https://chat.deepseek.com/a/chat/s/")) meta.chatUrl = error.url;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
      throw error;
    }
    return;
  }
  if (options.command === "recover") {
    if (!options.session) throw new Error("recover requires --session.");
    if (!/^[0-9TZ-]+$/.test(options.session)) throw new Error("Invalid session id.");
    const runDir = path.join(rootDir, "sessions", options.session);
    const metaPath = path.join(runDir, "meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    if (!new Set(["uncertain", "submitting"]).has(meta.state)) throw new Error(`Session ${options.session} is ${meta.state}; recovery is not required.`);
    const chatUrl = options.url ?? meta.chatUrl;
    if (!chatUrl?.startsWith("https://chat.deepseek.com/a/chat/s/")) throw new Error("recover requires the exact DeepSeek chat --url when it is absent from meta.json.");
    const result = await recoverViaEgo({ sessionId: options.session, chatUrl });
    await fs.writeFile(path.join(runDir, "answer.md"), result.answer + "\n", { mode: 0o600 });
    meta.state = "completed";
    meta.chatUrl = result.url;
    meta.completedAt = new Date().toISOString();
    meta.recoveredFromUncertain = true;
    delete meta.lastError;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
    console.log(result.answer);
    return;
  }
  usage(1);
}

main().catch((error) => {
  console.error(`deepseek-oracle: ${error.message}`);
  process.exitCode = 1;
});
