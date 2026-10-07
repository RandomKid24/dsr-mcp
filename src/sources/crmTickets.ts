import type { Activity, Context } from "./types.ts";

export async function collect(ctx: Context): Promise<Activity[]> {
  // A ticket that is only assigned to you, with no activity today, is not evidence of work today.
  return (await ctx.crm.activities(ctx.date)).filter((r) => r.touched !== false).map((r) => ({
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
    times: r.events?.length ? r.events : undefined,
  }));
}
