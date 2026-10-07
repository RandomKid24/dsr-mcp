from dataclasses import dataclass
from decimal import Decimal


@dataclass
class Activity:
    """One piece of evidence that work happened. Every DSR line is built from these.

    `group` decides what is merged into one DSR line (a repo, a ticket key).
    `source` + `source_id` is the audit trail: a commit sha, a ticket key, a PR number.
    """

    activity: str
    source: str
    source_id: str
    timestamp: str  # ISO 8601, or "" when the source has none
    group: str
    project: str = ""  # CRM project name when the source knows it
    hours: Decimal | None = None  # a source's own estimate, if it has one
    category: str = "other"
    status: str = "completed"
    ticket: int | None = None  # CRM ticket id, so the CRM links the line to it


@dataclass
class Context:
    date: str  # YYYY-MM-DD, taken from the CRM so everyone shares its timezone
    user: dict  # CRM /users/me
    cfg: dict
    crm: object
