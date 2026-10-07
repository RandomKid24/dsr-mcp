"""Settings: ~/.config/dsr-mcp/config.json, with CRM_URL / CRM_TOKEN env vars taking priority.

    {"url": "https://crm.beforth.in", "token": "...",
     "repos": [{"path": "/Users/me/code/crm", "project": "CRM"}]}

`dsr-mcp login` writes url and token. `repos` is optional: with none listed, the
git repo the MCP client started the server in is used.
"""
import json
import os
from pathlib import Path

PATH = Path(os.environ.get("DSR_MCP_CONFIG") or Path.home() / ".config" / "dsr-mcp" / "config.json")


def load():
    cfg = json.loads(PATH.read_text()) if PATH.exists() else {}
    cfg["url"] = (os.environ.get("CRM_URL") or cfg.get("url", "")).rstrip("/")
    cfg["token"] = os.environ.get("CRM_TOKEN") or cfg.get("token", "")
    cfg.setdefault("repos", [])
    return cfg


def save(**updates):
    cfg = json.loads(PATH.read_text()) if PATH.exists() else {}
    cfg.update(updates)
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text(json.dumps(cfg, indent=2))
    PATH.chmod(0o600)  # holds a bearer token
