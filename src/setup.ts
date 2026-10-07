import { spawnSync } from "node:child_process";
import * as config from "./config.ts";

// How an MCP client starts the server. Swap for "-y dsr-mcp@latest" once it is published to npm.
export const SPEC = "github:RandomKid24/dsr-mcp";
const win = process.platform === "win32";
// On Windows npx is a .cmd file, which clients can only launch through cmd.
export const SERVER_COMMAND = win ? ["cmd", "/c", "npx", "-y", SPEC] : ["npx", "-y", SPEC];

const CLIENTS: Record<string, string[]> = {
  "Claude Code": ["claude", "mcp", "add", "dsr", "--scope", "user", "--"],
  Codex: ["codex", "mcp", "add", "dsr", "--"],
};

function onPath(cmd: string): boolean {
  return spawnSync(win ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
}

export async function setup(url: string) {
  if (!config.load().token) await (await import("./login.ts")).login(url);
  for (const [name, prefix] of Object.entries(CLIENTS)) {
    if (!onPath(prefix[0])) continue;
    const res = spawnSync(prefix[0], [...prefix.slice(1), ...SERVER_COMMAND], { encoding: "utf8", shell: win });
    const text = `${res.stdout}${res.stderr}`;
    const ok = res.status === 0 || /already exists/i.test(text);
    console.log(`${name}: ${ok ? "registered" : "FAILED: " + text.trim()}`);
  }
  const [command, ...args] = SERVER_COMMAND;
  console.log(`\nOpenCode (opencode.json): ${JSON.stringify({ mcp: { dsr: { type: "local", command: SERVER_COMMAND } } })}`);
  console.log(`Kiro (.kiro/settings/mcp.json): ${JSON.stringify({ mcpServers: { dsr: { command, args } } })}`);
  console.log("\nRestart your AI tool, then say: create my DSR");
}

