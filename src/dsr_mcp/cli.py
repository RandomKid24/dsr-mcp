import argparse
import logging
import shutil
import subprocess
import sys

from dsr_mcp import config

SPEC = "git+https://github.com/RandomKid24/dsr-mcp"
CLIENTS = {
    "Claude Code": ["claude", "mcp", "add", "dsr", "--scope", "user", "--"],
    "Codex": ["codex", "mcp", "add", "dsr", "--"],
}


def server_command():
    """How an MCP client should start the server: uvx (always the repo's code), else this interpreter."""
    uvx = shutil.which("uvx")  # absolute, because GUI-launched clients have a short PATH
    return [uvx, "--from", SPEC, "dsr-mcp"] if uvx else [sys.executable, "-m", "dsr_mcp.cli"]


def setup(url):
    """Sign in if needed, then register the server with every client found on this machine."""
    if not config.load()["token"]:
        from dsr_mcp.login import login
        login(url)
    cmd = server_command()
    for name, prefix in CLIENTS.items():
        if not shutil.which(prefix[0]):
            continue
        res = subprocess.run(prefix + cmd, capture_output=True, text=True)
        ok = res.returncode == 0 or "already exists" in (res.stdout + res.stderr)
        print(f"{name}: {'registered' if ok else 'FAILED: ' + (res.stderr or res.stdout).strip()}")
    joined = " ".join(f'"{c}"' for c in cmd)
    print("\nOpenCode (opencode.json): " + '{"mcp": {"dsr": {"type": "local", "command": [' + ", ".join(f'"{c}"' for c in cmd) + "]}}}")
    print('Kiro (.kiro/settings/mcp.json): {"mcpServers": {"dsr": {"command": "' + cmd[0] + '", "args": [' + ", ".join(f'"{c}"' for c in cmd[1:]) + "]}}}")
    print("\nRestart your AI tool, then say: create my DSR")


def main():
    logging.getLogger("httpx").setLevel(logging.WARNING)
    p = argparse.ArgumentParser(prog="dsr-mcp", description="BeForth DSR MCP server (runs over stdio by default).")
    sub = p.add_subparsers(dest="cmd")
    known = config.load()["url"]
    for name, text in (("login", "sign in to the CRM once"), ("setup", "sign in and register with Claude Code / Codex")):
        s = sub.add_parser(name, help=text)
        s.add_argument("--url", default=known or None, required=not known, help="CRM base URL")
    args = p.parse_args()
    if args.cmd == "login":
        from dsr_mcp.login import login
        login(args.url)
    elif args.cmd == "setup":
        setup(args.url)
    else:
        from dsr_mcp.server import mcp
        mcp.run()


if __name__ == "__main__":
    main()
