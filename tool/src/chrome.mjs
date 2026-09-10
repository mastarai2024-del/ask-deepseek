import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const DEEPSEEK_URL = "https://chat.deepseek.com/";

function isFilesystemPath(candidate) {
  return candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate);
}

function windowsChromePaths(env) {
  const roots = [
    env.ProgramFiles,
    env.PROGRAMFILES,
    env["ProgramFiles(x86)"],
    env.PROGRAMFILES_X86,
    env.LOCALAPPDATA,
  ].filter(Boolean);
  return roots.flatMap((root) => [
    `${root}\\Google\\Chrome\\Application\\chrome.exe`,
    `${root}\\Chromium\\Application\\chrome.exe`,
  ]);
}

function commandExists(command, platform) {
  const lookup = platform === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore" }).status === 0;
}

export function defaultChromePath({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  hasCommand = commandExists,
} = {}) {
  const candidates = platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : platform === "win32"
      ? [...windowsChromePaths(env), "chrome.exe", "chrome", "chromium.exe", "chromium"]
      : ["google-chrome", "chromium", "chromium-browser"];
  return candidates.find((candidate) => {
    if (isFilesystemPath(candidate)) return exists(candidate);
    return hasCommand(candidate, platform);
  });
}

export function launchChrome({ rootDir, port = 9227, chromePath = defaultChromePath() }) {
  if (!chromePath) throw new Error("Chrome was not found. Pass --chrome-path explicitly.");
  const profileDir = path.join(rootDir, "browser-profile");
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    DEEPSEEK_URL,
  ], { detached: true, stdio: "ignore" });
  child.unref();
  return { port, profileDir, pid: child.pid, url: DEEPSEEK_URL };
}

export async function chromeReady(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error(`Chrome DevTools on port ${port} returned HTTP ${response.status}.`);
  return response.json();
}

export class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(port) {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const tab = tabs.find((item) => item.type === "page" && item.url.startsWith("https://chat.deepseek.com/"));
    if (!tab?.webSocketDebuggerUrl) throw new Error("No logged-in DeepSeek tab is available on the selected Chrome port.");
    const client = new CdpClient(tab.webSocketDebuggerUrl);
    await client.ready;
    return client;
  }

  constructor(url) {
    this.#socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", () => reject(new Error("Unable to connect to Chrome DevTools.")), { once: true });
    });
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  command(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "DeepSeek page evaluation failed.");
    return result.result?.value;
  }

  close() {
    this.#socket.close();
  }
}
