# dsr-mcp

An MCP server that writes your Daily Status Report from work you actually did (git commits, CRM tickets), shows it to you, and submits it to the BeForth CRM only after you say yes. Works with any MCP client: Claude Code, Codex, OpenCode, Kiro.

Say "what did I do today?", "create my DSR", then "submit it".

## Install

```bash
git clone https://github.com/RandomKid24/dsr-mcp.git && cd dsr-mcp
python3 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/dsr-mcp login --url https://crm.beforth.in    # opens your browser once, stores a token
```

The token is saved to `~/.config/dsr-mcp/config.json` (mode 600). Or skip `login` and set `CRM_URL` and `CRM_TOKEN`.

## Register it (use absolute paths)

```bash
claude mcp add dsr --scope user -- /ABS/PATH/dsr-mcp/.venv/bin/dsr-mcp
codex mcp add dsr -- /ABS/PATH/dsr-mcp/.venv/bin/dsr-mcp
```

OpenCode (`opencode.json`): `{"mcp": {"dsr": {"type": "local", "command": ["/ABS/PATH/dsr-mcp/.venv/bin/dsr-mcp"]}}}`

Kiro (`.kiro/settings/mcp.json`): `{"mcpServers": {"dsr": {"command": "/ABS/PATH/dsr-mcp/.venv/bin/dsr-mcp"}}}`

Config formats change between releases; check each client's docs if one fails.

## Which repos are read

By default the git repo the client starts the server in. To read several, list them in `~/.config/dsr-mcp/config.json`:

```json
{"repos": [{"path": "/Users/me/code/crm", "project": "CRM"}, {"path": "/Users/me/code/billing"}]}
```

`project` is the CRM project name; without it the repo folder name is matched against your CRM projects.

## Tools

| Tool | Does |
|---|---|
| `dsr_get_user` | The signed-in CRM user and today's date |
| `dsr_get_projects` | CRM projects you can log against |
| `dsr_get_today` | Raw evidence: commits and tickets, each with `source`, `source_id`, `timestamp` |
| `dsr_get_existing` | The DSR already in the CRM for the day |
| `dsr_generate` | Builds a draft (one line per ticket, one per repo). Accepts hour corrections, exclusions, and extra lines, which are marked UNVERIFIED |
| `dsr_preview` | Shows the draft. A draft can't be submitted before this |
| `dsr_submit` | Sends it. Needs `confirmed=true`. Lines the CRM already has are skipped, or updated with `update_existing=true` |
| `dsr_update` | Edits one existing entry. Needs `confirmed=true` |

Every line is built from evidence and keeps its source in the CRM (`source`, `source_id`). Hours from commits are estimates from the first-to-last commit span; correct them in the preview.

## Add a source (GitHub PRs, Jira...)

Write `src/dsr_mcp/sources/yours.py` with `collect(ctx) -> list[Activity]`, then add it to `SOURCES` in `sources/__init__.py`. The draft, preview and submit code don't change.

## Develop

```bash
.venv/bin/pip install -e ".[dev]" && .venv/bin/python -m pytest
```

The CRM side lives in the CRM repo: `/api/v1/users/me/`, `projects/`, `activities/today/`, `dsr/today/`, `dsr/`, `dsr/<id>/`.
