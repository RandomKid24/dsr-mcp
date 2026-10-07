# dsr-mcp

Tell your AI coding tool **"create my DSR"** and it writes your Daily Status Report from the work you actually did, shows it to you, and submits it to the BeForth CRM after you say yes.

## How it works

1. You say "create my DSR" (or "what did I do today?").
2. It looks at **your git commits from today** and **your CRM tickets**, and ignores noise like WIP and merge commits.
3. It writes a DSR and shows it to you. Every line says where it came from (a commit or a ticket). Nothing is made up. Anything you add by hand is marked UNVERIFIED.
4. You fix the hours if needed and say "submit it".
5. It sends it to the CRM. It never submits without your yes, and it never creates duplicates: running it twice just says "already there".

## Install: copy, paste, done

You need **Node 18 or newer** (check with `node -v`). That is all. There is nothing to download or build.

Every tool below starts the server with the same thing: `npx -y github:RandomKid24/dsr-mcp`. Pick your tool, paste, restart the tool.

**Claude Code** (run in a terminal)
```bash
claude mcp add dsr --scope user -- npx -y github:RandomKid24/dsr-mcp
```

**Codex** (run in a terminal)
```bash
codex mcp add dsr -- npx -y github:RandomKid24/dsr-mcp
```

**OpenCode**: add this to `~/.config/opencode/opencode.json`
```json
{ "mcp": { "dsr": { "type": "local", "command": ["npx", "-y", "github:RandomKid24/dsr-mcp"] } } }
```

**Kiro**: add this to `~/.kiro/settings/mcp.json`
```json
{ "mcpServers": { "dsr": { "command": "npx", "args": ["-y", "github:RandomKid24/dsr-mcp"] } } }
```

**Claude Desktop**: Settings, Developer, Edit Config, then add this to `claude_desktop_config.json`
```json
{ "mcpServers": { "dsr": { "command": "npx", "args": ["-y", "github:RandomKid24/dsr-mcp"] } } }
```

**Cursor**: add the same block as Kiro to `~/.cursor/mcp.json`.

**Any other tool (MiMo, Windsurf, VS Code...)**: if it supports MCP servers, it will ask for a command and arguments, or take the same JSON block as Kiro. Command: `npx`. Arguments: `-y github:RandomKid24/dsr-mcp`.

On Windows, if a tool can't start `npx`, use `cmd` as the command and `/c npx -y github:RandomKid24/dsr-mcp` as the arguments.

The config file locations above come from each tool's docs and can change. If a path is missing, search that tool's docs for "MCP servers".

## First time you use it

Say "create my DSR". Your browser opens the CRM sign-in page. Log in with your normal CRM account, close the tab, and say it again. This happens only once; your token is saved in `~/.config/dsr-mcp/config.json` (readable only by you). Each person signs in as themselves, so the DSR goes under the right name.

## Using it

- "What did I do today?"
- "Create my DSR"
- "Hours for the dsr-mcp line should be 3" (corrections happen in the preview)
- "Also add: standup with client, 0.5h" (added as UNVERIFIED)
- "Submit it"
- "I already submitted this morning, update it" (it updates instead of duplicating)

It reads git commits from the folder your AI tool is open in. Open the tool in the project you worked on. In an app with no project open (Claude Desktop), tell it the folder: "my repo is /Users/me/code/crm". To always read several repos, list them once in `~/.config/dsr-mcp/config.json`:

```json
{ "repos": [{ "path": "/Users/me/code/crm", "project": "CRM" }, { "path": "/Users/me/code/billing" }] }
```

`project` is the CRM project name. Without it, the folder name is matched against your CRM projects.

## If something goes wrong

| Problem | Fix |
|---|---|
| Tool says the server failed to start or `npx` not found | Run `which npx` (Windows: `where npx`) and put that full path in the config as the command. Common when Node comes from nvm. |
| Browser didn't open for sign-in | The AI shows you the link. Open it yourself. |
| "No activity found" | Open the tool in the project folder, or give the repo path. Only commits made by your own git email are counted, on today's date. |
| Hours look wrong | Hours from commits are estimates (first to last commit). Correct them before submitting. |
| "Day is closed" | The CRM only accepts today's DSR. Past days are read-only except for admins. |
| Need to sign in again | Delete `~/.config/dsr-mcp/config.json` and ask again. |
| Updating to a new version | `npx` caches the old one. Run `rm -rf ~/.npm/_npx` (Windows: delete `%LocalAppData%\npm-cache\_npx`) and restart the tool. |

## For developers

Eight tools: `dsr_get_user`, `dsr_get_projects`, `dsr_get_today`, `dsr_get_existing`, `dsr_generate`, `dsr_preview`, `dsr_submit` (needs `confirmed=true`, and a preview first), `dsr_update` (needs `confirmed=true`).

```bash
git clone https://github.com/RandomKid24/dsr-mcp.git && cd dsr-mcp
npm install && npm test      # tests run straight from the TypeScript (Node 22.18+)
```

- **Add a source** (GitHub PRs, Jira...): write `src/sources/yours.ts` exporting `collect(ctx) => Activity[]` and add it to `SOURCES` in `src/sources/index.ts`. Draft, preview and submit code don't change.
- **CRM API** (in the CRM repo, `/api/v1/`): `users/me/`, `projects/`, `activities/today/`, `dsr/today/`, `dsr/`, `dsr/<id>/`. Sign-in uses the CRM's loopback OAuth with `client_id=dsr-mcp`.
- **Other CRM:** set `CRM_URL` and `CRM_TOKEN` in the tool's env to skip the browser sign-in.
- **Publish to npm** to get the shorter, self-updating `npx -y dsr-mcp@latest`: run `npm publish` (use a scoped name like `@beforth/dsr-mcp` for a private package), then change `SPEC` in `src/setup.ts`.
