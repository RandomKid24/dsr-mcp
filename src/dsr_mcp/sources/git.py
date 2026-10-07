"""Commits made on the day, by the user, in each configured repo (default: the current one)."""
import subprocess
from datetime import date, timedelta
from pathlib import Path

from dsr_mcp.sources.base import Activity


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=30)


def _repos(cfg):
    repos = cfg.get("repos") or [{"path": str(Path.cwd())}]
    return [r for r in repos if _git(r["path"], "rev-parse", "--git-dir").returncode == 0]


def collect(ctx):
    day = date.fromisoformat(ctx.date)
    out = []
    for repo in _repos(ctx.cfg):
        # The CRM email plus whatever git is configured with in that repo.
        emails = {ctx.user.get("email", ""), _git(repo["path"], "config", "user.email").stdout.strip()} - {""}
        if not emails:
            continue
        name = Path(repo["path"]).resolve().name
        res = _git(
            repo["path"], "log", "--all", "--no-merges",
            f"--since={day.isoformat()} 00:00", f"--until={(day + timedelta(days=1)).isoformat()} 00:00",
            *[f"--author={e}" for e in sorted(emails)], "--format=%H%x1f%aI%x1f%s",
        )
        for line in res.stdout.splitlines():
            sha, when, subject = line.split("\x1f", 2)
            out.append(Activity(
                activity=subject, source="git", source_id=f"{name}@{sha[:10]}",
                timestamp=when, group=name, project=repo.get("project", ""),
            ))
    return out
