/**
 * #3292: Keep sign-in alive's seams —
 * - POST /ui/accounts/keep-alive reaches its own handler (dispatched before the accounts prefix, whose Add pattern
 *   `POST /ui/accounts/<backend>` would read "keep-alive" as a backend), never addAccountProfile; the same gate as the
 *   other account writes (the local admin session only; never the CLI's token, a read or guest session, no CSRF, the gateway);
 * - the Accounts view copies each row's keep-alive part by `backend\0profile`, as it copies usage;
 * - Needs you shows a kept sign-in as reason=backend_signin (an older panel renders it, with its Sign in button) and the
 *   chat line carries the detail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { GUEST_ROUTES } from "../src/web-guest-access.js";
import { buildAccountsView, type AccountsInput } from "../src/accounts-view.js";
import { deriveNeedsYou, renderSignature, type NeedsYouInputs } from "../src/needs-you.js";
import { NeedsYouHub } from "../src/needs-you-hub.js";

describe("POST /ui/accounts/keep-alive", () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); });
  async function fixture() {
    const token = "keepalive-scratch-token";
    const sessions = new WebSessionStore({});
    const add = vi.fn(() => ({ ok: true } as any));
    const keep = vi.fn((_b: unknown, _p: unknown, _e: unknown, _f: unknown, _by: string) => ({ ok: true } as any));
    const ctx = { webToken: token, webSessions: sessions, addAccountProfile: add, setAccountKeepAlive: keep } as unknown as WebApiContext;
    const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const session = (tier: "admin" | "read" | "guest" = "admin") => {
      const made = sessions.create({ tier, surface: "local", label: "Firefox on Linux", tokenEpoch: tokenEpoch(token), ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "g1" } } : {}) });
      return { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId), "content-type": "application/json" } as Record<string, string>;
    };
    const call = (method: string, headers: Record<string, string>, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = request(`${origin}/ui/accounts/keep-alive`, { method, headers: { ...headers, ...(data ? { "content-length": String(data.length) } : {}) } }, res => {
        const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
        res.on("end", () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); });
      });
      r.on("error", reject); r.end(data);
    });
    return { add, keep, sessions, token, origin, session, call, ctx };
  }

  it("the local admin session reaches the keep-alive handler — never + Add account", async () => {
    const f = await fixture();
    expect(await f.call("POST", f.session(), { backend: "claude-code", profile: "work", enabled: true, fallback: false }))
      .toEqual({ status: 200, body: { backend: "claude-code", profile: "work", enabled: true } });
    expect(f.keep).toHaveBeenCalledWith("claude-code", "work", true, false, "Firefox on Linux");
    expect(await f.call("POST", f.session(), { backend: "codex", profile: null, enabled: false })).toMatchObject({ status: 200 });
    expect(f.keep).toHaveBeenLastCalledWith("codex", null, false, undefined, "Firefox on Linux");
    expect(f.add).not.toHaveBeenCalled();
  });
  it("no session, the CLI's token, a read or guest session, no CSRF header, another method: refused, nothing called", async () => {
    const f = await fixture(), body = { backend: "codex", profile: null, enabled: true };
    expect((await f.call("POST", { origin: f.origin, "content-type": "application/json" }, body)).status).toBe(401);
    expect(await f.call("POST", { "x-agend-token": f.token, origin: f.origin, "content-type": "application/json" }, body)).toMatchObject({ status: 403, body: { error: "accounts_need_a_local_admin" } });
    for (const tier of ["read", "guest"] as const) expect((await f.call("POST", f.session(tier), body)).status, tier).toBe(403);
    const { "x-agend-csrf": _c, ...noCsrf } = f.session();
    expect((await f.call("POST", noCsrf, body)).status).toBe(401);
    expect((await f.call("DELETE", f.session(), body)).status).toBe(405);
    expect([f.keep.mock.calls.length, f.add.mock.calls.length]).toEqual([0, 0]);
  });
  it("a strict body; refusals keep their code", async () => {
    const f = await fixture(), a = f.session();
    for (const bad of [{ backend: "codex", profile: null }, { backend: "codex", profile: null, enabled: "yes" }, { backend: "codex", profile: null, enabled: true, extra: 1 }, { backend: "codex", enabled: true }]) {
      expect((await f.call("POST", a, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(f.keep).not.toHaveBeenCalled();
    for (const [error, status] of [["backend", 400], ["profile", 400], ["fallback", 400], ["write", 500]] as const) {
      f.keep.mockReturnValueOnce({ ok: false, error });
      expect(await f.call("POST", a, { backend: "codex", profile: null, enabled: true }), error).toEqual({ status, body: { error } });
    }
  });
  it("the public link: not in its manifest or the guest table; a bound gateway request is refused even as an admin", async () => {
    const f = await fixture();
    expect(isPublicWebRoute("POST", "/ui/accounts/keep-alive")).toBe(false);
    expect(GUEST_ROUTES.some(r => (r.methods as readonly string[]).includes("POST") && r.pattern.test("/ui/accounts/keep-alive"))).toBe(false);
    const made = f.sessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "gateway", tokenEpoch: tokenEpoch(f.token) });
    let status = 0, sent = "";
    const res: any = { headersSent: false, setHeader() {}, writeHead(n: number) { status = n; this.headersSent = true; return this; }, end(chunk?: unknown) { sent = String(chunk ?? ""); } };
    const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/accounts/keep-alive", headers: { host: "x.trycloudflare.com", origin: "https://x.trycloudflare.com", cookie: `__Host-agend_session=${made.sessionId}`, "x-agend-csrf": csrfTokenFor(made.sessionId) }, destroy() {}, resume() {} });
    bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
    expect(handleWebRequest(req as never, res, new URL("https://x.trycloudflare.com/ui/accounts/keep-alive"), f.ctx)).toBe(true);
    expect([status, JSON.parse(sent).error]).toEqual([403, "accounts_not_over_public_link"]);
    expect(f.keep).not.toHaveBeenCalled();
  });
});

describe("the Accounts view carries each row's keep-alive part", () => {
  it("by backend\\0profile, as usage; rows without one have none", () => {
    const input: AccountsInput = {
      targets: [{ backend: "claude-code", state: "usable", signIn: true }, { backend: "codex", state: "usable", signIn: true }],
      diskProfiles: new Map([["claude-code", [{ profile: "work", state: "usable", signIn: true }]]]),
      agents: [], classic: [], fleetDefaults: new Map(),
      keepAlive: new Map([["claude-code\0work", { enabled: true, fallback: false, endsAt: "2026-11-18T17:23:30.000Z" }], ["codex\0", { enabled: false }]]),
    };
    const v = buildAccountsView(input);
    const rows = v.clis.flatMap(c => c.rows.map(r => [r.backend, r.profile, r.keepAlive ?? null]));
    expect(rows).toEqual([
      ["claude-code", null, null],
      ["claude-code", "work", { enabled: true, fallback: false, endsAt: "2026-11-18T17:23:30.000Z" }],
      ["codex", null, { enabled: false }],
    ]);
  });
});

describe("Needs you: a kept sign-in", () => {
  const inputs = (over: Partial<NeedsYouInputs> = {}): NeedsYouInputs => ({ prompts: [], instances: [], deliveries: [], ownerOf: () => "dc", ...over });
  it("reason backend_signin (every panel renders it), its detail, its world, and Sign in for that profile when the dashboard can", () => {
    const items = deriveNeedsYou(inputs({ signInKeepAlive: [
      { backend: "claude-code", profile: "work", kind: "ending", detail: "Claude Code · work: this sign-in ends by 2026-11-18", since: 1_000, owner: "dc", signIn: true },
      { backend: "codex", profile: null, kind: "transient", detail: "Codex · default sign-in: failing since 2026-11-05", since: 2_000, owner: "dc", signIn: false },
    ] }));
    expect(items).toEqual([
      { id: "keepalive:ending:claude-code:work:1000", type: "backend", instance: "", reason: "backend_signin", detail: "Claude Code · work: this sign-in ends by 2026-11-18", since: 1_000, keepAlive: true, owner: "dc", signIn: { backend: "claude-code", profile: "work" } },
      { id: "keepalive:transient:codex::2000", type: "backend", instance: "", reason: "backend_signin", detail: "Codex · default sign-in: failing since 2026-11-05", since: 2_000, keepAlive: true, owner: "dc" },
    ]);
    // The chat line names which sign-in and why (the chat shows no detail line); a plain backend sign-in keeps its bare title.
    const hub = new NeedsYouHub({ mono: () => 0, t: (k: string) => (k === "needs.reason.backend_signin" ? "Backend sign-in needed" : k) } as never);
    expect((hub as any).lineTitle(items[0])).toBe("Backend sign-in needed: Claude Code · work: this sign-in ends by 2026-11-18");
    const plain = deriveNeedsYou(inputs({ backendSignIns: [{ backend: "codex", since: 1, browser: true }] }))[0]!;
    expect((hub as any).lineTitle(plain)).toBe("Backend sign-in needed");
    // A changed line renders again.
    const other = deriveNeedsYou(inputs({ signInKeepAlive: [{ backend: "claude-code", profile: "work", kind: "ending", detail: "different", since: 1_000, owner: "dc", signIn: true }] }));
    expect(renderSignature(other, 5_000)).not.toBe(renderSignature(items.slice(0, 1), 5_000));
  });
});
