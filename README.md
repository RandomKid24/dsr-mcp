# dsr-mcp

An MCP server that writes your Daily Status Report from work you actually did (git commits, CRM tickets), shows it to you, and submits it to the BeForth CRM only after you say yes. Works with any MCP client: Claude Code, Codex, OpenCode, Kiro.

Say "what did I do today?", "create my DSR", then "submit it".

## Install (one command)

Needs Node 18+ and git, and access to this repo.

```bash
npx -y github:RandomKid24/dsr-mcp setup --url https://crm.beforth.in
```

It opens your browser to sign in once, stores your token in `~/.config/dsr-mcp/config.json` (mode 600), and registers the server with Claude Code and Codex if they are installed. For OpenCode and Kiro it prints the config to paste. Restart your AI tool, then say "create my DSR".

Every client starts the server with `npx -y github:RandomKid24/dsr-mcp`. Or skip `setup` and set `CRM_URL` and `CRM_TOKEN` in the client's env.

**Update:** `npx` caches what it downloaded. Clear it with `rm -rf ~/.npm/_npx` (Windows: delete `%LocalAppData%\npm-cache\_npx`) and restart your AI tool.

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
| `dsr_get_today` | Raw evidence: commits and tickets, each with `source`, `sourceId`, `timestamp` |
| `dsr_get_existing` | The DSR already in the CRM for the day |
| `dsr_generate` | Builds a draft (one line per ticket, one per repo). Accepts hour corrections, exclusions, and extra lines, which are marked UNVERIFIED |
| `dsr_preview` | Shows the draft. A draft can't be submitted before this |
| `dsr_submit` | Sends it. Needs `confirmed=true`. Lines the CRM already has are skipped, or updated with `update_existing=true` |
| `dsr_update` | Edits one existing entry. Needs `confirmed=true` |

Every line is built from evidence and keeps its source in the CRM (`source`, `source_id`). Hours from commits are estimates from the first-to-last commit span; correct them in the preview.

## Add a source (GitHub PRs, Jira...)

Write `src/sources/yours.ts` exporting `collect(ctx) => Activity[]`, then add it to `SOURCES` in `src/sources/index.ts`. The draft, preview and submit code don't change.

## Develop

```bash
npm install && npm test      # tests run straight from the TypeScript (Node 22.18+)
npm run build                # tsc -> dist/
```

`npm install` also builds (`prepare`), which is how `npx github:...` gets a runnable package.

## Publishing to npm later

`npx -y dsr-mcp@latest` is shorter and updates itself. Run `npm publish` (use a scoped name like `@beforth/dsr-mcp` for a private package), then change `SPEC` in `src/setup.ts` to `dsr-mcp@latest`.

The CRM side lives in the CRM repo: `/api/v1/users/me/`, `projects/`, `activities/today/`, `dsr/today/`, `dsr/`, `dsr/<id>/`.
