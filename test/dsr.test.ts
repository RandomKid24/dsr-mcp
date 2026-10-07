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

/** Stands in for the HTTP client; remembers entries and answers 409 on a repeated source_id, ticket or task name. */
class FakeCRM implements CRMClient {
  entries: any[] = [];
  ticketRows: any[];
  constructor(ticketRows: any[] = []) { this.ticketRows = ticketRows; }
  async me() { return ME; }
  async projects() { return PROJECTS; }
  async activities() { return this.ticketRows; }
  attendance: { net_minutes: number } | null = null;
  async today() { return { date: DAY, exists: this.entries.length > 0, attendance: this.attendance, entries: this.entries }; }
  async create(body: any) {
    const dup = this.entries.find((e) => e.source_id === body.source_id || (body.ticket != null && e.ticket === body.ticket)
      || e.task_name.toLowerCase() === body.task_name.toLowerCase());
    if (dup) throw new Conflict(409, { error: "dup", existing: dup });
    this.entries.push({ ...body, id: this.entries.length + 1 });
    return this.entries.at(-1);
  }
  async update(id: number, fields: any) { return Object.assign(this.entries.find((e) => e.id === id), fields); }
  tickets: any[] = [];
  canCreateProjects = true;
  async findTickets(o: any = {}) {
    return this.tickets.filter((t) => (o.status === "all" || !["resolved", "closed"].includes(t.status))
      && (o.product === undefined || t.product === o.product) && (!o.q || t.title.toLowerCase().includes(o.q.toLowerCase())));
  }
  async createTicket(body: any) {
    const dup = this.tickets.find((t) => t.product === body.product && t.title.toLowerCase() === body.title.toLowerCase() && !["resolved", "closed"].includes(t.status));
    if (dup) throw new Conflict(409, { error: "dup", existing: dup });
    const n = this.tickets.length + 1;
    const p = PROJECTS.find((x) => x.id === body.product)!;
    const t = { id: 100 + n, key: `${p.key}-${n}`, title: body.title, product: p.id, product_name: p.name, status: body.status ?? "open",
      ticket_type: "task", priority: "medium", assigned_to_me: true, url: `/tickets/${100 + n}/` };
    this.tickets.push(t);
    // the real CRM logs a DSR entry by itself for a resolved/closed ticket
    if (["resolved", "closed"].includes(t.status)) this.entries.push({ id: this.entries.length + 1, ticket: t.id, task_name: `${t.key} ${t.title}`, source: "crm_ticket", source_id: t.key, hours_spent: "0.10", notes: "" });
    return t;
  }
  async createProject(body: any) {
    if (!this.canCreateProjects) throw new CRMError(403, "Only owners and admins can create projects.");
    if (PROJECTS.some((p) => p.name.toLowerCase() === body.name.toLowerCase())) throw new Conflict(409, { error: "dup", existing: PROJECTS[0] });
    return { id: 9, key: body.key ?? "NEW", name: body.name };
  }
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
    assert.equal(e.hours_spent, 0.67); // two sessions two hours apart: 20 + 20 minutes of measured work
    assert.equal(e.evidence.length, 2);
  });

  test("CRM tickets are their own lines, linked to the ticket", async () => {
    const row = { activity: "CRM-007 Vulnerability report: Moved it to in progress", project: "CRM", source_id: "CRM-007", ticket: 55,
      timestamp: `${DAY}T10:40:00+05:30`, suggested_hours: "1.00", category: "bug_fix", status: "in_progress", touched: true,
      events: [`${DAY}T10:00:00+05:30`, `${DAY}T10:40:00+05:30`] };
    const ctx = ctxFor(new FakeCRM([row]));
    const { found } = await core.collect(ctx);
    const e = core.buildDraft(ctx, found, PROJECTS).entries[0];
    assert.deepEqual([e.ticket, e.product, e.hours_spent, e.status], [55, 7, 1, "in_progress"]); // 20 lead + 40 between events
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

describe("overlap detection", () => {
  const line = (task: string, extra: Partial<core.Entry> = {}) =>
    ({ entries: [{ task_name: task, source: "git", source_id: "repo:d", ticket: null, ...extra } as core.Entry] });
  const row = (task: string, extra: Record<string, unknown> = {}) => ({ id: 9, task_name: task, source: "manual", source_id: "m", ticket: null, ...extra });

  test("same ticket is same_work, even with a different name", () => {
    const [o] = core.findOverlaps(line("Login fix", { ticket: 5, source: "crm_ticket" }), [row("Totally different", { ticket: 5 })]);
    assert.deepEqual([o.kind, o.existing_id], ["same_work", 9]);
  });

  test("same source and source_id is same_work; same source_id from another source is not", () => {
    assert.equal(core.findOverlaps(line("A thing"), [row("Other words", { source: "git", source_id: "repo:d" })])[0].kind, "same_work");
    assert.deepEqual(core.findOverlaps(line("Alpha work"), [row("Beta stuff", { source: "mcp", source_id: "repo:d" })]), []);
  });

  test("similar names overlap", () => {
    const [o] = core.findOverlaps(line("Fix export timeout"), [row("Fixed the export timeout"), row("Unrelated")]);
    assert.equal(o.kind, "similar");
    assert.equal(o.existing_task, "Fixed the export timeout"); // "fixed" != "fix" but export + timeout still reach 2/4
  });

  test("unrelated tasks in the same project do not overlap", () => {
    assert.deepEqual(core.findOverlaps(line("CRM: add lead import"), [row("CRM: fix auth redirect"), row("CRM: update the docs for billing")]), []);
    assert.deepEqual(core.findOverlaps(line("and the for"), [row("the and with")]), []); // only stop words
  });
});

describe("real time", () => {
  const at = (hhmm: string) => `${DAY}T${hhmm}:00+05:30`;

  test("activeMinutes: one session counts the gaps plus a lead; a long pause starts a new session", () => {
    assert.equal(core.activeMinutes([]), 0);
    assert.equal(core.activeMinutes([at("10:00")]), 20);
    assert.equal(core.activeMinutes([at("10:00"), at("10:30"), at("11:00")]), 80);
    assert.equal(core.activeMinutes([at("10:00"), at("14:00")]), 40);
    assert.equal(core.activeMinutes([at("11:00"), at("10:00")]), 80); // an hour apart: 20 + 60; order does not matter
  });

  test("tickets with no activity today are left out", async () => {
    const row = (id: string, touched: boolean) => ({ activity: `${id} T: x`, project: "CRM", source_id: id, ticket: 1, timestamp: touched ? at("10:00") : null,
      suggested_hours: "1.00", category: "other", status: "in_progress", touched, events: touched ? [at("10:00")] : [] });
    const ctx = ctxFor(new FakeCRM([row("CRM-1", true), row("CRM-2", false)]));
    const { found } = await core.collect(ctx);
    assert.deepEqual(found.map((a) => a.sourceId), ["CRM-1"]);
  });

  test("measured time is shrunk to fit attendance, and never inflated to fill it", () => {
    const acts = [
      act("CRM-1 A: x", "CRM-1", { times: [at("09:00"), at("10:00")] }), // 80 min
      act("CRM-2 B: y", "CRM-2", { times: [at("11:00"), at("12:00")] }), // 80 min
    ];
    const roomy = core.buildDraft({ ...ctxFor(new FakeCRM()), attendanceMinutes: 480 }, acts, PROJECTS);
    assert.deepEqual(roomy.entries.map((e) => e.hours_spent), [1.33, 1.33]); // a whole day on attendance, still only what was measured
    assert.equal(roomy.scaledDown, false);
    const tight = core.buildDraft({ ...ctxFor(new FakeCRM()), attendanceMinutes: 80 }, acts, PROJECTS);
    assert.deepEqual(tight.entries.map((e) => e.hours_spent), [0.67, 0.67]); // 160 measured, 80 on attendance
    assert.equal(tight.scaledDown, true);
    assert.match(core.render(tight, ME), /scaled down to fit/);
  });

  test("a hour the user volunteers wins over the measurement", () => {
    const draft = core.buildDraft(ctxFor(new FakeCRM()), [act("CRM-1 A: x", "CRM-1", { times: [at("09:00")] })], PROJECTS, { hours: { "CRM-1": 2 } });
    assert.equal(draft.entries[0].hours_spent, 2);
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
    crm = new FakeCRM([{ activity: "CRM-1 A: x", project: "CRM", source_id: "CRM-1", ticket: 1, timestamp: null, suggested_hours: "1.00", category: "other", status: "completed",
      touched: true, events: [`${DAY}T10:00:00+05:30`, `${DAY}T10:30:00+05:30`] }]);
    server.deps.crm = () => ({ crm, cfg: { url: "", token: "", repos: [] } });
    server.DRAFTS.clear();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.createServer().connect(a);
    client = new Client({ name: "test", version: "0" });
    await client.connect(b);
  });

  test("exposes the twelve tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["crm_create_project", "crm_create_ticket", "crm_find_tickets", "dsr_generate", "dsr_get_existing", "dsr_get_projects", "dsr_get_today", "dsr_get_user", "dsr_preview", "dsr_submit", "dsr_ticket_from_lines", "dsr_update"]);
  });

  test("cannot submit without preview or confirmation", async () => {
    const { draft_id } = await call("dsr_generate");
    assert.match((await call("dsr_submit", { draft_id, confirmed: true })).error, /preview/i);
    await call("dsr_preview", { draft_id });
    assert.match((await call("dsr_submit", { draft_id })).error, /not confirmed/);
    assert.equal(crm.entries.length, 0);
    assert.equal((await call("dsr_submit", { draft_id, confirmed: true })).results[0].result, "created");
    assert.equal(crm.entries.length, 1);
    assert.equal(crm.entries[0].hours_spent, "0.83"); // 20 + 30 minutes, measured, nobody was asked
  });

  const run = async (args: Record<string, unknown> = {}) => {
    const id = (await call("dsr_generate", args)).draft_id;
    const pre = await call("dsr_preview", { draft_id: id });
    return { id, pre };
  };
  const seed = (e: Record<string, unknown>) => crm.entries.push({ id: crm.entries.length + 1, hours_spent: "1.00", notes: "", source: "mcp", source_id: "x", ticket: null, ...e });

  test("submitting twice never duplicates; the same work is refreshed in place", async () => {
    const first = await run();
    assert.deepEqual(first.pre.overlaps, []);
    await call("dsr_submit", { draft_id: first.id, confirmed: true });
    const second = await run({ hours: { "CRM-1": 4 } });
    assert.equal(second.pre.overlaps[0].kind, "same_work");
    assert.equal(second.pre.new_lines.length, 0);
    assert.match(second.pre.next, /overlap/);
    assert.match((await call("dsr_submit", { draft_id: second.id, confirmed: true })).error, /overlap/); // blocked until the user chooses
    const fixed = await call("dsr_submit", { draft_id: second.id, confirmed: true, on_overlap: "separate" });
    assert.equal(fixed.results[0].result, "updated");
    const again = await call("dsr_submit", { draft_id: second.id, confirmed: true, on_overlap: "separate" });
    assert.equal(again.results[0].result, "updated");
    assert.equal(crm.entries.length, 1);
    assert.equal(crm.entries[0].hours_spent, "4.00");
  });

  test("same_work lines are left alone on skip", async () => {
    const first = await run();
    await call("dsr_submit", { draft_id: first.id, confirmed: true });
    const second = await run({ hours: { "CRM-1": 4 } });
    assert.equal((await call("dsr_submit", { draft_id: second.id, confirmed: true, on_overlap: "skip" })).results[0].result, "skipped");
    assert.equal(crm.entries[0].hours_spent, "0.83");
  });

  describe("similar lines", () => {
    // CRM-1's task name is "CRM-1 A"; a hand-made entry with a similar name already exists.
    const similar = (draft: any) => draft.overlaps.find((o: any) => o.kind === "similar");
    beforeEach(() => {
      crm.ticketRows[0].activity = "CRM-1 Export report timeout: x";
      seed({ task_name: "CRM-1 Export report timeout fix", hours_spent: "2.00", notes: "old" });
    });

    test("blocked until on_overlap is chosen, then separate creates a new entry", async () => {
      const { id, pre } = await run();
      assert.equal(similar(pre)?.existing_id, 1);
      const blocked = await call("dsr_submit", { draft_id: id, confirmed: true });
      assert.match(blocked.error, /overlap/);
      assert.deepEqual(Object.keys(blocked.choices), ["separate", "merge", "skip"]);
      assert.equal(crm.entries.length, 1);
      assert.equal((await call("dsr_submit", { draft_id: id, confirmed: true, on_overlap: "separate" })).results[0].result, "created");
      assert.equal(crm.entries.length, 2);
    });

    test("merge adds the hours and appends the name; a resubmit does not add them twice", async () => {
      const { id } = await run();
      const r = await call("dsr_submit", { draft_id: id, confirmed: true, on_overlap: "merge" });
      assert.equal(r.results[0].result, "merged");
      assert.equal(crm.entries.length, 1);
      assert.equal(crm.entries[0].hours_spent, "2.83"); // 2.00 + 0.83 measured
      assert.equal(crm.entries[0].notes, "old; CRM-1 Export report timeout");
      assert.equal((await call("dsr_submit", { draft_id: id, confirmed: true, on_overlap: "merge" })).results[0].result, "skipped");
      assert.equal(crm.entries[0].hours_spent, "2.83");
    });

    test("skip creates nothing", async () => {
      const { id } = await run();
      assert.equal((await call("dsr_submit", { draft_id: id, confirmed: true, on_overlap: "skip" })).results[0].result, "skipped");
      assert.equal(crm.entries.length, 1);
      assert.equal(crm.entries[0].hours_spent, "2.00");
    });
  });

  test("lines with no overlap never block", async () => {
    seed({ task_name: "Quarterly planning meeting" });
    const { id, pre } = await run();
    assert.deepEqual(pre.overlaps, []);
    assert.equal(pre.already_in_crm[0].task, "Quarterly planning meeting");
    assert.equal((await call("dsr_submit", { draft_id: id, confirmed: true })).results[0].result, "created");
  });

  test("group_by project: one entry per project with summed hours", async () => {
    crm.ticketRows.push({ activity: "CRM-2 B: y", project: "CRM", source_id: "CRM-2", ticket: 2, timestamp: null, suggested_hours: "1.00", category: "bug_fix", status: "in_progress",
      touched: true, events: [`${DAY}T12:00:00+05:30`] });
    crm.ticketRows.push({ activity: "BIL-1 C: z", project: "Billing", source_id: "BIL-1", ticket: 3, timestamp: null, suggested_hours: "1.00", category: "other", status: "completed",
      touched: true, events: [`${DAY}T12:00:00+05:30`] });
    const { id } = await run({ group_by: "project" });
    await call("dsr_submit", { draft_id: id, confirmed: true });
    assert.equal(crm.entries.length, 2);
    const crmEntry = crm.entries.find((e) => e.product === 7);
    assert.equal(crmEntry.source_id, `project:7:${DAY}`);
    assert.equal(crmEntry.status, "in_progress");
    assert.equal(crmEntry.ticket, null);
    assert.equal(crmEntry.hours_spent, "1.16"); // 0.83 + 0.33 (each line rounded first)
    assert.match(crmEntry.task_name, /^CRM: CRM-1 A; CRM-2 B$/);
    // running it again updates the same entry
    const again = await run({ group_by: "project" });
    assert.ok(again.pre.overlaps.every((o: any) => o.kind === "same_work"));
    await call("dsr_submit", { draft_id: again.id, confirmed: true, on_overlap: "separate" });
    assert.equal(crm.entries.length, 2);
  });

  test("group_by project: exclude and hours override use the combined source_id", () => {
    const acts = [act("CRM-1 A: x", "CRM-1"), act("CRM-2 B: y", "CRM-2"), act("BIL-1 C: z", "BIL-1", { project: "Billing" })];
    const ctx = ctxFor(new FakeCRM());
    const base = core.buildDraft(ctx, acts, PROJECTS, { group_by: "project", hours: { [`project:7:${DAY}`]: 5 }, exclude: [`project:8:${DAY}`] });
    assert.deepEqual(base.entries.map((e) => [e.source_id, e.hours_spent]), [[`project:7:${DAY}`, 5]]);
    const dropped = core.buildDraft(ctx, acts, PROJECTS, { group_by: "project", exclude: ["CRM-2"] });
    assert.match(dropped.entries.find((e) => e.product === 7)!.task_name, /^CRM: CRM-1 A$/);
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

  describe("tickets and projects", () => {
    const extra = [{ activity: "Rework lead import", project: "CRM", hours: 1 }];
    const lineId = async (draft_id: string, needle: string) => (server.DRAFTS.get(draft_id)!.entries.find((e) => e.task_name.includes(needle)))!.source_id;

    test("crm_find_tickets lists open tickets with full links; closed only on request", async () => {
      await crm.createTicket({ title: "Login bug", product: 7 });
      await crm.createTicket({ title: "Old thing", product: 7, status: "closed" });
      server.deps.crm = () => ({ crm, cfg: { url: "https://crm.x", token: "", repos: [] } });
      const open = await call("crm_find_tickets", { query: "login" });
      assert.deepEqual(open.map((t: any) => [t.key, t.link]), [["CRM-1", "https://crm.x/tickets/101/"]]);
      assert.equal((await call("crm_find_tickets", { include_closed: true })).length, 2);
    });

    test("crm_create_ticket needs confirmed, answers 409 with the existing ticket", async () => {
      const args = { title: "Fix export", product: 7 };
      assert.match((await call("crm_create_ticket", args)).error, /not confirmed/);
      assert.equal(crm.tickets.length, 0);
      const ok = await call("crm_create_ticket", { ...args, confirmed: true });
      assert.equal(ok.created.key, "CRM-1");
      const dup = await call("crm_create_ticket", { ...args, confirmed: true });
      assert.match(dup.error, /already exists/);
      assert.equal(dup.existing.key, "CRM-1");
      assert.equal(crm.tickets.length, 1);
    });

    test("crm_create_project needs confirmed; a 403 says to ask an owner or admin", async () => {
      assert.match((await call("crm_create_project", { name: "Mobile" })).error, /not confirmed/);
      assert.equal((await call("crm_create_project", { name: "Mobile", confirmed: true })).created.name, "Mobile");
      assert.match((await call("crm_create_project", { name: "Billing", confirmed: true })).error, /already exists/);
      crm.canCreateProjects = false;
      assert.match((await call("crm_create_project", { name: "Other", confirmed: true })).error, /owner or admin/);
    });

    test("dsr_ticket_from_lines: confirmation gate, then creates, rewrites the line and un-previews", async () => {
      const { draft_id } = await call("dsr_generate", { extra });
      await call("dsr_preview", { draft_id });
      const sid = await lineId(draft_id, "Rework");
      assert.match((await call("dsr_ticket_from_lines", { draft_id, source_ids: [sid] })).error, /not confirmed/);
      assert.equal(crm.tickets.length, 0);
      const r = await call("dsr_ticket_from_lines", { draft_id, source_ids: [sid], confirmed: true });
      assert.deepEqual([r.results[0].key, r.results[0].created], ["CRM-1", true]);
      assert.equal(crm.tickets[0].status, "resolved");
      const e = server.DRAFTS.get(draft_id)!.entries.find((x) => x.source_id === sid)!;
      assert.deepEqual([e.ticket, e.task_name, e.product], [101, "CRM-1 Rework lead import", 7]);
      assert.match((await call("dsr_submit", { draft_id, confirmed: true })).error, /preview/i);
    });

    test("after linking, submit refreshes the entry the CRM auto-logged", async () => {
      const { draft_id } = await call("dsr_generate", { extra, exclude: ["CRM-1"] });
      const sid = await lineId(draft_id, "Rework");
      await call("dsr_ticket_from_lines", { draft_id, source_ids: [sid], confirmed: true });
      assert.equal(crm.entries.length, 1); // the CRM's own small entry
      const pre = await call("dsr_preview", { draft_id });
      assert.equal(pre.overlaps[0].kind, "same_work");
      const done = await call("dsr_submit", { draft_id, confirmed: true, on_overlap: "separate" });
      assert.equal(done.results[0].result, "updated");
      assert.equal(crm.entries.length, 1);
      assert.equal(crm.entries[0].hours_spent, "1.00");
    });

    test("an existing open ticket with the same title is linked, not duplicated", async () => {
      await crm.createTicket({ title: "Rework lead import", product: 7, status: "open" });
      const { draft_id } = await call("dsr_generate", { extra });
      const sid = await lineId(draft_id, "Rework");
      const r = await call("dsr_ticket_from_lines", { draft_id, source_ids: [sid], confirmed: true });
      assert.deepEqual([r.results[0].key, r.results[0].linked, r.results[0].created], ["CRM-1", true, undefined]);
      assert.equal(crm.tickets.length, 1);
    });

    test("refuses a line with no project and a line that already has a ticket; git lines get the repo name stripped", async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-parent-"));
      const made = makeRepo([[`${DAY}T09:00:00`, "Fix export"]]);
      const repo = path.join(parent, "CRM");
      fs.renameSync(made, repo);
      const other = makeRepo([[`${DAY}T09:00:00`, "Add thing"]]); // folder name matches no project
      const { draft_id } = await call("dsr_generate", { repos: [repo, other], extra: [{ activity: "Call with client" }] });
      const entries = server.DRAFTS.get(draft_id)!.entries;
      const ids = (pred: (e: core.Entry) => boolean) => entries.find(pred)!.source_id;
      const r = await call("dsr_ticket_from_lines", { draft_id, confirmed: true, source_ids: [
        ids((e) => e.source === "git" && e.product === 7), ids((e) => e.source === "git" && e.product === null),
        ids((e) => e.source === "manual"), "CRM-1", "nope"] });
      assert.equal(r.results[0].key, "CRM-1");
      assert.equal(crm.tickets[0].title, "Fix export");
      assert.match(r.results[1].refused, /project is needed/);
      assert.match(r.results[2].refused, /project is needed/);
      assert.match(r.results[3].refused, /already has a ticket|only git or manual/);
      assert.match(r.results[4].refused, /no such line/);
      assert.equal(crm.tickets.length, 1);
      const again = await call("dsr_ticket_from_lines", { draft_id, confirmed: true, source_ids: [ids((e) => e.source === "git" && e.product === 7)] });
      assert.match(again.results[0].refused, /already has a ticket/);
    });
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

  test("installs /dsr, /ticket and /dsr-ticket for Claude Code and OpenCode, and never overwrites someone else's file", async () => {
    const { commandTargets, installCommand } = await import("../src/setup.ts");
    const home = homeWith(".claude", ".config/opencode");
    const targets = commandTargets(home);
    assert.equal(targets.length, 6);
    for (const t of targets) assert.equal(installCommand(t), "installed");
    for (const n of ["dsr", "ticket", "dsr-ticket"]) {
      for (const dir of [".claude/commands", ".config/opencode/commands"]) {
        const text = fs.readFileSync(path.join(home, dir, `${n}.md`), "utf8");
        assert.match(text, /<!-- dsr-mcp -->/);
        assert.match(text, /^---\ndescription: .+\n---/);
        assert.match(text, /\$ARGUMENTS/);
      }
    }
    assert.match(fs.readFileSync(path.join(home, ".claude/commands/dsr.md"), "utf8"), /dsr_submit with confirmed=true ONLY after/);
    assert.match(fs.readFileSync(path.join(home, ".claude/commands/ticket.md"), "utf8"), /crm_create_ticket with confirmed=true/);
    assert.match(fs.readFileSync(path.join(home, ".claude/commands/dsr-ticket.md"), "utf8"), /dsr_ticket_from_lines/);
    const ticket = targets.find((t) => t.file === path.join(home, ".config/opencode/commands/ticket.md"))!;
    assert.equal(installCommand(ticket), "installed"); // ours, so it refreshes
    fs.writeFileSync(ticket.file, "my own /ticket");
    assert.match(installCommand(ticket), /^skipped/);
    assert.equal(fs.readFileSync(ticket.file, "utf8"), "my own /ticket");
  });

  test("setup installs the command files into a temp home", async () => {
    const home = homeWith(".claude");
    const saved = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin"; // no claude/codex on the path, so no real config is touched
    const { setup } = await import("../src/setup.ts");
    try { await setup({ home }); } finally { process.env.PATH = saved; }
    assert.ok(["dsr", "ticket", "dsr-ticket"].every((n) => fs.existsSync(path.join(home, ".claude", "commands", `${n}.md`))));
    assert.ok(!fs.existsSync(path.join(home, ".config")));
  });
});
