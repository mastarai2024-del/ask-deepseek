#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { collectFiles, writeBundle } from "../src/bundle.mjs";
import { CdpClient, chromeReady, launchChrome } from "../src/chrome.mjs";
import {
  inspectDeepSeekPage,
  staticTextValues,
} from "../src/deepseek-page.mjs";
import { consultViaEgo, recoverViaEgo } from "../src/ego-transport.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function usage(exitCode = 0) {
  console.log(`Usage:
  deepseek-oracle render --prompt "..." --file path [--file path]
  deepseek-oracle launch [--port 9227] [--chrome-path /path/to/Chrome]
  deepseek-oracle probe --port 9227
  deepseek-oracle ask --session <id> --send
  deepseek-oracle recover --session <id> [--url https://chat.deepseek.com/a/chat/s/...]

All state stays under ${rootDir}. render never contacts DeepSeek.
DeepSeek Web uses one unified model. ask verifies the current composer before it fills or sends a prompt.`);
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
    else if (arg === "--send") values.send = true;
    else if (arg === "--help" || arg === "-h") usage();
    else if (!values.command) values.command = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return values;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (!options.command) usage(1);
  if (options.command === "render") {
    if (!options.prompt) throw new Error("render requires --prompt.");
    const files = await collectFiles(options.files);
    const result = await writeBundle({ rootDir, prompt: options.prompt, files });
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
    const page = inspectDeepSeekPage(tree);
    const probe = {
      staticTextCount: staticTextValues(tree).length,
      page,
    };
    await fs.writeFile(path.join(rootDir, "last-probe.json"), JSON.stringify(probe, null, 2) + "\n", { mode: 0o600 });
    console.log(`DeepSeek probe passed: contract=${page.contract}, composerCount=${page.composerCount}, staticTextCount=${probe.staticTextCount}. No message was sent.`);
    return;
  }
  if (options.command === "ask") {
    if (!options.session) throw new Error("ask requires --session.");
    if (!options.send) throw new Error("ask refuses to submit without the explicit --send flag.");
    if (!/^[0-9TZ-]+$/.test(options.session)) throw new Error("Invalid session id.");
    const runDir = path.join(rootDir, "sessions", options.session);
    const prompt = await fs.readFile(path.join(runDir, "prompt.md"), "utf8");
    const metaPath = path.join(runDir, "meta.json");
    const storedMeta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    if (["submitting", "uncertain", "completed"].includes(storedMeta.state)) {
      throw new Error(`Session ${options.session} is ${storedMeta.state}; refusing a duplicate submission.`);
    }
    const meta = {
      id: storedMeta.id,
      createdAt: storedMeta.createdAt,
      state: storedMeta.state,
      files: Array.isArray(storedMeta.files) ? storedMeta.files : [],
    };
    meta.state = "submitting";
    meta.submittedAt = new Date().toISOString();
    delete meta.lastError;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
    try {
      const result = await consultViaEgo({
        prompt,
        sessionId: options.session,
      });
      await fs.writeFile(path.join(runDir, "answer.md"), result.answer + "\n", { mode: 0o600 });
      meta.state = "completed";
      meta.completedAt = new Date().toISOString();
      meta.chatUrl = result.url;
      meta.pageContract = result.pageContract;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
      console.log(result.answer);
    } catch (error) {
      meta.state = error.sent ? "uncertain" : "rendered";
      meta.lastError = error.message;
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
