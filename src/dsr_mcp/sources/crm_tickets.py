from decimal import Decimal

from dsr_mcp.sources.base import Activity


def collect(ctx):
    return [
        Activity(
            activity=r["activity"],
            source="crm_ticket",
            source_id=r["source_id"],
            timestamp=r["timestamp"] or "",
            group=r["source_id"],
            project=r["project"],
            hours=Decimal(r["suggested_hours"]),
            category=r["category"],
            status=r["status"],
            ticket=r["ticket"],
        )
        for r in ctx.crm.activities(ctx.date)
    ]
