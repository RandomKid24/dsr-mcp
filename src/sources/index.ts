// Activity sources. To add one (GitHub PRs, Jira...): write a module exporting
// `collect(ctx) => Activity[]` and add it to SOURCES. Nothing else changes.
import * as crmTickets from "./crmTickets.ts";
import * as git from "./git.ts";
import type { Source } from "./types.ts";

export const SOURCES: Record<string, Source> = { git, crm_tickets: crmTickets };
