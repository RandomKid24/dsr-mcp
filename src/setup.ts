// `dsr-mcp setup`: register this server with every AI tool found on the machine.
// Claude Code and Codex have an `mcp add` command. The rest keep a JSON file, which is merged
// (never replaced) and backed up first; a file we can't parse is left alone and reported.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// How an MCP client starts the server. Swap for "-y dsr-mcp@latest" once it is published to npm.
export const SPEC = "github:RandomKid24/dsr-mcp";
const win = process.platform === "win32";
// On Windows npx is a .cmd file, which clients can only launch through cmd.
export const SERVER_COMMAND = win ? ["cmd", "/c", "npx", "-y", SPEC] : ["npx", "-y", SPEC];

const CLI_CLIENTS: Record<string, string[]> = {
  "Claude Code": ["claude", "mcp", "add", "dsr", "--scope", "user", "--"],
  Codex: ["codex", "mcp", "add", "dsr", "--"],
};

export interface JsonTarget {
  name: string;
  detect: string; // the tool counts as installed if this folder exists
  file: string;
  key: string; // the object in the file that holds the servers
  entry: (cmd: string[]) => unknown;
}

const commandArgs = (cmd: string[]) => ({ command: cmd[0], args: cmd.slice(1) });

export function jsonTargets(home = os.homedir(), platform = process.platform, env = process.env): JsonTarget[] {
  const claudeDesktop =
    platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude")
    : platform === "win32" ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude")
    : path.join(home, ".config", "Claude");
  const opencode = path.join(home, ".config", "opencode");
  return [
    // opencode.json is merged with opencode.jsonc by OpenCode, so a commented jsonc file is never touched.
    { name: "OpenCode", detect: opencode, file: path.join(opencode, "opencode.json"), key: "mcp",
      entry: (cmd) => ({ type: "local", command: cmd, enabled: true }) },
    { name: "Kiro", detect: path.join(home, ".kiro"), file: path.join(home, ".kiro", "settings", "mcp.json"), key: "mcpServers", entry: commandArgs },
    { name: "Cursor", detect: path.join(home, ".cursor"), file: path.join(home, ".cursor", "mcp.json"), key: "mcpServers", entry: commandArgs },
    { name: "Windsurf", detect: path.join(home, ".codeium", "windsurf"), file: path.join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", entry: commandArgs },
    { name: "Gemini CLI", detect: path.join(home, ".gemini"), file: path.join(home, ".gemini", "settings.json"), key: "mcpServers", entry: commandArgs },
    { name: "Claude Desktop (chat)", detect: claudeDesktop, file: path.join(claudeDesktop, "claude_desktop_config.json"), key: "mcpServers", entry: commandArgs },
  ];
}

/** Add or refresh our `dsr` entry in a tool's JSON config, keeping everything else in it. */
export function mergeJson(t: JsonTarget, cmd: string[]): string {
  let doc: Record<string, any> = {};
  const existed = fs.existsSync(t.file);
  if (existed) {
    try { doc = JSON.parse(fs.readFileSync(t.file, "utf8")); } catch {
      return `skipped, ${t.file} has comments or is not plain JSON. Add this under "${t.key}" yourself: "dsr": ${JSON.stringify(t.entry(cmd))}`;
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return `skipped, ${t.file} is not a JSON object.`;
    fs.copyFileSync(t.file, `${t.file}.dsr-backup`);
  }
  const had = Boolean(doc[t.key]?.dsr);
  doc[t.key] = { ...(doc[t.key] ?? {}), dsr: t.entry(cmd) };
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  fs.writeFileSync(t.file, JSON.stringify(doc, null, 2) + "\n");
  return had ? "updated" : "registered";
}

function onPath(cmd: string): boolean {
  return spawnSync(win ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
}

export async function setup(opts: { home?: string } = {}) {
  const missing: string[] = [];
  const say = (name: string, result: string) => console.log(`${name}: ${result}`);

  for (const [name, prefix] of Object.entries(CLI_CLIENTS)) {
    if (!onPath(prefix[0])) { missing.push(name); continue; }
    const res = spawnSync(prefix[0], [...prefix.slice(1), ...SERVER_COMMAND], { encoding: "utf8", shell: win });
    const text = `${res.stdout}${res.stderr}`;
    const ok = res.status === 0 || /already exists/i.test(text);
    say(name, ok ? "registered" : "FAILED: " + text.trim());
  }
  for (const t of jsonTargets(opts.home)) {
    if (!fs.existsSync(t.detect)) { missing.push(t.name); continue; }
    say(t.name, mergeJson(t, SERVER_COMMAND));
  }
  if (missing.length) console.log(`\nNot found on this machine (paste the block from the README if you use them): ${missing.join(", ")}`);
  console.log("\nRestart your AI tool (or open a new session), then say: create my DSR");
  console.log("The first time, your browser opens to sign in to the CRM.");
}
