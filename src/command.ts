// The /dsr slash command. Plain markdown, so one file works in Claude Code and OpenCode.
// MCP prompts can't be named /dsr (clients force /mcp__server__prompt), so setup copies this file instead.
export const MARKER = "<!-- dsr-mcp -->";

export const DSR_COMMAND = `---
description: Create today's DSR from my git commits and CRM tickets, and submit it after I approve
---
${MARKER}
Create my Daily Status Report with the dsr MCP tools. $ARGUMENTS

1. Call dsr_get_existing. If a DSR is already filed for the day, tell me what is in it.
2. Call dsr_generate (use the date if I gave one; if no project folder is open, pass the repo path in \`repos\`). The hours are already measured from real commit and ticket times, so never ask me about hours. If the draft has more than 3 lines, ask me once: keep one entry per ticket/repo, or combine into one entry per project? If I choose project, call dsr_generate again with group_by="project".
3. Call dsr_preview and show me the whole draft.
4. If dsr_preview reports overlaps with entries already in the CRM, list them in plain words (my line and the existing entry it matches) and ask me ONE question for the overlapping lines: update the existing entry, add as separate entries, merge into the existing entry, or skip. Lines marked same_work are the same ticket or source, so they are always refreshed in place; say so. Map my answer to dsr_submit on_overlap: separate, merge or skip ("update" means the same-work lines are refreshed, which happens anyway, so use separate for any similar ones I did not ask to merge or skip).
5. Ask me whether to submit. If I volunteer a change (drop a line, correct hours, add work), call dsr_generate again with it, then dsr_preview. Work I add that has no source stays marked unverified.
6. Call dsr_submit with confirmed=true ONLY after I clearly say to submit (pass on_overlap too if there were overlaps). Never submit on your own.
7. Finish by saying what was created, updated, merged or skipped.
`;
