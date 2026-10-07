import type { Config } from "../config.ts";
import type { CRMClient } from "../crm.ts";

/**
 * One piece of evidence that work happened. Every DSR line is built from these.
 * `group` decides what is merged into one DSR line (a repo, a ticket key).
 * `source` + `sourceId` is the audit trail: a commit sha, a ticket key, a PR number.
 */
export interface Activity {
  activity: string;
  source: string;
  sourceId: string;
  timestamp: string; // ISO 8601, or "" when the source has none
  group: string;
  project?: string; // CRM project name when the source knows it
  hours?: number | null; // a source's own estimate, if it has one
  category?: string;
  status?: string;
  ticket?: number | null; // CRM ticket id, so the CRM links the line to it
}

export interface Context {
  date: string; // YYYY-MM-DD, taken from the CRM so everyone shares its timezone
  user: any; // CRM /users/me
  cfg: Config;
  crm: CRMClient;
}

export interface Source {
  collect(ctx: Context): Promise<Activity[]> | Activity[];
}
