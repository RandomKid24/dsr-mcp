// Settings: ~/.config/dsr-mcp/config.json, with CRM_URL / CRM_TOKEN env vars taking priority.
//   {"url": "https://crm.beforth.in", "token": "...",
//    "repos": [{"path": "/Users/me/code/crm", "project": "CRM"}]}
// `dsr-mcp login` writes url and token. `repos` is optional: with none listed, the git repo the
// MCP client started the server in is used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RepoConfig { path: string; project?: string }
export interface Config { url: string; token: string; repos: RepoConfig[] }

export const CONFIG_PATH =
  process.env.DSR_MCP_CONFIG || path.join(os.homedir(), ".config", "dsr-mcp", "config.json");

function read(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}

export function load(): Config {
  const f = read();
  return {
    url: (process.env.CRM_URL || (f.url as string) || "").replace(/\/+$/, ""),
    token: process.env.CRM_TOKEN || (f.token as string) || "",
    repos: (f.repos as RepoConfig[]) || [],
  };
}

export function save(updates: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...read(), ...updates }, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600); // holds a bearer token, also when the file already existed
}
