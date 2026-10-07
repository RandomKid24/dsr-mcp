#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as config from "./config.ts";
import { createServer } from "./server.ts";
import { setup } from "./setup.ts";

const HELP = `dsr-mcp: BeForth DSR MCP server (runs over stdio by default)

  dsr-mcp                     start the server (what your AI tool runs)
  dsr-mcp setup               sign in and register with Claude Code / Codex (optional)
  dsr-mcp login               sign in only (it also happens by itself on first use)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h") return console.log(HELP);
  if (cmd === "login" || cmd === "setup") {
    const i = rest.indexOf("--url");
    const url = (i >= 0 ? rest[i + 1] : "") || config.load().url;
    return cmd === "login" ? (await import("./login.ts")).login(url) : setup(url);
  }
  if (cmd) { console.error(HELP); process.exit(2); }
  await createServer().connect(new StdioServerTransport());
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
