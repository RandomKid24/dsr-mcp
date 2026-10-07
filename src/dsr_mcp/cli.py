import argparse
import logging

from dsr_mcp import config


def main():
    logging.getLogger("httpx").setLevel(logging.WARNING)
    p = argparse.ArgumentParser(prog="dsr-mcp", description="BeForth DSR MCP server (runs over stdio by default).")
    sub = p.add_subparsers(dest="cmd")
    known = config.load()["url"]
    lg = sub.add_parser("login", help="sign in to the CRM once")
    lg.add_argument("--url", default=known or None, required=not known, help="CRM base URL")
    args = p.parse_args()
    if args.cmd == "login":
        from dsr_mcp.login import login
        login(args.url)
    else:
        from dsr_mcp.server import mcp
        mcp.run()
