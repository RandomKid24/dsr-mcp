import subprocess
from decimal import Decimal

import pytest

from dsr_mcp import core, server
from dsr_mcp.crm import Conflict, CRMError
from dsr_mcp.sources import git
from dsr_mcp.sources.base import Activity, Context

DAY = "2026-10-07"
ME = {"id": 1, "username": "dev", "name": "Dev", "email": "dev@t.local", "company": {"id": 1, "name": "Acme"}, "today": DAY}
PROJECTS = [{"id": 7, "key": "CRM", "name": "CRM"}, {"id": 8, "key": "BIL", "name": "Billing"}]


class FakeCRM:
    """Stands in for the HTTP client; remembers entries and answers 409 on a repeated source_id."""

    def __init__(self, ticket_rows=()):
        self.entries, self.ticket_rows = [], list(ticket_rows)

    def me(self): return ME
    def projects(self): return PROJECTS
    def activities(self, date=None): return self.ticket_rows
    def today(self, date=None): return {"date": DAY, "exists": bool(self.entries), "entries": self.entries}

    def create(self, body):
        for e in self.entries:
            if e["source_id"] == body["source_id"]:
                raise Conflict(409, {"error": "dup", "existing": e})
        self.entries.append({**body, "id": len(self.entries) + 1})
        return self.entries[-1]

    def update(self, entry_id, fields):
        e = next(e for e in self.entries if e["id"] == entry_id)
        e.update(fields)
        return e


def make_repo(tmp_path, commits):
    repo = tmp_path / "crm"
    repo.mkdir()
    run = lambda *a, env=None: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, env=env)
    run("init", "-q")
    run("config", "user.email", "dev@t.local")
    run("config", "user.name", "Dev")
    import os
    for when, msg in commits:
        (repo / "f.txt").write_text(msg)
        run("add", ".")
        env = {**os.environ, "GIT_AUTHOR_DATE": when, "GIT_COMMITTER_DATE": when}
        run("commit", "-q", "-m", msg, env=env)
    return repo


def ctx_for(crm, repo=None):
    return Context(date=DAY, user=ME, cfg={"repos": [{"path": str(repo), "project": "CRM"}] if repo else []}, crm=crm)


def test_git_source_reads_only_that_days_commits(tmp_path):
    repo = make_repo(tmp_path, [
        ("2026-10-06T10:00:00", "yesterday work"),
        ("2026-10-07T09:00:00", "Fix auth redirect"),
        ("2026-10-07T11:00:00", "Add lead import"),
    ])
    found = git.collect(ctx_for(FakeCRM(), repo))
    assert sorted(a.activity for a in found) == ["Add lead import", "Fix auth redirect"]
    assert all(a.source == "git" and a.source_id.startswith("crm@") and a.timestamp for a in found)


def test_noise_is_filtered_and_commits_are_grouped_into_one_line(tmp_path):
    repo = make_repo(tmp_path, [
        ("2026-10-07T09:00:00", "Fix auth redirect"),
        ("2026-10-07T09:30:00", "WIP"),
        ("2026-10-07T11:00:00", "Add lead import"),
    ])
    ctx = ctx_for(FakeCRM(), repo)
    found, errors = core.collect(ctx)
    draft = core.build_draft(ctx, found, PROJECTS)
    assert not errors and len(draft.entries) == 1
    e = draft.entries[0]
    assert e["product"] == 7 and e["source_id"] == f"crm:{DAY}" and "WIP" not in e["task_name"]
    assert e["hours_spent"] == Decimal("2.00")  # 09:00 to 11:00
    assert len(e["evidence"]) == 2


def test_crm_tickets_become_their_own_lines_linked_to_the_ticket():
    row = {"activity": "CRM-007 Vulnerability report: Moved it to in progress", "project": "CRM", "source_id": "CRM-007",
           "ticket": 55, "timestamp": f"{DAY}T10:00:00+05:30", "suggested_hours": "1.50", "category": "bug_fix",
           "status": "in_progress"}
    ctx = ctx_for(FakeCRM([row]))
    found, _ = core.collect(ctx)
    e = core.build_draft(ctx, found, PROJECTS).entries[0]
    assert (e["ticket"], e["product"], e["hours_spent"], e["status"]) == (55, 7, Decimal("1.50"), "in_progress")


def test_a_failing_source_is_reported_not_fatal(tmp_path, monkeypatch):
    class Boom:
        def collect(self, ctx): raise RuntimeError("no network")
    monkeypatch.setitem(core.SOURCES, "boom", Boom())
    found, errors = core.collect(ctx_for(FakeCRM()))
    assert errors == {"boom": "no network"} and found == []


def test_hours_exclude_and_unverified_extras():
    acts = [Activity("CRM-1 A: x", "crm_ticket", "CRM-1", "", "CRM-1", "CRM"),
            Activity("CRM-2 B: y", "crm_ticket", "CRM-2", "", "CRM-2", "CRM")]
    draft = core.build_draft(ctx_for(FakeCRM()), acts, PROJECTS, hours={"CRM-1": 3}, exclude=["CRM-2"],
                             extra=[{"activity": "Standup with client", "project": "Billing", "hours": 0.5}])
    assert [e["hours_spent"] for e in draft.entries] == [Decimal("3.00"), Decimal("0.50")]
    text = core.render(draft, ME)
    assert "UNVERIFIED" in text and "CRM-2" not in text


@pytest.fixture
def wired(monkeypatch, tmp_path):
    crm = FakeCRM([{"activity": "CRM-1 A: x", "project": "CRM", "source_id": "CRM-1", "ticket": 1, "timestamp": None,
                    "suggested_hours": "1.00", "category": "other", "status": "completed"}])
    monkeypatch.setattr(server, "_crm", lambda: (crm, {"repos": []}))
    server.DRAFTS.clear()
    return crm


def test_cannot_submit_without_preview_or_confirmation(wired):
    draft_id = server.dsr_generate()["draft_id"]
    assert "preview" in server.dsr_submit(draft_id, confirmed=True)["error"].lower()
    server.dsr_preview(draft_id)
    assert "not confirmed" in server.dsr_submit(draft_id)["error"]
    assert wired.entries == []
    assert server.dsr_submit(draft_id, confirmed=True)["results"][0]["result"] == "created"
    assert len(wired.entries) == 1


def test_submitting_twice_never_duplicates_and_update_overwrites(wired):
    first = server.dsr_generate()["draft_id"]
    server.dsr_preview(first)
    server.dsr_submit(first, confirmed=True)
    second = server.dsr_generate(hours={"CRM-1": 4})["draft_id"]
    server.dsr_preview(second)
    again = server.dsr_submit(second, confirmed=True)
    assert again["results"][0]["result"] == "already_exists" and len(wired.entries) == 1
    fixed = server.dsr_submit(second, confirmed=True, update_existing=True)
    assert fixed["results"][0]["result"] == "updated" and wired.entries[0]["hours_spent"] == "4.00"


def test_crm_errors_come_back_as_data_not_crashes(monkeypatch):
    def broken():
        raise CRMError(0, "Not signed in.")
    monkeypatch.setattr(server, "_crm", broken)
    assert "Not signed in" in server.dsr_get_user()["error"]
