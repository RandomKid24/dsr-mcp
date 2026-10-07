// Commits made on the day, by the user, in each configured repo (default: the current one).
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Activity, Context } from "./types.ts";

function git(repo: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function collect(ctx: Context): Activity[] {
  const repos = ctx.cfg.repos.length ? ctx.cfg.repos : [{ path: process.cwd(), project: undefined as string | undefined }];
  const out: Activity[] = [];
  for (const repo of repos) {
    if (git(repo.path, "rev-parse", "--git-dir") === null) continue;
    // The CRM email plus whatever git is configured with in that repo.
    const emails = new Set([ctx.user.email, git(repo.path, "config", "user.email")?.trim()].filter(Boolean) as string[]);
    if (!emails.size) continue;
    const name = path.basename(path.resolve(repo.path));
    const log = git(
      repo.path, "log", "--all", "--no-merges",
      `--since=${ctx.date} 00:00`, `--until=${nextDay(ctx.date)} 00:00`,
      ...[...emails].sort().map((e) => `--author=${e}`), "--format=%H%x1f%aI%x1f%s",
    );
    for (const line of (log ?? "").split("\n").filter(Boolean)) {
      const [sha, when, subject] = line.split("\x1f");
      out.push({ activity: subject, source: "git", sourceId: `${name}@${sha.slice(0, 10)}`, timestamp: when, group: name, project: repo.project ?? "" });
    }
  }
  return out;
}
