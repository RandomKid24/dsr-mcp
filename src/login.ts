// One-time sign-in: opens the CRM's loopback OAuth page, receives the code, stores a token.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as config from "./config.ts";

const CLIENT_ID = "dsr-mcp";

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
    : ["xdg-open", [url]];
  execFile(cmd as string, args as string[], () => {}); // if it fails the link is printed anyway
}

export async function login(rawUrl: string) {
  const url = rawUrl.replace(/\/+$/, "");
  const state = randomBytes(16).toString("base64url");
  let resolveCode!: (c: string | null) => void;
  const got = new Promise<string | null>((r) => (resolveCode = r));

  const server = http.createServer((req, res) => {
    const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    res.end("Signed in. You can close this tab.");
    if (q.get("state") === state && q.get("code")) resolveCode(q.get("code"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const link = `${url}/oauth/authorize/?` + new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirect, state });
  console.log(`Opening your browser to sign in. If it does not open, visit:\n${link}`);
  openBrowser(link);

  const timer = setTimeout(() => resolveCode(null), 180_000);
  const code = await got;
  clearTimeout(timer);
  server.close();
  if (!code) throw new Error("Sign-in timed out or was refused.");

  const res = await fetch(`${url}/oauth/token/`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, client_id: CLIENT_ID }), signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  config.save({ url, token: data.token });
  console.log(`Signed in as ${data.user?.username ?? ""}. Saved to ${config.CONFIG_PATH}`);
}
