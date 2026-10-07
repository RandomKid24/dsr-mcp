// The /dsr slash command. Plain markdown, so one file works in Claude Code and OpenCode.
// MCP prompts can't be named /dsr (clients force /mcp__server__prompt), so setup copies this file instead.
export const MARKER = "<!-- dsr-mcp -->";

export const DSR_COMMAND = `---
description: Create today's DSR from my git commits and CRM tickets, and submit it after I approve
---
${MARKER}
Create my Daily Status Report with the dsr MCP tools. $ARGUMENTS

1. Call dsr_get_existing. If a DSR is already filed for the day, tell me what is in it.
2. Call dsr_generate (use the date if I gave one; if no project folder is open, pass the repo path in \`repos\`), then dsr_preview, and show me the whole draft.
3. Ask me to confirm, correct hours, drop lines, or add work. Anything I add that has no source stays marked unverified. Call dsr_generate again if I change something.
4. Call dsr_submit with confirmed=true ONLY after I clearly say to submit. Never submit on your own.
5. If the CRM already has some lines, ask me before using update_existing.
6. Finish by saying what was created or updated.
`;
