// The MCP tools. Thin: each one calls core / crm and returns plain data.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as config from "./config.ts";
import * as core from "./core.ts";
import { CRM, CRMError } from "./crm.ts";

// ponytail: drafts live in this process (one MCP session). Persist them if a draft must survive a restart.
export const DRAFTS = new Map<string, core.Draft>();
export const deps = { crm: () => ({ crm: new CRM(config.load().url, config.load().token) as import("./crm.ts").CRMClient, cfg: config.load() }) };

const reply = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  isError,
});

/** A CRM failure comes back as {"error": ...} instead of crashing the server. */
const guard = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    const out = await fn(a);
    return reply(out, typeof out === "object" && out !== null && "error" in out);
  } catch (e) {
    if (e instanceof CRMError) return reply({ error: e.message }, true);
    throw e;
  }
};

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
    { date: z.string().optional().describe("YYYY-MM-DD, default today") },
    async ({ date }) => {
      const { crm, cfg } = deps.crm();
      const ctx = await core.makeContext(crm, cfg, date);
      const { found, errors } = await core.collect(ctx);
      return { date: ctx.date, activities: found, source_errors: errors };
    });

  tool("dsr_get_existing", "The DSR already filed for the day (today by default). Check this before submitting.",
    { date: z.string().optional() },
    async ({ date }) => deps.crm().crm.today(date));

  tool("dsr_generate",
    "Build a DSR draft from the day's evidence. Returns a draft_id and the readable draft. hours: {source_id: hours} to correct a line's hours. exclude: [source_id] to drop lines. extra: [{activity, project, hours}] for work the user says they did that has no source; it is marked UNVERIFIED. Call dsr_preview next, then show the user the result.",
    {
      date: z.string().optional(),
      hours: z.record(z.number()).optional(),
      exclude: z.array(z.string()).optional(),
      extra: z.array(z.object({ activity: z.string(), project: z.string().optional(), hours: z.number().optional() })).optional(),
    },
    async ({ date, hours, exclude, extra }) => {
      const { crm, cfg } = deps.crm();
      const ctx = await core.makeContext(crm, cfg, date);
      const { found, errors } = await core.collect(ctx);
      const draft = core.buildDraft(ctx, found, await crm.projects(), { hours, exclude, extra });
      for (const [n, e] of Object.entries(errors)) draft.warnings.push(`Source '${n}' failed: ${e}`);
      if (!draft.entries.length) draft.warnings.push("No activity found for this day.");
      DRAFTS.set(draft.id, draft);
      return { draft_id: draft.id, draft: core.render(draft, ctx.user) };
    });

  tool("dsr_preview",
    "Show the draft for approval. Show the whole text to the user and ask if they want it submitted. A draft cannot be submitted until it has been previewed.",
    { draft_id: z.string() },
    async ({ draft_id }) => {
      const draft = DRAFTS.get(draft_id);
      if (!draft) return { error: "Unknown draft_id. Call dsr_generate first." };
      const { crm } = deps.crm();
      draft.previewed = true;
      const existing = await crm.today(draft.date);
      return {
        draft: core.render(draft, await crm.me()),
        already_in_crm: existing.entries.map((e: any) => `${e.task_name} (${e.hours_spent}h)`),
        next: "Ask the user to confirm. Only then call dsr_submit with confirmed=true.",
      };
    });

  tool("dsr_submit",
    "Send a previewed draft to the CRM. confirmed must be true and only after the USER has explicitly said to submit this draft; never set it on your own. Lines the CRM already has are skipped, or overwritten if update_existing is true (ask the user before using that).",
    { draft_id: z.string(), confirmed: z.boolean().default(false), update_existing: z.boolean().default(false) },
    async ({ draft_id, confirmed, update_existing }) => {
      const draft = DRAFTS.get(draft_id);
      if (!draft) return { error: "Unknown draft_id. Call dsr_generate first." };
      if (!draft.previewed) return { error: "Call dsr_preview and show it to the user first." };
      if (!confirmed) return { error: "Not submitted: the user has not confirmed." };
      const results = await core.submit(deps.crm().crm, draft, update_existing);
      const skipped = results.some((r) => r.result === "already_exists");
      return { results, note: skipped ? "Some lines already exist; ask the user whether to update them (update_existing=true)." : "Done." };
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

  return server;
}
