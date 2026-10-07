# dsr-mcp

Type **`/dsr`** in your AI coding tool (or just say **"create my DSR"**) and it writes your Daily Status Report from the work you actually did, shows it to you, and submits it to the BeForth CRM after you say yes.

## How it works

1. You say "create my DSR" (or "what did I do today?").
2. It looks at **your git commits from today** and **your CRM tickets**, and ignores noise like WIP and merge commits.
3. It writes a DSR and shows it to you. Every line says where it came from (a commit or a ticket). Nothing is made up. Anything you add by hand is marked UNVERIFIED.
4. The hours are filled in for you from real times (see below). It asks one thing: submit?
5. It sends it to the CRM. It never submits without your yes, and it never creates duplicates, and if today's DSR already has entries it checks for overlap and asks you what to do (see below).

## Where the hours come from

You are never asked for hours. Each line's time is measured from when the work actually happened:

- **Commits:** the times of your commits. Commits less than 90 minutes apart count as one work session (the time between them), and each session gets 20 minutes for the work before its first commit.
- **Tickets:** the times you commented on, moved or assigned the ticket in the CRM, measured the same way.
- **Capped by attendance:** the total can't be more than the time you were punched in. If it is, every line is scaled down to fit.
- **Never padded:** if you worked 7 hours but only 3 are visible in commits and tickets, the DSR shows 3. To add the rest, tell it ("add: client call, 1h"); that line is marked UNVERIFIED.
- **Tickets with no activity today are left out.** Being assigned a ticket is not work done today.

Times are rounded to 5 minutes (minimum 10 minutes), so you may see lines like 45m or 1h 50m.

## Running /dsr more than once a day

You can run `/dsr` again after filing one. Before submitting, the new draft is compared with what is already in the CRM for the day:

- **Same work:** the same ticket, or the same commit group. This is never added twice; the existing entry is refreshed in place with the new measurement.
- **Similar work:** a task name that shares most of its words with an existing entry (for example "Fix export timeout" and "Fixed the export timeout"). Two unrelated tasks in the same project are not treated as similar.

If anything overlaps, nothing is sent until you choose, for the similar lines: **add as separate entries** (different work), **merge** into the existing entry (hours added, the line's name appended to its notes), or **skip**. Lines with no overlap are just added.

If a draft has more than 3 lines, you are also asked once whether to keep one entry per ticket or repo, or **combine into one entry per project** (hours summed). Running it again later updates that combined entry instead of making a new one.

## Install: one command

You need **Node 18 or newer** (check with `node -v`). Nothing else to download or build.

Paste this in any terminal (in the Claude Code app, use its Terminal panel):

```bash
npx -y github:RandomKid24/dsr-mcp setup
```

It finds the AI tools on your computer and adds the DSR server to each one: Claude Code, Codex, OpenCode, Kiro, Cursor, Windsurf, Gemini CLI and the Claude Desktop chat. It leaves your existing settings alone (it keeps a `.dsr-backup` copy of any file it edits), skips tools you don't have, and is safe to run twice.

Then **open a new session** (or restart the app) and type `/dsr`. Sessions that were already open won't see it.

`setup` also adds a `/dsr` command to Claude Code (`~/.claude/commands/dsr.md`) and OpenCode (`~/.config/opencode/commands/dsr.md`). MCP servers can't be given a `/dsr` name themselves (tools never appear in the `/` menu, and MCP prompts are forced to look like `/mcp__dsr__something`), so this small file is what gives you the short command. A file with that name that you wrote yourself is never overwritten. In Codex and other tools, say "create my DSR" in plain words.

### Terminal and app: is one install enough?

| Tool | Terminal and app share one setup? | Notes |
|---|---|---|
| Claude Code | Yes. Confirmed: the Claude Code app picked up a server added from the terminal | Check with `/mcp` in a new session |
| Codex | Yes, both read `~/.codex/config.toml` | Reopen the Codex app |
| OpenCode | Yes, same config folder | Check with `opencode mcp list` |
| Kiro | Yes, IDE and CLI both use `~/.kiro/settings/mcp.json` | Reopen Kiro |
| Cursor | Yes, `~/.cursor/mcp.json` | Reopen Cursor |
| Claude Desktop (chat window) | Separate from Claude Code | Only if you want it in normal chat; restart the app |
| Windsurf, Gemini CLI | Yes | Reopen the tool |
| MiMo and other tools | Not known | Use the manual block below |

Verified on a real machine with the real tools: Claude Code, Codex and OpenCode each listed `dsr` as connected after `setup`. The others (Kiro, Cursor, Windsurf, Gemini CLI, Claude Desktop) are written from their documented config locations and covered by tests, but have not been run in the real apps.

### Manual install (only if `setup` skipped your tool)

Every tool starts the server with the same thing: command `npx`, arguments `-y github:RandomKid24/dsr-mcp`.

- **Claude Code:** `claude mcp add dsr --scope user -- npx -y github:RandomKid24/dsr-mcp`
- **Codex:** `codex mcp add dsr -- npx -y github:RandomKid24/dsr-mcp`
- **OpenCode:** run `opencode mcp add` and answer: name `dsr`, type local, command `npx -y github:RandomKid24/dsr-mcp`. Or put this in `~/.config/opencode/opencode.json` (it works even if you also have an `opencode.jsonc`; OpenCode merges them):
  ```json
  { "mcp": { "dsr": { "type": "local", "command": ["npx", "-y", "github:RandomKid24/dsr-mcp"] } } }
  ```
- **Kiro, Cursor, Windsurf, Gemini CLI, Claude Desktop, and most others:** add this to the tool's MCP config file (`~/.kiro/settings/mcp.json`, `~/.cursor/mcp.json`, and so on), or enter the command and arguments in its MCP settings screen:
  ```json
  { "mcpServers": { "dsr": { "command": "npx", "args": ["-y", "github:RandomKid24/dsr-mcp"] } } }
  ```
- **Windows:** if a tool can't start `npx`, use `cmd` as the command and `/c npx -y github:RandomKid24/dsr-mcp` as the arguments.

## First time you use it

Say "create my DSR". Your browser opens the CRM sign-in page. Log in with your normal CRM account, close the tab, and say it again. This happens only once; your token is saved in `~/.config/dsr-mcp/config.json` (readable only by you). Each person signs in as themselves, so the DSR goes under the right name.

## Using it

- `/dsr` (Claude Code, OpenCode). Add words after it if you like: `/dsr yesterday`, `/dsr the billing work was 3 hours`
- "What did I do today?"
- "Create my DSR"
- "Make the dsr-mcp line 2 hours" (only if you disagree with the measured time)
- "Also add: standup with client, 0.5h" (added as UNVERIFIED)
- "Submit it"
- "I already submitted this morning, add what I did since" (it checks for overlap first)

It reads git commits from the folder your AI tool is open in. Open the tool in the project you worked on. In an app with no project open (Claude Desktop), tell it the folder: "my repo is /Users/me/code/crm". To always read several repos, list them once in `~/.config/dsr-mcp/config.json`:

```json
{ "repos": [{ "path": "/Users/me/code/crm", "project": "CRM" }, { "path": "/Users/me/code/billing" }] }
```

`project` is the CRM project name. Without it, the folder name is matched against your CRM projects.

## If something goes wrong

| Problem | Fix |
|---|---|
| `/dsr` is missing from the `/` menu | Run `npx -y github:RandomKid24/dsr-mcp setup` again, then open a new session. Say "create my DSR" in tools without it. |
| `dsr` is not in the tool's MCP list | Open a **new** session or restart the app. Already-open sessions load their tools once at the start. |
| Tool says the server failed to start or `npx` not found | Run `which npx` (Windows: `where npx`) and put that full path in the config as the command. Common when Node comes from nvm. |
| Browser didn't open for sign-in | The AI shows you the link. Open it yourself. |
| "No activity found" | Open the tool in the project folder, or give the repo path. Only commits made by your own git email are counted, on today's date. |
| Hours look low | Only work with evidence is counted (commits, ticket activity), and never more than your attendance. Say "make X 2 hours" or "add: standup, 30m" to change it. |
| Hours look high | Lines are capped at your attendance time. If you did not punch in, only the measured time is used. |
| "Day is closed" | The CRM only accepts today's DSR. Past days are read-only except for admins. |
| Need to sign in again | Delete `~/.config/dsr-mcp/config.json` and ask again. |
| Updating to a new version | `npx` caches the old one. Run `rm -rf ~/.npm/_npx` (Windows: delete `%LocalAppData%\npm-cache\_npx`) and restart the tool. |

## For developers

Eight tools: `dsr_get_user`, `dsr_get_projects`, `dsr_get_today`, `dsr_get_existing`, `dsr_generate` (`group_by`: `line` or `project`), `dsr_preview` (reports overlaps), `dsr_submit` (needs `confirmed=true`, a preview first, and `on_overlap`: `separate`, `merge` or `skip` when the preview found overlaps), `dsr_update` (needs `confirmed=true`).

```bash
git clone https://github.com/RandomKid24/dsr-mcp.git && cd dsr-mcp
npm install && npm test      # tests run straight from the TypeScript (Node 22.18+)
```

- **Add a source** (GitHub PRs, Jira...): write `src/sources/yours.ts` exporting `collect(ctx) => Activity[]` and add it to `SOURCES` in `src/sources/index.ts`. Draft, preview and submit code don't change.
- **CRM API** (in the CRM repo, `/api/v1/`): `users/me/`, `projects/`, `activities/today/`, `dsr/today/`, `dsr/`, `dsr/<id>/`. Sign-in uses the CRM's loopback OAuth with `client_id=dsr-mcp`.
- **Other CRM:** set `CRM_URL` and `CRM_TOKEN` in the tool's env to skip the browser sign-in.
- **Add a tool to `setup`:** add one row to `jsonTargets` in `src/setup.ts` (config file, the key that holds servers, entry shape).
- **Publish to npm** to get the shorter, self-updating `npx -y dsr-mcp@latest`: run `npm publish` (use a scoped name like `@beforth/dsr-mcp` for a private package), then change `SPEC` in `src/setup.ts`.
