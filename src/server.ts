// The MCP tools. Thin: each one calls core / crm and returns plain data.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as config from "./config.ts";
import * as core from "./core.ts";
import { CRM, Conflict, CRMError } from "./crm.ts";
import { startLogin } from "./login.ts";

// ponytail: drafts live in this process (one MCP session). Persist them if a draft must survive a restart.
export const DRAFTS = new Map<string, core.Draft>();
export const deps = {
  startLogin, crm: () => ({ crm: new CRM(config.load().url, config.load().token) as import("./crm.ts").CRMClient, cfg: config.load() }) };

const reply = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  isError,
});

let signingIn: string | null = null; // the sign-in link while a sign-in is waiting for the user

/** Not signed in yet: open the browser (once) and tell the AI what to say, instead of failing. */
async function askToSignIn() {
  if (!signingIn) {
    const { link, done } = await deps.startLogin(config.load().url);
    signingIn = link;
    done.catch(() => {}).finally(() => { signingIn = null; });
  }
  return {
    error: `Not signed in to the CRM. I opened the user's browser to sign in. If it did not open, give them this link: ${signingIn}\nTell them to sign in, then ask again.`,
  };
}

/** A CRM failure comes back as {"error": ...} instead of crashing the server. */
const guard = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    const out = await fn(a);
    return reply(out, typeof out === "object" && out !== null && "error" in out);
  } catch (e) {
    if (e instanceof CRMError && e.status === 0) return reply(await askToSignIn(), true);
    if (e instanceof CRMError) return reply({ error: e.message }, true);
    throw e;
  }
};

const reposParam = z.array(z.string()).optional()
  .describe("Absolute paths of git repos to read. Default: the folder this tool was started in, plus any repos in the user's config. Pass the project folder when the AI app has no project open.");
const withRepos = (cfg: config.Config, repos?: string[]): config.Config =>
  repos?.length ? { ...cfg, repos: repos.map((path) => ({ path })) } : cfg;

export function createServer() {
  const server = new McpServer({ name: "beforth-dsr", version: "0.2.0" });
  const tool = <S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema }, guard(fn) as any);

  tool("dsr_get_user", "The CRM user this MCP is signed in as, their company, role, and today's date in the CRM's timezone.", {},
    async () => deps.crm().crm.me());

  tool("dsr_get_projects", "CRM projects (products) the user can log work against.", {},
    async () => deps.crm().crm.projects());

  tool("dsr_get_today",
    "Raw evidence of today's work (git commits, CRM tickets), each with source, sourceId and timestamp. Use this to answer 'what did I do today?'. Never invent work that is not in this list.",
    { date: z.string().optional().describe("YYYY-MM-DD, default today"), repos: reposParam },
    async ({ date, repos }) => {
      const { crm, cfg } = deps.crm();
      const ctx = await core.makeContext(crm, withRepos(cfg, repos), date);
      const { found, errors } = await core.collect(ctx);
      return { date: ctx.date, activities: found, source_errors: errors };
    });

  tool("dsr_get_existing", "The DSR already filed for the day (today by default). Check this before submitting.",
    { date: z.string().optional() },
    async ({ date }) => deps.crm().crm.today(date));

  tool("dsr_generate",
    "Build a DSR draft from the day's evidence. Hours are measured automatically from real commit and ticket times (and capped at the user's attendance), so do NOT ask the user about hours. Returns a draft_id and the readable draft. hours: {source_id: hours} only if the user volunteers a correction. exclude: [source_id] to drop lines. extra: [{activity, project, hours}] for work the user says they did that has no source; it is marked UNVERIFIED. group_by: 'line' (default) is one line per ticket and per repo; 'project' combines every line of the same CRM project into one entry (hours summed). Call dsr_preview next, then show the user the result.",
    {
      date: z.string().optional(),
      repos: reposParam,
      hours: z.record(z.number()).optional(),
      exclude: z.array(z.string()).optional(),
      extra: z.array(z.object({ activity: z.string(), project: z.string().optional(), hours: z.number().optional() })).optional(),
      group_by: z.enum(["line", "project"]).optional(),
    },
    async ({ date, repos, hours, exclude, extra, group_by }) => {
      const { crm, cfg } = deps.crm();
      const ctx = await core.makeContext(crm, withRepos(cfg, repos), date);
      const { found, errors } = await core.collect(ctx);
      const draft = core.buildDraft(ctx, found, await crm.projects(), { hours, exclude, extra, group_by });
      for (const [n, e] of Object.entries(errors)) draft.warnings.push(`Source '${n}' failed: ${e}`);
      if (!draft.entries.length) draft.warnings.push("No activity found for this day.");
      draft.overlaps = core.findOverlaps(draft, (await crm.today(draft.date)).entries ?? []);
      DRAFTS.set(draft.id, draft);
      return { draft_id: draft.id, draft: core.render(draft, ctx.user) };
    });

  tool("dsr_preview",
    "Show the draft for approval. Show the whole text to the user. Also checks the draft against entries already in the CRM today: overlaps lists draft lines that match one (same_work = same ticket or source, will be refreshed in place; similar = alike task name), already_in_crm lists what is filed, new_lines are lines with no overlap. If there are overlaps, ask the user what to do (separate / merge / skip) and pass it as on_overlap to dsr_submit. A draft cannot be submitted until it has been previewed.",
    { draft_id: z.string() },
    async ({ draft_id }) => {
      const draft = DRAFTS.get(draft_id);
      if (!draft) return { error: "Unknown draft_id. Call dsr_generate first." };
      const { crm } = deps.crm();
      draft.previewed = true;
      const existing: any[] = (await crm.today(draft.date)).entries ?? [];
      draft.overlaps = core.findOverlaps(draft, existing);
      const hit = new Set(draft.overlaps.map((o) => o.source_id));
      return {
        draft: core.render(draft, await crm.me()),
        already_in_crm: existing.map((e) => ({ id: e.id, task: e.task_name, hours: e.hours_spent })),
        overlaps: draft.overlaps,
        new_lines: draft.entries.filter((e) => !hit.has(e.source_id)).map((e) => ({ source_id: e.source_id, task: e.task_name, hours: e.hours_spent })),
        next: draft.overlaps.length
          ? "Some lines overlap entries already in the CRM. List them in plain words and ask the user ONE question: update the existing entry, add as separate entries, merge into the existing entry, or skip. Same-work lines are refreshed in place either way. Then, after a clear yes, call dsr_submit with confirmed=true and on_overlap."
          : "Ask the user to confirm. Only then call dsr_submit with confirmed=true.",
      };
    });

  tool("dsr_submit",
    "Send a previewed draft to the CRM. confirmed must be true and only after the USER has explicitly said to submit this draft; never set it on your own. If the preview reported overlaps with entries already in the CRM, this refuses until on_overlap is given (ask the user): 'separate' adds similar lines as new entries, 'merge' adds their hours and name to the existing entry, 'skip' leaves them alone. Same-work lines (same ticket or source) are always refreshed in place unless 'skip'. Lines with no overlap are created.",
    { draft_id: z.string(), confirmed: z.boolean().default(false), on_overlap: z.enum(["separate", "merge", "skip"]).optional() },
    async ({ draft_id, confirmed, on_overlap }) => {
      const draft = DRAFTS.get(draft_id);
      if (!draft) return { error: "Unknown draft_id. Call dsr_generate first." };
      if (!draft.previewed) return { error: "Call dsr_preview and show it to the user first." };
      if (!confirmed) return { error: "Not submitted: the user has not confirmed." };
      const { crm } = deps.crm();
      const existing: any[] = (await crm.today(draft.date)).entries ?? [];
      draft.overlaps = core.findOverlaps(draft, existing);
      if (draft.overlaps.length && !on_overlap) {
        return {
          error: "Not submitted: some lines overlap entries already in the CRM. Ask the user which to do, then call dsr_submit again with on_overlap.",
          overlaps: draft.overlaps,
          choices: {
            separate: "Add the similar lines as new entries (they are different work). Same-work lines are still refreshed in place.",
            merge: "Add the similar lines' hours to the existing entry and append their names to its notes. Same-work lines are still refreshed in place.",
            skip: "Leave every overlapping line alone; only lines with no overlap are created.",
          },
        };
      }
      return { results: await core.submit(crm, draft, on_overlap, existing), note: "Done." };
    });

  tool("dsr_update",
    "Change one existing DSR entry (get ids from dsr_get_existing). Needs confirmed=true from the user.",
    {
      entry_id: z.number(), confirmed: z.boolean().default(false), task_name: z.string().optional(),
      hours_spent: z.number().optional(), status: z.string().optional(), category: z.string().optional(), notes: z.string().optional(),
    },
    async ({ entry_id, confirmed, ...rest }) => {
      if (!confirmed) return { error: "Not updated: the user has not confirmed." };
      const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== ""));
      if (!Object.keys(fields).length) return { error: "Nothing to change." };
      return deps.crm().crm.update(entry_id, fields);
    });

  // ---- tickets and projects (work with or without slash commands) ----
  const link = (t: any) => `${deps.crm().cfg.url}${t.url ?? ""}`;
  const brief = (t: any) => ({ id: t.id, key: t.key, title: t.title, project: t.product_name, status: t.status, link: link(t) });
  const ASK = "Show the user the ticket (title, project, status) and ask for a clear yes first; only then call again with confirmed=true.";

  tool("crm_find_tickets",
    "Search the user's CRM tickets (open by default) by words in the title and/or project, with full links. Use it before creating a ticket to avoid duplicates, and to answer 'do I have a ticket for X?'. Call dsr_get_projects first if you need a project id.",
    { query: z.string().optional(), product: z.number().optional().describe("Project id from dsr_get_projects"), include_closed: z.boolean().optional() },
    async ({ query, product, include_closed }) => {
      const rows = await deps.crm().crm.findTickets({ q: query, product, status: include_closed ? "all" : "open" });
      return rows.map((t) => ({ ...brief(t), type: t.ticket_type, priority: t.priority, assigned_to_me: t.assigned_to_me }));
    });

  tool("crm_create_ticket",
    "Create one CRM ticket assigned to the user. WORKFLOW (also when the user just chats, no slash command): 1) call dsr_get_projects and look at the user's projects; 2) never pick a project silently if more than one could fit, ask; if none fits, ask the user to pick one or to create one (crm_create_project); 3) call crm_find_tickets to avoid duplicates; 4) show the user the title, project and status and ask; 5) only after their explicit yes call this with confirmed=true. Never set confirmed on your own. status: open (default), in_progress, resolved or closed (resolved/closed also log a DSR entry for it in the CRM). If an open ticket with the same title exists, it is returned instead of creating a duplicate; ask whether to use it.",
    {
      title: z.string(), product: z.number().describe("Project id from dsr_get_projects"), description: z.string().optional(),
      ticket_type: z.string().optional(), priority: z.string().optional(), status: z.string().optional(), confirmed: z.boolean().default(false),
    },
    async ({ confirmed, ...body }) => {
      if (!confirmed) return { error: `Not created: the user has not confirmed. Ticket "${body.title}". ${ASK}` };
      try {
        const t = await deps.crm().crm.createTicket(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== "")));
        return { created: brief(t) };
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
        return { error: "An open ticket with this title already exists in that project. Ask the user whether to use it instead of creating a new one.", existing: brief(e.existing) };
      }
    });

  tool("crm_create_project",
    "Create a CRM project. Only owners and admins can (dsr_get_user shows can_create_projects). Use it only when no existing project fits (check dsr_get_projects first) and the user agrees. Needs confirmed=true after the user explicitly said yes to this name; never set it on your own.",
    { name: z.string(), key: z.string().optional().describe("2-6 capitals; the CRM suggests one if omitted"), confirmed: z.boolean().default(false) },
    async ({ name, key, confirmed }) => {
      if (!confirmed) return { error: `Not created: the user has not confirmed. Tell the user you want to create the project "${name}" and ask for a clear yes first.` };
      try {
        return { created: await deps.crm().crm.createProject(key ? { name, key } : { name }) };
      } catch (e) {
        if (e instanceof Conflict) return { error: "A project like this already exists. Use it (dsr_get_projects) instead.", existing: e.existing };
        if (e instanceof CRMError && e.status === 403) return { error: "Only an owner or admin can create projects. Ask the user to ask an owner or admin of their company to create it." };
        throw e;
      }
    });

  tool("dsr_ticket_from_lines",
    "Turn chosen lines of a DSR draft (from dsr_generate) into CRM tickets, assigned to the user, and link the lines to them. Only git or manual lines with no ticket and a project qualify. Ask the user which lines first (source_ids are shown in the draft); needs confirmed=true after their explicit yes. A completed line makes a resolved ticket, otherwise in_progress. If an open ticket with the same title exists it is linked instead. The draft changes, so you MUST call dsr_preview again and show it before dsr_submit.",
    { draft_id: z.string(), source_ids: z.array(z.string()).min(1), confirmed: z.boolean().default(false) },
    async ({ draft_id, source_ids, confirmed }) => {
      const draft = DRAFTS.get(draft_id);
      if (!draft) return { error: "Unknown draft_id. Call dsr_generate first." };
      if (!confirmed) return { error: "Not created: the user has not confirmed. List the lines and the tickets they would become (title, project, status), ask for a clear yes, then call again with confirmed=true." };
      const { crm } = deps.crm();
      const results: Record<string, unknown>[] = [];
      for (const sid of source_ids) {
        const e = draft.entries.find((x) => x.source_id === sid);
        const no = (why: string) => results.push({ source_id: sid, refused: why });
        if (!e) { no("no such line in this draft"); continue; }
        if (e.ticket !== null) { no("already has a ticket"); continue; }
        if (e.source !== "git" && e.source !== "manual") { no("only git or manual lines can become tickets"); continue; }
        if (e.product === null) { no("it has no project; a project is needed first (pick one or create one with crm_create_project)"); continue; }
        const title = (e.source === "git" ? e.task_name.replace(/^[^:]*: /, "") : e.task_name).slice(0, 200);
        const description = e.evidence.length ? e.evidence.map((v) => `- ${v.activity} (${v.sourceId})`).join("\n") : e.notes;
        let t: any, how: "created" | "linked" = "created";
        try { t = await crm.createTicket({ title, description, product: e.product, status: e.status === "completed" ? "resolved" : "in_progress", assign_to_me: true }); }
        catch (err) {
          if (!(err instanceof Conflict)) throw err;
          t = err.existing; how = "linked";
        }
        e.ticket = t.id;
        e.task_name = `${t.key} ${t.title ?? title}`.slice(0, 255);
        results.push({ source_id: sid, key: t.key, link: link(t), [how]: true });
      }
      draft.previewed = false;
      draft.overlaps = [];
      return { results, next: "The draft changed. Call dsr_preview and show it to the user before dsr_submit." };
    });

  return server;
}
