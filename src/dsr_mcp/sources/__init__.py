"""Activity sources. To add one (GitHub PRs, Jira...): write a module with
`collect(ctx) -> list[Activity]` and add it to SOURCES. Nothing else changes."""
from dsr_mcp.sources import crm_tickets, git

SOURCES = {"git": git, "crm_tickets": crm_tickets}
