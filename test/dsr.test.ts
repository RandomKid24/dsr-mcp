import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as core from "../src/core.ts";
import { Conflict, CRMError, type CRMClient } from "../src/crm.ts";
import * as server from "../src/server.ts";
import * as git from "../src/sources/git.ts";
import type { Activity, Context } from "../src/sources/types.ts";

const DAY = "2026-10-07";
const ME = { id: 1, username: "dev", name: "Dev", email: "dev@t.local", company: { id: 1, name: "Acme" }, today: DAY };
const PROJECTS = [{ id: 7, key: "CRM", name: "CRM" }, { id: 8, key: "BIL", name: "Billing" }];

/** Stands in for the HTTP client; remembers entries and answers 409 on a repeated source_id. */
class FakeCRM implements CRMClient {
  entries: any[] = [];
  ticketRows: any[];
  constructor(ticketRows: any[] = []) { this.ticketRows = ticketRows; }
  async me() { return ME; }
  async projects() { return PROJECTS; }
  async activities() { return this.ticketRows; }
  async today() { return { date: DAY, exists: this.entries.length > 0, entries: this.entries }; }
  async create(body: any) {
    const dup = this.entries.find((e) => e.source_id === body.source_id);
    if (dup) throw new Conflict(409, { error: "dup", existing: dup });
    this.entries.push({ ...body, id: this.entries.length + 1 });
    return this.entries.at(-1);
  }
  async update(id: number, fields: any) { return Object.assign(this.entries.find((e) => e.id === id), fields); }
}

function makeRepo(commits: [string, string][]) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-repo-"));
  const run = (env: Record<string, string>, ...a: string[]) => execFileSync("git", ["-C", repo, ...a], { env: { ...process.env, ...env }, stdio: "ignore" });
  run({}, "init", "-q");
  run({}, "config", "user.email", "dev@t.local");
  run({}, "config", "user.name", "Dev");
  for (const [when, msg] of commits) {
    fs.writeFileSync(path.join(repo, "f.txt"), msg);
    run({}, "add", ".");
    run({ GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, "commit", "-q", "-m", msg);
  }
  return repo;
}

// With no repos configured the git source reads the current folder; keep it from reading this repo.
before(() => process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "dsr-cwd-"))));

const ctxFor = (crm: CRMClient, repo?: string): Context =>
  ({ date: DAY, user: ME, cfg: { url: "", token: "", repos: repo ? [{ path: repo, project: "CRM" }] : [] }, crm });

const act = (activity: string, sourceId: string, extra: Partial<Activity> = {}): Activity =>
  ({ activity, source: "crm_ticket", sourceId, timestamp: "", group: sourceId, project: "CRM", ...extra });

describe("sources and drafting", () => {
  test("git source reads only that day's commits", () => {
    const repo = makeRepo([["2026-10-06T10:00:00", "yesterday work"], ["2026-10-07T09:00:00", "Fix auth redirect"], ["2026-10-07T11:00:00", "Add lead import"]]);
    const found = git.collect(ctxFor(new FakeCRM(), repo));
    assert.deepEqual(found.map((a) => a.activity).sort(), ["Add lead import", "Fix auth redirect"]);
    assert.ok(found.every((a) => a.source === "git" && a.sourceId.includes("@") && a.timestamp));
  });

  test("noise is filtered and commits become one line with estimated hours", async () => {
    const repo = makeRepo([["2026-10-07T09:00:00", "Fix auth redirect"], ["2026-10-07T09:30:00", "WIP"], ["2026-10-07T11:00:00", "Add lead import"]]);
    const ctx = ctxFor(new FakeCRM(), repo);
    const { found, errors } = await core.collect(ctx);
    const draft = core.buildDraft(ctx, found, PROJECTS);
    assert.deepEqual(errors, {});
    assert.equal(draft.entries.length, 1);
    const e = draft.entries[0];
    assert.equal(e.product, 7);
    assert.match(e.source_id, /^dsr-repo-.*:2026-10-07$/);
    assert.ok(!e.task_name.includes("WIP"));
    assert.equal(e.hours_spent, 2); // 09:00 to 11:00
    assert.equal(e.evidence.length, 2);
  });

  test("CRM tickets are their own lines, linked to the ticket", async () => {
    const row = { activity: "CRM-007 Vulnerability report: Moved it to in progress", project: "CRM", source_id: "CRM-007", ticket: 55,
      timestamp: `${DAY}T10:00:00+05:30`, suggested_hours: "1.50", category: "bug_fix", status: "in_progress" };
    const ctx = ctxFor(new FakeCRM([row]));
    const { found } = await core.collect(ctx);
    const e = core.buildDraft(ctx, found, PROJECTS).entries[0];
    assert.deepEqual([e.ticket, e.product, e.hours_spent, e.status], [55, 7, 1.5, "in_progress"]);
  });

  test("a failing source is reported, not fatal", async () => {
    const boom = { collect() { throw new Error("no network"); } };
    const { found, errors } = await core.collect(ctxFor(new FakeCRM()), { boom });
    assert.deepEqual(errors, { boom: "no network" });
    assert.deepEqual(found, []);
  });

  test("hours, exclusions and unverified extras", () => {
    const draft = core.buildDraft(ctxFor(new FakeCRM()), [act("CRM-1 A: x", "CRM-1"), act("CRM-2 B: y", "CRM-2")], PROJECTS,
      { hours: { "CRM-1": 3 }, exclude: ["CRM-2"], extra: [{ activity: "Standup with client", project: "Billing", hours: 0.5 }] });
    assert.deepEqual(draft.entries.map((e) => e.hours_spent), [3, 0.5]);
    const text = core.render(draft, ME);
    assert.match(text, /UNVERIFIED/);
    assert.ok(!text.includes("CRM-2"));
  });
});

describe("MCP tools", () => {
  let crm: FakeCRM;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    return JSON.parse(res.content[0].text);
  };

  beforeEach(async () => {
    crm = new FakeCRM([{ activity: "CRM-1 A: x", project: "CRM", source_id: "CRM-1", ticket: 1, timestamp: null, suggested_hours: "1.00", category: "other", status: "completed" }]);
    server.deps.crm = () => ({ crm, cfg: { url: "", token: "", repos: [] } });
    server.DRAFTS.clear();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.createServer().connect(a);
    client = new Client({ name: "test", version: "0" });
    await client.connect(b);
  });

  test("exposes the eight tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["dsr_generate", "dsr_get_existing", "dsr_get_projects", "dsr_get_today", "dsr_get_user", "dsr_preview", "dsr_submit", "dsr_update"]);
  });

  test("cannot submit without preview or confirmation", async () => {
    const { draft_id } = await call("dsr_generate");
    assert.match((await call("dsr_submit", { draft_id, confirmed: true })).error, /preview/i);
    await call("dsr_preview", { draft_id });
    assert.match((await call("dsr_submit", { draft_id })).error, /not confirmed/);
    assert.equal(crm.entries.length, 0);
    assert.equal((await call("dsr_submit", { draft_id, confirmed: true })).results[0].result, "created");
    assert.equal(crm.entries.length, 1);
    assert.equal(crm.entries[0].hours_spent, "1.00");
  });

  test("submitting twice never duplicates, and update_existing overwrites", async () => {
    const first = (await call("dsr_generate")).draft_id;
    await call("dsr_preview", { draft_id: first });
    await call("dsr_submit", { draft_id: first, confirmed: true });
    const second = (await call("dsr_generate", { hours: { "CRM-1": 4 } })).draft_id;
    await call("dsr_preview", { draft_id: second });
    const again = await call("dsr_submit", { draft_id: second, confirmed: true });
    assert.equal(again.results[0].result, "already_exists");
    assert.equal(crm.entries.length, 1);
    const fixed = await call("dsr_submit", { draft_id: second, confirmed: true, update_existing: true });
    assert.equal(fixed.results[0].result, "updated");
    assert.equal(crm.entries[0].hours_spent, "4.00");
  });

  test("dsr_update needs confirmation", async () => {
    assert.match((await call("dsr_update", { entry_id: 1, hours_spent: 2 })).error, /not confirmed/);
  });

  test("other CRM errors come back as data, not crashes", async () => {
    server.deps.crm = () => { throw new CRMError(403, "Invalid or revoked token."); };
    const res: any = await client.callTool({ name: "dsr_get_user", arguments: {} });
    assert.match(res.content[0].text, /revoked/);
    assert.equal(res.isError, true);
  });

  test("not signed in: opens the sign-in once and tells the AI what to say", async () => {
    let opened = 0;
    server.deps.crm = () => { throw new CRMError(0, "Not signed in to the CRM."); };
    server.deps.startLogin = async () => { opened++; return { link: "https://crm.x/oauth/authorize/?x=1", done: new Promise<void>(() => {}) }; };
    const first = (await call("dsr_get_user")).error;
    const second = (await call("dsr_generate")).error;
    assert.match(first, /opened the user's browser/);
    assert.match(first, /https:\/\/crm\.x\/oauth\/authorize/);
    assert.equal(second, first);
    assert.equal(opened, 1); // a second request while waiting does not open a second tab
  });

  test("repos can be passed per request", async () => {
    const repo = makeRepo([[`${DAY}T09:00:00`, "Fix export"]]);
    const draft = (await call("dsr_generate", { repos: [repo] })).draft;
    assert.match(draft, /Fix export/);
  });
});

describe("setup", () => {
  const cmd = ["npx", "-y", "github:RandomKid24/dsr-mcp"];
  const homeWith = (...dirs: string[]) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-home-"));
    for (const d of dirs) fs.mkdirSync(path.join(home, d), { recursive: true });
    return home;
  };
  const targets = async (home: string) => (await import("../src/setup.ts")).jsonTargets(home, "darwin", {});
  const find = async (home: string, name: string) => (await targets(home)).find((t) => t.name === name)!;

  test("adds dsr to a tool's JSON and keeps everything else, with a backup", async () => {
    const { mergeJson } = await import("../src/setup.ts");
    const home = homeWith(".kiro/settings");
    const t = await find(home, "Kiro");
    fs.writeFileSync(t.file, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    assert.equal(mergeJson(t, cmd), "registered");
    const doc = JSON.parse(fs.readFileSync(t.file, "utf8"));
    assert.deepEqual(doc.mcpServers.dsr, { command: "npx", args: ["-y", "github:RandomKid24/dsr-mcp"] });
    assert.equal(doc.mcpServers.other.command, "x");
    assert.equal(doc.theme, "dark");
    assert.ok(fs.existsSync(`${t.file}.dsr-backup`));
    assert.equal(mergeJson(t, cmd), "updated"); // running setup twice is harmless
  });

  test("creates the file when the tool is installed but has none; OpenCode uses its own shape", async () => {
    const { mergeJson } = await import("../src/setup.ts");
    const home = homeWith(".config/opencode");
    const t = await find(home, "OpenCode");
    assert.equal(mergeJson(t, cmd), "registered");
    assert.deepEqual(JSON.parse(fs.readFileSync(t.file, "utf8")).mcp.dsr, { type: "local", command: cmd, enabled: true });
    assert.ok(t.file.endsWith("opencode.json")); // never the commented opencode.jsonc
  });

  test("a file with comments is left untouched and reported", async () => {
    const { mergeJson } = await import("../src/setup.ts");
    const home = homeWith(".cursor");
    const t = await find(home, "Cursor");
    const original = '{\n  // my servers\n  "mcpServers": {}\n}';
    fs.writeFileSync(t.file, original);
    assert.match(mergeJson(t, cmd), /^skipped/);
    assert.equal(fs.readFileSync(t.file, "utf8"), original);
  });

  test("Claude Desktop's folder depends on the OS", async () => {
    const { jsonTargets } = await import("../src/setup.ts");
    const mac = jsonTargets("/h", "darwin", {}).find((t) => t.name.startsWith("Claude Desktop"))!;
    const win = jsonTargets("C:\\u", "win32", { APPDATA: "C:\\ap" }).find((t) => t.name.startsWith("Claude Desktop"))!;
    assert.match(mac.file, /Library\/Application Support\/Claude\/claude_desktop_config\.json$/);
    assert.match(win.file, /ap.*Claude.*claude_desktop_config\.json$/);
  });

  test("setup registers with installed CLI tools and only touches tools that exist", async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-bin-"));
    const log = path.join(bin, "calls.txt");
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" >> ${log}\n`, { mode: 0o755 });
    const home = homeWith(".kiro");
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const { setup } = await import("../src/setup.ts");
    try { await setup({ home }); } finally { process.env.PATH = saved; }
    assert.equal(fs.readFileSync(log, "utf8").trim(), "mcp add dsr --scope user -- npx -y github:RandomKid24/dsr-mcp");
    assert.ok(fs.existsSync(path.join(home, ".kiro", "settings", "mcp.json")));
    assert.ok(!fs.existsSync(path.join(home, ".cursor"))); // not installed, so not created
  });

  test("installs /dsr for Claude Code and OpenCode, and never overwrites someone else's file", async () => {
    const { commandTargets, installCommand } = await import("../src/setup.ts");
    const home = homeWith(".claude", ".config/opencode");
    const [claude, opencode] = commandTargets(home);
    assert.equal(installCommand(claude), "installed");
    assert.equal(installCommand(opencode), "installed");
    assert.match(fs.readFileSync(claude.file, "utf8"), /dsr_submit with confirmed=true ONLY after/);
    assert.ok(claude.file.endsWith(path.join("commands", "dsr.md")));
    assert.equal(installCommand(claude), "installed"); // ours, so it refreshes
    fs.writeFileSync(opencode.file, "my own /dsr");
    assert.match(installCommand(opencode), /^skipped/);
    assert.equal(fs.readFileSync(opencode.file, "utf8"), "my own /dsr");
  });
});

