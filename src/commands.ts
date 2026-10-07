// The slash commands (/dsr, /ticket, /dsr-ticket). Plain markdown, so one file works in Claude Code and OpenCode.
// MCP prompts can't be named /dsr (clients force /mcp__server__prompt), so setup copies these files instead.
export const MARKER = "<!-- dsr-mcp -->";

export const DSR_COMMAND = `---
description: Create today's DSR from my git commits and CRM tickets, and submit it after I approve
---
${MARKER}
Create my Daily Status Report with the dsr MCP tools. $ARGUMENTS

1. Call dsr_get_existing. If a DSR is already filed for the day, tell me what is in it.
2. Call dsr_generate (use the date if I gave one; if no project folder is open, pass the repo path in \`repos\`). The hours are already measured from real commit and ticket times, so never ask me about hours. If the draft has more than 3 lines, ask me once: keep one entry per ticket/repo, or combine into one entry per project? If I choose project, call dsr_generate again with group_by="project".
3. Call dsr_preview and show me the whole draft.
4. If dsr_preview reports overlaps with entries already in the CRM, list them in plain words (my line and the existing entry it matches). Lines marked same_work are the same ticket or source as an existing entry, so they are refreshed in place; say so. For lines marked similar, ask me ONE question: keep them as separate entries, merge them into the existing entry, or skip them. Pass my answer to dsr_submit as on_overlap: separate, merge or skip.
5. Ask me whether to submit. If I volunteer a change (drop a line, correct hours, add work), call dsr_generate again with it, then dsr_preview. Work I add that has no source stays marked unverified.
6. Call dsr_submit with confirmed=true ONLY after I clearly say to submit (pass on_overlap too if there were overlaps). Never submit on your own.
7. Finish by saying what was created, updated, merged or skipped.
`;

const PROJECT_STEP = `Call dsr_get_projects. Pick the project only if exactly one is a sensible match; if more than one could fit, ask me which. If none fits or none exist, ask me to pick one or to create one with crm_create_project (confirm the name first). Only owners and admins can create projects: if dsr_get_user says can_create_projects is false, tell me to ask an admin instead of trying.`;

export const TICKET_COMMAND = `---
description: Create CRM tickets from today's work or from what I describe, after I approve
---
${MARKER}
Create CRM tickets with the dsr MCP tools. $ARGUMENTS
This also works by just typing the request in chat, for example "make a ticket for the login bug".

1. If my words above describe the ticket(s), use those. Otherwise call dsr_get_today and offer the day's work (commit groups, ticket activity) as candidates, and ASK me which to turn into tickets. I can also type my own.
2. ${PROJECT_STEP}
3. Call crm_find_tickets first to avoid duplicates, and tell me about near matches (offer to use the existing one instead).
4. Show me the tickets to be created (title, project, status) and ask for a yes.
5. Only after a clear yes, call crm_create_ticket with confirmed=true for each. Never create anything without that yes.
6. Finish with the ticket keys and links.
`;

export const DSR_TICKET_COMMAND = `---
description: Create CRM tickets for chosen lines of today's work and file the DSR in one go
---
${MARKER}
Create tickets and my Daily Status Report together with the dsr MCP tools. $ARGUMENTS
This also works by just typing the request in chat, for example "make tickets for my commits and file my DSR".

1. Call dsr_get_existing. If a DSR is already filed for the day, tell me what is in it.
2. Call dsr_generate (use the date if I gave one; if no project folder is open, pass the repo path in \`repos\`) and show me the lines. The hours are measured, so never ask me about hours.
3. ASK me which lines should become tickets and which should only be in the DSR. Lines that already come from a CRM ticket do not need one.
4. ${PROJECT_STEP} Lines with no project need one before they can get a ticket.
5. Show me the tickets to be created (title, project, status) and ask for a yes.
6. Only after a clear yes, call dsr_ticket_from_lines with confirmed=true for the chosen lines.
7. Call dsr_preview and show me the whole DSR again. Handle overlaps and grouping exactly as the /dsr command does: for overlaps list them in plain words and ask ONE question (separate, merge or skip, passed as on_overlap); if the draft has more than 3 lines ask once whether to keep one entry per ticket/repo or combine per project (then call dsr_generate again with group_by="project" and dsr_preview; combined entries carry no ticket link, so warn me that the new tickets stay in the CRM but the DSR line will not point at them).
8. Call dsr_submit with confirmed=true ONLY after I clearly say to submit. Never submit on your own.
9. Finish with the ticket keys and links, and what the DSR created, updated, merged or skipped.
`;

export const COMMANDS: { name: "dsr" | "ticket" | "dsr-ticket"; markdown: string }[] = [
  { name: "dsr", markdown: DSR_COMMAND },
  { name: "ticket", markdown: TICKET_COMMAND },
  { name: "dsr-ticket", markdown: DSR_TICKET_COMMAND },
];
