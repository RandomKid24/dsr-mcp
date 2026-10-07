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
  minutes: number | null; // measured from real timestamps; null when the user gave the hours
}
export interface Draft {
  id: string; date: string; entries: Entry[]; warnings: string[]; previewed: boolean;
  attendanceMinutes: number | null; // the day's real worked time from attendance
  scaledDown: boolean; // measured time was more than attendance, so it was shrunk to fit
  overlaps: Overlap[]; // lines that match an entry already in the CRM (set by dsr_generate / dsr_preview)
}
export type OverlapKind = "same_work" | "similar";
export interface Overlap { source_id: string; task_name: string; existing_id: number; existing_task: string; kind: OverlapKind; reason: string }
export type OnOverlap = "separate" | "merge" | "skip";
export interface Project { id: number; key: string; name: string }

/** 1.5 -> "1h 30m" */
const fmt = (h: number) => { const m = Math.round(h * 60); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`; };
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function makeContext(crm: CRMClient, cfg: Config, date?: string): Promise<Context> {
  const me = await crm.me();
  const day = date || me.today;
  const attendanceMinutes: number | null = (await crm.today(day)).attendance?.net_minutes ?? null;
  return { date: day, user: me, cfg, crm, attendanceMinutes };
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

const SESSION_GAP_MIN = 90; // a longer pause than this ends a work session
const LEAD_MIN = 20; // time spent before the first commit/event of a session
const MIN_MINUTES = 10;

/** Minutes of real work shown by a list of timestamps (the way git-hours does it): events closer
 *  than SESSION_GAP_MIN belong to one session and count the time between them, and each session
 *  gets LEAD_MIN for the work before its first event. A measurement from real times, not a guess
 *  at a round number. */
export function activeMinutes(stamps: string[]): number {
  const t = stamps.filter(Boolean).map((x) => Date.parse(x)).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!t.length) return 0;
  let minutes = LEAD_MIN;
  for (let i = 1; i < t.length; i++) {
    const gap = (t[i] - t[i - 1]) / 60000;
    minutes += gap <= SESSION_GAP_MIN ? gap : LEAD_MIN;
  }
  return minutes;
}

const toHours = (minutes: number) => round2(Math.max(MIN_MINUTES, Math.round(minutes / 5) * 5) / 60);

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
  group_by?: "line" | "project"; // "project": one combined entry per CRM project
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
        hours_spent: 0, minutes: activeMinutes(acts.map((a) => a.timestamp)),
        notes: "Commits: " + acts.map((a) => a.sourceId.split("@").pop()).join(", "),
        source: "git", source_id: `${first.group}:${ctx.date}`, ticket: null, product: null, project: "", evidence,
      };
    } else {
      e = {
        task_name: first.activity.split(":")[0].slice(0, 255),
        category: first.category ?? "other", status: first.status ?? "completed",
        hours_spent: 0, minutes: activeMinutes(first.times ?? [first.timestamp]),
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
      hours_spent: x.hours ?? 1, minutes: null, notes: "Added by the user; no source.", source: "manual",
      source_id: `manual:${ctx.date}:${digest}`, ticket: null, product,
      project: projects.find((p) => p.id === product)?.name ?? x.project ?? "", evidence: [],
    });
  }

  const drop = new Set(opts.exclude ?? []);
  entries = entries.filter((e) => !drop.has(e.source_id));
  const byProject = opts.group_by === "project";
  // Measured lines can't add up to more than the day they happened in: shrink them to fit attendance.
  // Never the other way: time nobody can show evidence for is left unreported, not invented.
  const measured = entries.filter((e) => e.minutes !== null && opts.hours?.[e.source_id] === undefined);
  const total = measured.reduce((n, e) => n + (e.minutes as number), 0);
  const cap = ctx.attendanceMinutes ?? null;
  const factor = cap !== null && total > cap && total > 0 ? cap / total : 1;
  for (const e of entries) {
    const fixed = opts.hours?.[e.source_id];
    if (fixed !== undefined) e.hours_spent = round2(fixed);
    else if (e.minutes !== null) e.hours_spent = toHours(e.minutes * factor);
    else e.hours_spent = round2(e.hours_spent);
  }
  if (byProject) {
    // Lines were measured and capped one by one above; now fold them per project. Exclusions and
    // hour overrides can also name the combined source_id.
    entries = combineByProject(ctx.date, entries).filter((e) => !drop.has(e.source_id));
    for (const e of entries) {
      const fixed = opts.hours?.[e.source_id];
      if (fixed !== undefined) e.hours_spent = round2(fixed);
    }
  }
  return { id: randomUUID().slice(0, 8), date: ctx.date, entries, warnings, previewed: false, attendanceMinutes: cap, scaledDown: factor < 1, overlaps: [] };
}

/** Joins names with "; " and fits 255 chars, ending in "(+N more)" when some had to go. */
function joinNames(prefix: string, names: string[]): string {
  for (let k = names.length; k >= 1; k--) {
    const text = `${prefix}${names.slice(0, k).join("; ")}${k < names.length ? ` (+${names.length - k} more)` : ""}`;
    if (text.length <= 255) return text;
  }
  return `${prefix}${names[0]}`.slice(0, 255);
}

/** One entry per CRM project (no project groups together). Lines the user added by hand stay as they are. */
function combineByProject(date: string, entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  const groups = new Map<number | null, Entry[]>();
  for (const e of entries) {
    if (e.source === "manual") { out.push(e); continue; }
    groups.set(e.product, [...(groups.get(e.product) ?? []), e]);
  }
  const combined: Entry[] = [];
  for (const [product, list] of groups) {
    const project = list[0].project || "no project";
    combined.push({
      task_name: joinNames(`${project}: `, list.map((e) => e.task_name)),
      category: list[0].category,
      status: list.some((e) => e.status === "in_progress") ? "in_progress" : "completed",
      hours_spent: round2(list.reduce((n, e) => n + e.hours_spent, 0)), minutes: null,
      notes: list.map((e) => e.notes).filter(Boolean).join("; "),
      source: "mcp", source_id: `project:${product ?? "none"}:${date}`, ticket: null, product, project: list[0].project,
      evidence: list.flatMap((e) => e.evidence),
    });
  }
  return [...combined, ...out];
}

const STOP = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "are", "was", "has", "have", "not", "but", "out", "all", "its"]);
const words = (t: string) => new Set((t.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)));

/** Token overlap of two task names, 0..1. */
export function similarity(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export const SIMILAR_AT = 0.5;

/** For each draft line that matches an entry already in the CRM: the same work (same ticket or same
 *  source id, can only be updated) or a similar task name (the user decides). */
export function findOverlaps(draft: Pick<Draft, "entries">, existing: any[]): Overlap[] {
  const out: Overlap[] = [];
  for (const e of draft.entries) {
    const same = existing.find((x) => (e.ticket !== null && x.ticket === e.ticket) || (x.source === e.source && x.source_id === e.source_id));
    const mk = (x: any, kind: OverlapKind, reason: string): Overlap =>
      ({ source_id: e.source_id, task_name: e.task_name, existing_id: x.id, existing_task: x.task_name, kind, reason });
    if (same) { out.push(mk(same, "same_work", e.ticket !== null && same.ticket === e.ticket ? "same ticket" : "same source")); continue; }
    let best: any = null, top = 0;
    for (const x of existing) { const s = similarity(e.task_name, x.task_name ?? ""); if (s > top) { top = s; best = x; } }
    if (best && top >= SIMILAR_AT) out.push(mk(best, "similar", `task names are ${Math.round(top * 100)}% alike`));
  }
  return out;
}

export function render(draft: Draft, user: any): string {
  const lines = [`DSR for ${draft.date}: ${user.name ?? ""} (${user.company.name})`, ""];
  let total = 0;
  draft.entries.forEach((e, i) => {
    total += e.hours_spent;
    const proof = e.evidence.length ? `${e.source} ${e.source_id}` : "UNVERIFIED, no source";
    lines.push(`${i + 1}. [${e.project || "no project"}] ${e.task_name}`);
    lines.push(`   ${fmt(e.hours_spent)}, ${e.status.replace(/_/g, " ")}, ${e.category.replace(/_/g, " ")}  (${proof})`);
    for (const ev of e.evidence.slice(0, 5)) lines.push(`     - ${ev.activity}  [${ev.sourceId}]`);
  });
  lines.push("", `Total: ${fmt(total)}`);
  lines.push(draft.attendanceMinutes !== null
    ? `Time is measured from your commit and ticket times. Attendance today: ${fmt(draft.attendanceMinutes / 60)}${draft.scaledDown ? " (measured time was more than this, so it was scaled down to fit)" : ""}.`
    : "Time is measured from your commit and ticket times. No attendance punch was found for this day.");
  for (const w of draft.warnings) lines.push(`Note: ${w}`);
  return lines.join("\n");
}

const payload = (e: Entry, date: string) => ({
  date, task_name: e.task_name, product: e.product, category: e.category, hours_spent: e.hours_spent.toFixed(2),
  status: e.status, notes: e.notes, source: e.source, source_id: e.source_id, ticket: e.ticket,
});

/** Send the draft. Lines that overlap an entry already in the CRM follow `onOverlap` (same-work lines
 *  are refreshed in place unless "skip"). A 409 never creates a duplicate; it is reported as skipped. */
export async function submit(crm: CRMClient, draft: Draft, onOverlap?: OnOverlap, existing: any[] = []) {
  const done: { task: string; result: "created" | "updated" | "merged" | "skipped"; id: number | null; why?: string }[] = [];
  const create = async (e: Entry) => {
    try { done.push({ task: e.task_name, result: "created", id: (await crm.create(payload(e, draft.date))).id }); }
    catch (err) {
      if (!(err instanceof Conflict)) throw err;
      done.push({ task: e.task_name, result: "skipped", id: err.existing.id ?? null, why: "the CRM already has it" });
    }
  };
  for (const e of draft.entries) {
    const o = draft.overlaps.find((x) => x.source_id === e.source_id);
    if (!o) { await create(e); continue; }
    if (onOverlap === "skip") { done.push({ task: e.task_name, result: "skipped", id: o.existing_id, why: "skipped as asked" }); continue; }
    if (o.kind === "same_work" || onOverlap === "merge") {
      const old = existing.find((x) => x.id === o.existing_id);
      if (o.kind === "same_work") {
        const { task_name, product, category, hours_spent, status, notes } = payload(e, draft.date);
        done.push({ task: e.task_name, result: "updated", id: (await crm.update(o.existing_id, { task_name, product, category, hours_spent, status, notes })).id });
      } else if (old?.notes?.includes(e.task_name)) {
        done.push({ task: e.task_name, result: "skipped", id: o.existing_id, why: "already merged" }); // a resubmit must not add the hours twice
      } else {
        const hours = (parseFloat(old?.hours_spent) || 0) + e.hours_spent;
        const notes = old?.notes ? `${old.notes}; ${e.task_name}` : e.task_name;
        done.push({ task: e.task_name, result: "merged", id: (await crm.update(o.existing_id, { hours_spent: hours.toFixed(2), notes })).id });
      }
      continue;
    }
    await create(e); // similar + "separate": different work
  }
  return done;
}
