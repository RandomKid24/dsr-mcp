import type { Activity, Context } from "./types.ts";

export async function collect(ctx: Context): Promise<Activity[]> {
  return (await ctx.crm.activities(ctx.date)).map((r) => ({
    activity: r.activity,
    source: "crm_ticket",
    sourceId: r.source_id,
    timestamp: r.timestamp ?? "",
    group: r.source_id,
    project: r.project,
    hours: Number(r.suggested_hours),
    category: r.category,
    status: r.status,
    ticket: r.ticket,
  }));
}
