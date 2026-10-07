// The only module that talks to the CRM, and only over its HTTP API.

export class CRMError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`CRM answered ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/** The entry is already in the DSR; `existing` is the stored one. */
export class Conflict extends CRMError {
  get existing(): any { return (this.body as any)?.existing ?? {}; }
}

export interface CRMClient {
  me(): Promise<any>;
  projects(): Promise<any[]>;
  today(date?: string): Promise<any>;
  activities(date?: string): Promise<any[]>;
  create(entry: Record<string, unknown>): Promise<any>;
  update(id: number, fields: Record<string, unknown>): Promise<any>;
  findTickets(opts?: { q?: string; product?: number; status?: "open" | "all" }): Promise<any[]>;
  createTicket(body: Record<string, unknown>): Promise<any>; // 409 -> Conflict with .existing
  createProject(body: { name: string; key?: string }): Promise<any>; // 403 unless owner/admin, 409 -> Conflict
}

export class CRM implements CRMClient {
  private url: string;
  private token: string;
  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
    if (!url || !token) {
      throw new CRMError(0, "Not signed in to the CRM.");
    }
  }

  private async call(method: string, path: string, opts: { query?: Record<string, string>; json?: unknown } = {}) {
    const q = opts.query && Object.keys(opts.query).length ? "?" + new URLSearchParams(opts.query) : "";
    const res = await fetch(`${this.url}/api/v1${path}${q}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(opts.json ? { "Content-Type": "application/json" } : {}) },
      body: opts.json ? JSON.stringify(opts.json) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
    if (res.status === 409) throw new Conflict(409, body);
    if (res.status >= 400) throw new CRMError(res.status, body?.error ?? body);
    return body;
  }

  me() { return this.call("GET", "/users/me/"); }
  projects() { return this.call("GET", "/projects/"); }
  today(date?: string) { return this.call("GET", "/dsr/today/", { query: date ? { date } : {} }); }
  activities(date?: string) { return this.call("GET", "/activities/today/", { query: date ? { date } : {} }); }
  create(entry: Record<string, unknown>) { return this.call("POST", "/dsr/", { json: entry }); }
  update(id: number, fields: Record<string, unknown>) { return this.call("PUT", `/dsr/${id}/`, { json: fields }); }
  findTickets(o: { q?: string; product?: number; status?: "open" | "all" } = {}) {
    const query: Record<string, string> = { status: o.status ?? "open" };
    if (o.q) query.q = o.q;
    if (o.product !== undefined) query.product = String(o.product);
    return this.call("GET", "/dsr/tickets/", { query });
  }
  createTicket(body: Record<string, unknown>) { return this.call("POST", "/dsr/tickets/", { json: body }); }
  createProject(body: { name: string; key?: string }) { return this.call("POST", "/projects/", { json: body }); }
}
