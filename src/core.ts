// Collect -> filter -> group -> draft -> preview -> submit. Knows nothing about git or the CRM's
// internals: sources feed it Activity objects and `crm` is the HTTP client.
import { createHash, randomUUID } from "node:crypto";
import { Conflict, type CRMClient } from "./crm.ts";
import type { Config } from "./config.ts";
import { SOURCES } from "./sources/index.ts";
import type { Activity, Context, Source } from "./sources/types.ts";

const NOISE = /^(wip\b|fixup!|squash!|merge\b|revert "?merge)/i;
const CATEGORY: [RegExp, string][] = [
  [/\b(fix|bug|hotfix|patch|crash|error)\b/i, "bug_fix"],
  [/\b(doc|docs|readme|changelog)\b/i, "documentation"],
  [/\b(add|implement|feat|feature|build|create|support|integrat\w*)\b/i, "feature"],
];

export interface Evidence { source: string; sourceId: string; activity: string; timestamp: string }
export interface Entry {
  task_name: string; category: string; status: string; hours_spent: number; notes: string;
  source: string; source_id: string; ticket: number | null; product: number | null; project: string;
  evidence: Evidence[];
}
export interface Draft { id: string; date: string; entries: Entry[]; warnings: string[]; previewed: boolean }
export interface Project { id: number; key: string; name: string }

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function makeContext(crm: CRMClient, cfg: Config, date?: string): Promise<Context> {
  const me = await crm.me();
  return { date: date || me.today, user: me, cfg, crm };
}

/** Every source's activity for the day. A source that fails is reported, not fatal. */
export async function collect(ctx: Context, sources: Record<string, Source> = SOURCES) {
  const seen = new Set<string>();
  const found: Activity[] = [];
  const errors: Record<string, string> = {};
  for (const [name, src] of Object.entries(sources)) {
    let batch: Activity[];
    try { batch = await src.collect(ctx); } catch (e) { // one broken source must not hide the others
      errors[name] = e instanceof Error ? e.message : String(e);
      continue;
    }
    for (const a of batch) {
      const key = `${a.source}\0${a.sourceId}`;
      if (seen.has(key) || NOISE.test(a.activity)) continue;
      seen.add(key);
      found.push(a);
    }
  }
  return { found, errors };
}

/** Hours from the span between the first and last timestamp, in quarters, 0.5 to 4.
 *  A guess to prefill the preview, never a record; one point in time gets a flat hour. */
function quarters(stamps: string[]): number {
  const times = stamps.filter(Boolean).map((s) => Date.parse(s)).sort((a, b) => a - b);
  if (times.length < 2) return 1;
  const minutes = (times[times.length - 1] - times[0]) / 60000;
  if (minutes < 15) return 1;
  return Math.min(4, Math.max(0.5, Math.round(minutes / 15) / 4));
}

const category = (text: string) => CATEGORY.find(([rx]) => rx.test(text))?.[1] ?? "other";

/** CRM project id for a source's project name, falling back to the repo name. */
function projectId(name: string | undefined, group: string, projects: Project[]): number | null {
  const wanted = [name, group].filter(Boolean).map((n) => n!.toLowerCase());
  const exact = projects.find((p) => wanted.includes(p.name.toLowerCase()));
  if (exact) return exact.id;
  const loose = projects.find((p) => wanted.some((w) => w.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(w)));
  return loose?.id ?? null;
}

export interface DraftOptions {
  hours?: Record<string, number>;
  exclude?: string[];
  extra?: { activity: string; project?: string; hours?: number; category?: string; status?: string }[];
}

/** One DSR line per ticket, and one per repo for commits. `hours` maps a line's source_id to hours;
 *  `exclude` drops lines; `extra` are lines the user added that no source backs, marked unverified. */
export function buildDraft(ctx: Context, activities: Activity[], projects: Project[], opts: DraftOptions = {}): Draft {
  const groups = new Map<string, Activity[]>();
  for (const a of activities) {
    const k = `${a.source}\0${a.group}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const warnings: string[] = [];
  let entries: Entry[] = [];

  for (const acts of groups.values()) {
    const first = acts[0];
    const evidence = acts.map((a) => ({ source: a.source, sourceId: a.sourceId, activity: a.activity, timestamp: a.timestamp }));
    let e: Entry;
    if (first.source === "git") {
      const subjects = [...acts].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map((a) => a.activity);
      const more = subjects.length > 3 ? ` (+${subjects.length - 3} more)` : "";
      e = {
        task_name: `${first.group}: ${subjects.slice(0, 3).join("; ")}${more}`.slice(0, 255),
        category: category(subjects.join(" ")), status: "completed",
        hours_spent: quarters(acts.map((a) => a.timestamp)),
        notes: "Commits: " + acts.map((a) => a.sourceId.split("@").pop()).join(", "),
        source: "git", source_id: `${first.group}:${ctx.date}`, ticket: null, product: null, project: "", evidence,
      };
    } else {
      e = {
        task_name: first.activity.split(":")[0].slice(0, 255),
        category: first.category ?? "other", status: first.status ?? "completed",
        hours_spent: first.hours || 1,
        notes: first.activity.includes(": ") ? first.activity.split(": ").slice(1).join(": ") : first.activity,
        source: first.source, source_id: first.sourceId, ticket: first.ticket ?? null, product: null, project: "", evidence,
      };
    }
    e.product = projectId(first.project, first.source === "git" ? first.group : "", projects);
    e.project = projects.find((p) => p.id === e.product)?.name ?? "";
    if (first.source === "git" && e.product === null) warnings.push(`No CRM project matched '${first.group}'; it will be logged with no project.`);
    entries.push(e);
  }

  for (const x of opts.extra ?? []) {
    const digest = createHash("sha1").update(x.activity).digest("hex").slice(0, 8);
    const product = projectId(x.project, "", projects);
    entries.push({
      task_name: x.activity.slice(0, 255), category: x.category ?? "other", status: x.status ?? "completed",
      hours_spent: x.hours ?? 1, notes: "Added by the user; no source.", source: "manual",
      source_id: `manual:${ctx.date}:${digest}`, ticket: null, product,
      project: projects.find((p) => p.id === product)?.name ?? x.project ?? "", evidence: [],
    });
  }

  const drop = new Set(opts.exclude ?? []);
  entries = entries.filter((e) => !drop.has(e.source_id));
  for (const e of entries) {
    const fixed = opts.hours?.[e.source_id];
    e.hours_spent = round2(fixed ?? e.hours_spent);
  }
  return { id: randomUUID().slice(0, 8), date: ctx.date, entries, warnings, previewed: false };
}

export function render(draft: Draft, user: any): string {
  const lines = [`DSR for ${draft.date}: ${user.name ?? ""} (${user.company.name})`, ""];
  let total = 0;
  draft.entries.forEach((e, i) => {
    total += e.hours_spent;
    const proof = e.evidence.length ? `${e.source} ${e.source_id}` : "UNVERIFIED, no source";
    lines.push(`${i + 1}. [${e.project || "no project"}] ${e.task_name}`);
    lines.push(`   ${e.hours_spent.toFixed(2)}h, ${e.status.replace(/_/g, " ")}, ${e.category.replace(/_/g, " ")}  (${proof})`);
    for (const ev of e.evidence.slice(0, 5)) lines.push(`     - ${ev.activity}  [${ev.sourceId}]`);
  });
  lines.push("", `Total: ${total.toFixed(2)}h (hours from commits are estimates; tell me the right ones)`);
  for (const w of draft.warnings) lines.push(`Note: ${w}`);
  return lines.join("\n");
}

const payload = (e: Entry, date: string) => ({
  date, task_name: e.task_name, product: e.product, category: e.category, hours_spent: e.hours_spent.toFixed(2),
  status: e.status, notes: e.notes, source: e.source, source_id: e.source_id, ticket: e.ticket,
});

/** Create each line; a line the CRM already has is skipped, or updated when asked. */
export async function submit(crm: CRMClient, draft: Draft, updateExisting = false) {
  const done: { task: string; result: string; id: number | null }[] = [];
  for (const e of draft.entries) {
    const body = payload(e, draft.date);
    try {
      done.push({ task: e.task_name, result: "created", id: (await crm.create(body)).id });
    } catch (err) {
      if (!(err instanceof Conflict)) throw err;
      if (!updateExisting) { done.push({ task: e.task_name, result: "already_exists", id: err.existing.id ?? null }); continue; }
      const { task_name, product, category, hours_spent, status, notes } = body;
      done.push({ task: e.task_name, result: "updated", id: (await crm.update(err.existing.id, { task_name, product, category, hours_spent, status, notes })).id });
    }
  }
  return done;
}
