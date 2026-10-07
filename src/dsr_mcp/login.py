"""One-time sign-in: opens the CRM's loopback OAuth page, receives the code, stores a token."""
import http.server
import secrets
import threading
import urllib.parse
import webbrowser

import httpx

from dsr_mcp import config

CLIENT_ID = "dsr-mcp"


def login(url):
    url = url.rstrip("/")
    state, box = secrets.token_urlsafe(16), {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state") == [state] and "code" in q:
                box["code"] = q["code"][0]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Signed in. You can close this tab.")
            threading.Thread(target=self.server.shutdown).start()

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    redirect = f"http://127.0.0.1:{server.server_port}/callback"
    link = f"{url}/oauth/authorize/?" + urllib.parse.urlencode(
        {"client_id": CLIENT_ID, "redirect_uri": redirect, "state": state}
    )
    print(f"Opening your browser to sign in. If it does not open, visit:\n{link}")
    webbrowser.open(link)
    t = threading.Thread(target=server.serve_forever)
    t.start()
    t.join(180)
    if t.is_alive():
        server.shutdown()
    server.server_close()
    if "code" not in box:
        raise SystemExit("Sign-in timed out or was refused.")
    res = httpx.post(f"{url}/oauth/token/", json={"code": box["code"], "client_id": CLIENT_ID}, timeout=20)
    data = res.json()
    if not data.get("ok"):
        raise SystemExit(f"Token exchange failed: {data}")
    config.save(url=url, token=data["token"])
    print(f"Signed in as {data['user'].get('username', '')}. Saved to {config.PATH}")
