"""Collect -> filter -> group -> draft -> preview -> submit. Knows nothing about git or the CRM's
internals: sources feed it Activity objects and `crm` is the HTTP client."""
import hashlib
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from dsr_mcp.crm import Conflict
from dsr_mcp.sources import SOURCES
from dsr_mcp.sources.base import Context

NOISE = re.compile(r"^(wip\b|fixup!|squash!|merge\b|revert \"?merge)", re.I)
CATEGORY = [
    (re.compile(r"\b(fix|bug|hotfix|patch|crash|error)\b", re.I), "bug_fix"),
    (re.compile(r"\b(doc|docs|readme|changelog)\b", re.I), "documentation"),
    (re.compile(r"\b(add|implement|feat|feature|build|create|support|integrat\w*)\b", re.I), "feature"),
]


def make_context(crm, cfg, date=None):
    me = crm.me()
    return Context(date=date or me["today"], user=me, cfg=cfg, crm=crm)


def collect(ctx):
    """Every source's activity for the day. A source that fails is reported, not fatal."""
    seen, found, errors = set(), [], {}
    for name, src in SOURCES.items():
        try:
            batch = src.collect(ctx)
        except Exception as exc:  # one broken source must not hide the others
            errors[name] = str(exc)
            continue
        for a in batch:
            if (a.source, a.source_id) in seen or NOISE.match(a.activity):
                continue
            seen.add((a.source, a.source_id))
            found.append(a)
    return found, errors


def _quarters(stamps):
    """Hours from the span between the first and last timestamp, in quarters, 0.5 to 4.
    A guess to prefill the preview, never a record; one point in time gets a flat hour."""
    times = sorted(datetime.fromisoformat(s) for s in stamps if s)
    if len(times) < 2:
        return Decimal("1.00")
    minutes = (times[-1] - times[0]).total_seconds() / 60
    if minutes < 15:
        return Decimal("1.00")
    return min(Decimal(4), max(Decimal("0.5"), Decimal(round(minutes / 15)) / 4)).quantize(Decimal("0.01"))


def _category(text):
    return next((c for rx, c in CATEGORY if rx.search(text)), "other")


def _project_id(name, group, projects):
    """CRM project id for a source's project name, falling back to the repo name."""
    wanted = [n.lower() for n in (name, group) if n]
    for p in projects:
        if p["name"].lower() in wanted:
            return p["id"]
    for p in projects:
        if any(p["name"].lower() in w or w in p["name"].lower() for w in wanted):
            return p["id"]
    return None


@dataclass
class Draft:
    id: str
    date: str
    entries: list
    warnings: list = field(default_factory=list)
    previewed: bool = False


def build_draft(ctx, activities, projects, hours=None, exclude=(), extra=()):
    """One DSR line per ticket, and one per repo for commits. `hours` maps a line's
    source_id to hours; `exclude` drops lines; `extra` are lines the user added that no
    source backs, kept and marked unverified."""
    hours, exclude = hours or {}, set(exclude)
    groups, entries, warnings = {}, [], []
    for a in activities:
        groups.setdefault((a.source, a.group), []).append(a)

    for (source, group), acts in groups.items():
        first = acts[0]
        if source == "git":
            subjects = [a.activity for a in sorted(acts, key=lambda a: a.timestamp)]
            more = f" (+{len(subjects) - 3} more)" if len(subjects) > 3 else ""
            e = {
                "task_name": f"{group}: {'; '.join(subjects[:3])}{more}"[:255],
                "category": _category(" ".join(subjects)),
                "status": "completed",
                "hours_spent": _quarters([a.timestamp for a in acts]),
                "notes": "Commits: " + ", ".join(a.source_id.split("@")[-1] for a in acts),
                "source": "git",
                "source_id": f"{group}:{ctx.date}",
                "ticket": None,
            }
        else:
            e = {
                "task_name": first.activity.split(":")[0][:255],
                "category": first.category,
                "status": first.status,
                "hours_spent": first.hours or Decimal("1.00"),
                "notes": first.activity.split(": ", 1)[-1],
                "source": first.source,
                "source_id": first.source_id,
                "ticket": first.ticket,
            }
        e["product"] = _project_id(first.project, group if source == "git" else "", projects)
        e["project"] = next((p["name"] for p in projects if p["id"] == e["product"]), "")
        if source == "git" and e["product"] is None:
            warnings.append(f"No CRM project matched '{group}'; it will be logged with no project.")
        e["evidence"] = [
            {"source": a.source, "source_id": a.source_id, "activity": a.activity, "timestamp": a.timestamp}
            for a in acts
        ]
        entries.append(e)

    for x in extra:
        digest = hashlib.sha1(x["activity"].encode()).hexdigest()[:8]
        entries.append({
            "task_name": x["activity"][:255], "category": x.get("category", "other"),
            "status": x.get("status", "completed"), "hours_spent": Decimal(str(x.get("hours", 1))),
            "notes": "Added by the user; no source.", "source": "manual",
            "source_id": f"manual:{ctx.date}:{digest}", "ticket": None,
            "product": _project_id(x.get("project", ""), "", projects),
            "project": x.get("project", ""), "evidence": [],
        })

    entries = [e for e in entries if e["source_id"] not in exclude]
    for e in entries:
        if e["source_id"] in hours:
            e["hours_spent"] = Decimal(str(hours[e["source_id"]]))
        e["hours_spent"] = Decimal(e["hours_spent"]).quantize(Decimal("0.01"))
    return Draft(uuid.uuid4().hex[:8], ctx.date, entries, warnings)


def render(draft, user):
    lines = [f"DSR for {draft.date}: {user.get('name', '')} ({user['company']['name']})", ""]
    total = Decimal(0)
    for i, e in enumerate(draft.entries, 1):
        total += e["hours_spent"]
        proof = f"{e['source']} {e['source_id']}" if e["evidence"] else "UNVERIFIED, no source"
        lines.append(f"{i}. [{e['project'] or 'no project'}] {e['task_name']}")
        lines.append(f"   {e['hours_spent']}h, {e['status'].replace('_', ' ')}, {e['category'].replace('_', ' ')}  ({proof})")
        for ev in e["evidence"][:5]:
            lines.append(f"     - {ev['activity']}  [{ev['source_id']}]")
    lines += ["", f"Total: {total}h (hours from commits are estimates; tell me the right ones)"]
    lines += [f"Note: {w}" for w in draft.warnings]
    return "\n".join(lines)


def _payload(e, date):
    return {
        "date": date, "task_name": e["task_name"], "product": e["product"], "category": e["category"],
        "hours_spent": str(e["hours_spent"]), "status": e["status"], "notes": e["notes"],
        "source": e["source"], "source_id": e["source_id"], "ticket": e["ticket"],
    }


def submit(crm, draft, update_existing=False):
    """Create each line; a line the CRM already has is skipped, or updated when asked."""
    done = []
    for e in draft.entries:
        body = _payload(e, draft.date)
        try:
            done.append({"task": e["task_name"], "result": "created", "id": crm.create(body)["id"]})
        except Conflict as c:
            if not update_existing:
                done.append({"task": e["task_name"], "result": "already_exists", "id": c.existing.get("id")})
                continue
            fields = {k: body[k] for k in ("task_name", "product", "category", "hours_spent", "status", "notes")}
            done.append({"task": e["task_name"], "result": "updated", "id": crm.update(c.existing["id"], fields)["id"]})
    return done
