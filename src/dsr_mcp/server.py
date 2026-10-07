"""The MCP tools. Thin: each one calls core / crm and returns plain data."""
import functools

from mcp.server.mcpserver import MCPServer

from dsr_mcp import config, core
from dsr_mcp.crm import CRM, CRMError

mcp = MCPServer("beforth-dsr")
# ponytail: drafts live in this process (one MCP session). Persist them if a draft must survive a restart.
DRAFTS: dict[str, core.Draft] = {}


def _crm():
    cfg = config.load()
    return CRM(cfg["url"], cfg["token"]), cfg


def tool(fn):
    """Register fn as an MCP tool; a CRM failure comes back as {"error": ...} instead of a crash."""
    @functools.wraps(fn)
    def run(*a, **kw):
        try:
            return fn(*a, **kw)
        except CRMError as exc:
            return {"error": str(exc)}
    return mcp.tool()(run)


@tool
def dsr_get_user() -> dict:
    """The CRM user this MCP is signed in as, their company, role, and today's date in the CRM's timezone."""
    return _crm()[0].me()


@tool
def dsr_get_projects() -> list:
    """CRM projects (products) the user can log work against."""
    return _crm()[0].projects()


@tool
def dsr_get_today(date: str = "") -> dict:
    """Raw evidence of today's work (git commits, CRM tickets), each with source, source_id and timestamp.
    Use this to answer 'what did I do today?'. Never invent work that is not in this list."""
    crm, cfg = _crm()
    ctx = core.make_context(crm, cfg, date or None)
    found, errors = core.collect(ctx)
    return {
        "date": ctx.date,
        "activities": [a.__dict__ | {"hours": str(a.hours) if a.hours else None} for a in found],
        "source_errors": errors,
    }


@tool
def dsr_get_existing(date: str = "") -> dict:
    """The DSR already filed for the day (today by default). Check this before submitting."""
    return _crm()[0].today(date or None)


@tool
def dsr_generate(date: str = "", hours: dict | None = None, exclude: list[str] | None = None,
                 extra: list[dict] | None = None) -> dict:
    """Build a DSR draft from the day's evidence. Returns a draft_id and the readable draft.
    hours: {source_id: hours} to correct a line's hours. exclude: [source_id] to drop lines.
    extra: [{activity, project, hours}] for work the user says they did that has no source; it is
    marked UNVERIFIED. Call dsr_preview next, then show the user the result."""
    crm, cfg = _crm()
    ctx = core.make_context(crm, cfg, date or None)
    found, errors = core.collect(ctx)
    draft = core.build_draft(ctx, found, crm.projects(), hours, exclude or [], extra or [])
    draft.warnings += [f"Source '{n}' failed: {e}" for n, e in errors.items()]
    if not draft.entries:
        draft.warnings.append("No activity found for this day.")
    DRAFTS[draft.id] = draft
    return {"draft_id": draft.id, "draft": core.render(draft, ctx.user)}


@tool
def dsr_preview(draft_id: str) -> dict:
    """Show the draft for approval. Show the whole text to the user and ask if they want it submitted.
    A draft cannot be submitted until it has been previewed."""
    draft = DRAFTS.get(draft_id)
    if not draft:
        return {"error": "Unknown draft_id. Call dsr_generate first."}
    crm, _ = _crm()
    draft.previewed = True
    existing = crm.today(draft.date)
    return {
        "draft": core.render(draft, crm.me()),
        "already_in_crm": [f"{e['task_name']} ({e['hours_spent']}h)" for e in existing["entries"]],
        "next": "Ask the user to confirm. Only then call dsr_submit with confirmed=true.",
    }


@tool
def dsr_submit(draft_id: str, confirmed: bool = False, update_existing: bool = False) -> dict:
    """Send a previewed draft to the CRM. confirmed must be true and only after the USER has explicitly
    said to submit this draft; never set it on your own. Lines the CRM already has are skipped, or
    overwritten if update_existing is true (ask the user before using that)."""
    draft = DRAFTS.get(draft_id)
    if not draft:
        return {"error": "Unknown draft_id. Call dsr_generate first."}
    if not draft.previewed:
        return {"error": "Call dsr_preview and show it to the user first."}
    if not confirmed:
        return {"error": "Not submitted: the user has not confirmed."}
    result = core.submit(_crm()[0], draft, update_existing)
    skipped = any(r["result"] == "already_exists" for r in result)
    return {
        "results": result,
        "note": "Some lines already exist; ask the user whether to update them (update_existing=true)." if skipped else "Done.",
    }


@tool
def dsr_update(entry_id: int, confirmed: bool = False, task_name: str = "", hours_spent: float | None = None,
               status: str = "", category: str = "", notes: str = "") -> dict:
    """Change one existing DSR entry (get ids from dsr_get_existing). Needs confirmed=true from the user."""
    if not confirmed:
        return {"error": "Not updated: the user has not confirmed."}
    given = {"task_name": task_name, "hours_spent": hours_spent, "status": status, "category": category, "notes": notes}
    fields = {k: v for k, v in given.items() if v not in ("", None)}
    if not fields:
        return {"error": "Nothing to change."}
    return _crm()[0].update(entry_id, fields)
