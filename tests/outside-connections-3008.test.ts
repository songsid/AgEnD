/**
 * #3008 (alpha.3; decision 28c2d3a3 rule 3, the user's simplified form hmsg-33c3d609): "Allow connections from outside"
 * on a web-only fleet.
 *
 * The rule (evaluateWebAuthority, authorityNow): a session signed in from outside with the authenticator's code
 * (SessionRecord.remote) over the link the switch opened is this computer's admin — the switch is its opt-in, in place of
 * the named/quick link options; "Only this computer can authorize" still refuses it; the switch off, another link, a chat
 * fleet: none. Its receipts hold while the switch is on and read as none at once when it goes off.
 *
 * A real fleet over HTTP, its public link through the REAL gateway with only the tunnel stubbed (no cloudflared, no
 * trycloudflare — the leader's rule for this host):
 *  - host-only: setting up, the switch, removal answer only this computer's admin on this computer (a LAN session, a
 *    session over the link, no session: refused; over the link the gateway refuses the routes outright);
 *  - on needs an app set up; it opens the link (owned by this computer's admin); the status shows its address here only;
 *  - over the link: the sign-in code works once, makes an admin session that is web-verified as this computer's admin,
 *    which then decides an agent's request in Needs you and applies its own settings change; a Notice says who signed in;
 *  - 5 wrong codes → a 15-minute wait (429, Retry-After) and a Notice; a code from the host's `agend web --code` never
 *    works over the link;
 *  - Off: the link closes and every session from outside ends; a new app ends them too;
 *  - the link expiring turns the switch off with a Notice (turn it on again on this computer); a tunnel that drops is
 *    reopened (twice at most);
 *  - the switch survives a restart: the link opens again when the fleet starts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { authorityNow, evaluateWebAuthority, HOST_OPERATOR, webAuthorityPolicy, type HumanAuthority, type WebAuthorityInput } from "../src/authority/web-authority.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { base32Decode, hotp, totpStep, TOTP_PAUSE_MS, OUTSIDE_LINK_RETRY_MS } from "../src/web-remote-access.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});
beforeEach(() => setLocale("en"));

// ── The rule ──
const EPOCH_HASH = "a".repeat(64), NOW = 1_800_000_000_000, EXPOSURE = "e".repeat(32);
const remoteSession = (over: Partial<SessionRecord> = {}): SessionRecord => ({ handle: "0123456789abcdef", idHash: "b".repeat(64), created: NOW - 1000, lastSeen: NOW,
  absoluteExpiry: NOW + 3_600_000, idleExpiry: NOW + 3_600_000, tier: "admin", surface: "gateway", exposureId: EXPOSURE, label: "Safari", tokenEpoch: EPOCH_HASH, remote: "totp", ...over } as SessionRecord);
function judge(over: Partial<WebAuthorityInput> = {}) {
  const session = (over.session === undefined ? remoteSession() : over.session) as SessionRecord | null;
  return evaluateWebAuthority({
    session, gateway: true, peer: "quick_link", tokenEpoch: EPOCH_HASH, isAdmin: () => false,
    authorization: session ? { handle: session.handle, owner: HOST_OPERATOR, authorizedAt: NOW - 500, until: NOW + 3_600_000, epoch: 3 } : null,
    policy: webAuthorityPolicy(undefined), epoch: 3, now: NOW, hostOperator: true, outside: { exposureId: EXPOSURE }, ...over,
  });
}

describe("#3008 the rule: signed in from outside with the code is this computer's admin while the switch is on", () => {
  it.each([["quick_link"], ["named_link"]] as const)("over the %s, the named/quick link options off (the switch is the opt-in): web-verified as host/operator", peer => {
    const r = judge({ peer });
    expect([r.refusal, r.authority.kind, r.authority.actor, r.authority.session?.peer]).toEqual([null, "web-verified", { adapter_id: "host", user_id: "operator" }, peer]);
  });
  it.each([
    ["the switch off (or no app set up)", { outside: null }, "outside_sign_in"],
    ["another link than the switch's", { outside: { exposureId: "f".repeat(32) } }, "outside_sign_in"],
    ["\"Only this computer can authorize\" on", { policy: { ...webAuthorityPolicy({ verified_authority: { loopback_only: true } } as never) } }, "loopback_only"],
    ["no authorization (ended)", { authorization: null }, "outside_sign_in"],
    ["its authorization run out", { now: NOW + 3_600_001 }, "outside_sign_in"],
    ["off the link (not a gateway request)", { gateway: false, peer: "loopback" as const }, "public_link"],
    ["a chat fleet (no host operator): today's rule — no account", { hostOperator: false }, "no_account"],
  ] as const)("%s: none (%s)", (_why, over, refusal) => {
    const r = judge(over as Partial<WebAuthorityInput>);
    expect([r.refusal, r.authority.kind]).toEqual([refusal, "none"]);
  });
  it("a session over the link that is not one signed in with the code is unchanged (the link options decide, then its account)", () => {
    expect(judge({ session: remoteSession({ remote: undefined }), policy: { ...webAuthorityPolicy({ verified_authority: { quick_link: false } } as never) } }).refusal).toBe("quick_link_off");
    expect(judge({ session: remoteSession({ remote: undefined }) }).refusal).toBe("host_sign_in");
    // …and the code's own session is not held back by that option (the switch is its opt-in).
    expect(judge({ policy: { ...webAuthorityPolicy({ verified_authority: { quick_link: false, named_link: false } } as never) } }).refusal).toBeNull();
  });
  it("#3015 review 2: a receipt authorized before the last revocation (Off, a new app, removal) reads as none, the switch on again or not", () => {
    const stored = judge().authority as HumanAuthority;                                   // authorized_at NOW - 500
    const state = { enabled: true, loopbackOnly: false, namedLink: false, quickLink: false, epoch: 3, outside: true };
    expect(authorityNow(stored, { ...state, outsideSince: NOW - 1000 }).kind).toBe("web-verified");
    expect(authorityNow(stored, { ...state, outsideSince: NOW })).toMatchObject({ kind: "none", downgraded: "revoked" });
    expect(authorityNow({ ...stored, session: { ...stored.session!, authorized_at: "garbled" } } as HumanAuthority, { ...state, outsideSince: 0 })).toMatchObject({ kind: "none" });
  });
  it("its receipts hold while the switch is on — whatever the link options say — and read as none once it is off", () => {
    const stored = judge().authority as HumanAuthority;
    const state = { enabled: true, loopbackOnly: false, namedLink: false, quickLink: false, epoch: 3 };
    expect(authorityNow(stored, { ...state, outside: true }).kind).toBe("web-verified");
    expect(authorityNow(stored, { ...state, outside: false })).toMatchObject({ kind: "none", downgraded: "outside_off" });
    expect(authorityNow(stored, { ...state, outside: true, loopbackOnly: true })).toMatchObject({ kind: "none", downgraded: "loopback_only" });
    // An account's receipt over the quick link is unchanged (its option decides).
    const account = { ...stored, actor: { adapter_id: "dc", user_id: "1" } } as HumanAuthority;
    expect(authorityNow(account, { ...state, outside: true })).toMatchObject({ kind: "none", downgraded: "quick_link_off" });
  });
});

// ── A real fleet ──
interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
const parse = (r: Res) => { try { return JSON.parse(r.body); } catch { return null; } };
const cookieOf = (r: Res) => { const set = r.headers["set-cookie"]; return (Array.isArray(set) ? set[0] : set)!.split(";")[0]!; };
const HOST = "outside-test.trycloudflare.com";

async function startFleet(dir?: string, opts: { ensure?: () => Promise<{ path: string; source: string }>; now?: () => number; web?: Record<string, unknown> } = {}) {
  dir ??= (() => { const d = mkdtempSync(join(tmpdir(), "agend-3008-")); dirs.push(d); return d; })();
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  const warns: string[] = [];
  fm.logger = { info: sink, warn: (_o: unknown, m?: string) => { if (m) warns.push(m); }, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true }, ...opts.web } } as never;
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (any.healthServer as Server).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
  // The tunnel, stubbed: it "publishes" the real gateway at https://HOST; its drop is ours to fire.
  const tunnel = { port: 0, starts: 0, exits: [] as Array<() => void>, fail: false };
  const manager = {
    start: vi.fn(async (_p: unknown, ctx: any) => {
      tunnel.starts++;
      if (tunnel.fail) return { ok: false as const, errorKind: "unknown", message: "stub failure" };
      tunnel.port = Number(new URL(ctx.origin).port);
      ctx.onCandidateHost(HOST);
      return { ok: true as const, handle: { pageUrl: `https://${HOST}/signin`, onUnexpectedExit: (cb: () => void) => { tunnel.exits.push(cb); return () => {}; } } };
    }),
    stop: vi.fn(async () => ({ confirmed: true as const })),
  };
  any.tunnelPurposeLane = new TunnelPurposeLane(manager as never);
  any.publicWebLink = new PublicWebLink({ ...any.publicWebLinkDeps(), ensure: opts.ensure ?? (async () => ({ path: "/stub/cloudflared", source: "agend" })), provider: () => ({}) as never,
    ...(opts.now ? { now: opts.now } : {}) });
  const stop = async () => { await any.publicWebLink?.close("test end"); await new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); }); };
  stops.push(stop);
  /** This computer's admin: `agend web --code` and its sign-in, here. */
  const hostSignIn = async () => {
    const code = parse(await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).code as string;
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    const cookie = cookieOf(res), sessionId = cookie.split("=")[1]!;
    return { cookie, sessionId };
  };
  const local = (s: { cookie: string; sessionId: string }, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    raw(port, method, path, { cookie: s.cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId), ...extra },
      body === undefined ? undefined : JSON.stringify(body));
  /** Through the link: the gateway's port, with the tunnel's Host and Origin. */
  const outside = (method: string, path: string, opts: { session?: { cookie: string; sessionId: string }; body?: unknown } = {}) =>
    raw(tunnel.port, method, path, { host: HOST, origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone) Safari",
      ...(opts.session ? { cookie: opts.session.cookie, [WEB_CSRF_HEADER]: csrfTokenFor(opts.session.sessionId) } : {}) }, opts.body === undefined ? undefined : JSON.stringify(opts.body));
  /** Set up the app from this computer; returns its key. */
  const enroll = async (s: { cookie: string; sessionId: string }) => {
    const begun = await local(s, "POST", "/ui/outside/enroll", {});
    expect(begun.status).toBe(200);
    const { secret, uri } = parse(begun);
    expect(uri).toContain(`secret=${secret}`);
    const key = base32Decode(secret)!;
    const ok = await local(s, "POST", "/ui/outside/enroll/confirm", { code: hotp(key, totpStep(Date.now()) - 1) });
    expect([ok.status, parse(ok)]).toEqual([200, { ok: true }]);
    return key;
  };
  /** Sign in through the link with the app's code (the current step). */
  const codeIn = async (key: Buffer, offset = 0) => {
    const r = await outside("POST", "/auth/totp", { body: { code: hotp(key, totpStep(Date.now()) + offset) } });
    return r.status === 200 ? { status: 200, cookie: cookieOf(r), sessionId: cookieOf(r).split("=")[1]!, res: r } : { status: r.status, res: r };
  };
  const notices = () => (fm.webNoticesFeed()?.view().items ?? []).map(n => n.text);
  return { dir, fm, any, port, origin, token, tunnel, manager, stop, hostSignIn, local, outside, enroll, codeIn, notices, warns };
}

describe("#3008 a real fleet: connections from outside", () => {
  it("only this computer's admin, here, sets it up or switches it; on needs an app; on opens the link, its address shown here only", async () => {
    const h = await startFleet();
    const s = await h.hostSignIn();
    // Off a loopback peer (a LAN session, as a reverse proxy shows): refused.
    expect((await h.local(s, "POST", "/ui/outside/enroll", {}, { "x-forwarded-for": "10.0.0.5" })).status).toBe(403);
    expect((await h.local(s, "POST", "/ui/outside/switch", { on: true })).status).toBe(409);                 // no app yet
    expect(parse(await h.local(s, "POST", "/ui/outside/switch", { on: true })).error).toBe("not_enrolled");
    const key = await h.enroll(s);
    const on = await h.local(s, "POST", "/ui/outside/switch", { on: true });
    expect(on.status).toBe(200);
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    const status = parse(await h.local(s, "GET", "/ui/outside"));
    expect(status).toMatchObject({ webOnly: true, here: true, enrolled: true, outside: true, link: { state: "open", url: `https://${HOST}/signin`, quick: true } });
    expect(JSON.stringify(status)).not.toContain(Buffer.from(key).toString("hex"));
    // Over the link: the status reads (no address), the changes are refused by the gateway itself.
    const r = await h.codeIn(key);
    expect(r.status).toBe(200);
    const remote = r as { cookie: string; sessionId: string };
    const there = parse(await h.outside("GET", "/ui/outside", { session: remote }));
    expect([there.here, there.outside, there.link.url]).toEqual([false, true, undefined]);
    for (const path of ["/ui/outside/enroll", "/ui/outside/enroll/confirm", "/ui/outside/remove", "/ui/outside/switch"]) {
      expect((await h.outside("POST", path, { session: remote, body: { on: false, code: "123456" } })).status).toBe(404);
    }
    // That session's cookie carried straight to this computer's port (not through the link): no one here.
    expect((await h.local(remote, "POST", "/ui/outside/switch", { on: false })).status).not.toBe(200);
    expect(parse(await h.local(s, "GET", "/ui/outside")).outside).toBe(true);
    // No session at all: nothing.
    expect((await raw(h.port, "POST", "/ui/outside/enroll", { origin: h.origin, "content-type": "application/json" }, "{}")).status).toBe(401);
  }, 20_000);

  it("signed in from outside: once per code, this computer's admin — decides an agent's request, applies its own change; a Notice says who", async () => {
    const h = await startFleet();
    const s = await h.hostSignIn();
    const key = await h.enroll(s);
    await h.local(s, "POST", "/ui/outside/switch", { on: true });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    // The host's own code never works over the link (its audience is this computer).
    const hostCode = parse(await raw(h.port, "POST", "/auth/issue-code", { "x-agend-token": h.token, origin: h.origin })).code as string;
    expect((await h.outside("POST", "/auth/login", { body: { code: hostCode } })).status).not.toBe(200);
    const first = await h.codeIn(key) as { status: number; cookie: string; sessionId: string };
    expect(first.status).toBe(200);
    expect((await h.codeIn(key)).status).toBe(401);                                       // the same step again
    const record = h.any.webSessions.authenticate(first.sessionId, tokenEpoch(h.token), { touch: false, surface: "gateway", exposureId: h.any.publicWebLink.exposureId }) as SessionRecord;
    expect([record.remote, record.tier, record.surface, record.owner, record.host]).toEqual(["totp", "admin", "gateway", undefined, undefined]);
    // An agent's Windows request: listed and decided from outside.
    const store = h.any.settingsGate().store;
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => ({ name: "win-builder" })));
    const view = store.propose({ session: "agent:planner", key: "agent-windows:k", fingerprint: "f", bytes: 1, source: "agent_request", section: "channel", requestedBy: "planner",
      summary: ["Create agent win-builder"], authority: { connections: [], primaryGeneral: true, unknown: false }, affectedConnections: [],
      current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
    const listed = parse(await h.outside("GET", "/ui/agent-proposals", { session: first }));
    expect([listed.owner, listed.proposals.map((p: any) => p.id)]).toEqual([true, [view.id]]);
    const decided = await h.outside("POST", `/ui/agent-proposals/${view.id}`, { session: first, body: { decision: "confirm" } });
    expect([decided.status, parse(decided).view.state, apply.mock.calls.length]).toEqual([200, "applied", 1]);
    // Its own settings change, saved over the link, is confirmed by it at once (SettingsHttpConfirmation asks selfConfirm
    // when a change is saved; the routes that save are on the link's manifest — the Apply-now route stays off it, #1423).
    const own = store.propose({ session: record.idHash, key: "web-change", fingerprint: "g", bytes: 1, source: "web", section: "channel", requestedBy: "web",
      summary: ["Change something"], authority: { connections: [], primaryGeneral: true, unknown: false }, affectedConnections: [],
      current: () => true, unchanged: async () => true, snapshot: () => null, apply: vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => ({}))) }).view;
    const overLink = (s: { cookie: string; sessionId: string }) => {
      const req = { method: "POST", url: "/api/settings/apply", headers: { host: HOST, origin: `https://${HOST}`, "sec-fetch-site": "same-origin", cookie: s.cookie, [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId) }, socket: { remoteAddress: "127.0.0.1" } };
      bindGatewayRequest(req, { surface: "gateway", named: false, exposureId: h.any.publicWebLink.exposureId, expectedOrigin: `https://${HOST}`, isCurrent: () => true });
      return req;
    };
    const self = h.any.settingsSelfConfirmation(store, overLink(first), own.id);
    expect(self?.label).toBe("This computer's admin");
    expect((await store.decide(own.id, "confirm", { ...self, via: "web" })).state).toBe("applied");
    // The switch off: the same session confirms nothing any more (it has ended).
    const another = store.propose({ session: record.idHash, key: "web-change-2", fingerprint: "h", bytes: 1, source: "web", section: "channel", requestedBy: "web",
      summary: ["Change more"], authority: { connections: [], primaryGeneral: true, unknown: false }, affectedConnections: [],
      current: () => true, unchanged: async () => true, snapshot: () => null, apply: vi.fn() }).view;
    expect(h.any.settingsSelfConfirmation(store, overLink(first), another.id)?.label).toBe("This computer's admin");
    const s2 = await h.hostSignIn();
    await h.local(s2, "POST", "/ui/outside/switch", { on: false });
    expect(h.any.settingsSelfConfirmation(store, overLink(first), another.id)).toBeNull();
    expect(h.notices()).toEqual([`Signed in from outside: ${record.label}.`]);
    expect(record.label).toBe("browser on iOS");
  }, 20_000);

  it("5 wrong codes → a 15-minute wait (429) and a Notice; a wrong code 2 steps out logs the clock offset", async () => {
    const h = await startFleet();
    const s = await h.hostSignIn();
    const key = await h.enroll(s);
    await h.local(s, "POST", "/ui/outside/switch", { on: true });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    expect((await h.codeIn(key, 2)).status).toBe(401);
    expect(h.warns).toContain("A wrong authenticator code matched a nearby time step: this computer's clock may be off");
    for (let n = 2; n <= 4; n++) expect((await h.outside("POST", "/auth/totp", { body: { code: "000000" } })).status).toBe(401);
    const fifth = await h.outside("POST", "/auth/totp", { body: { code: "000000" } });
    expect([fifth.status, fifth.headers["retry-after"], parse(fifth).retryAfterMs]).toEqual([429, String(TOTP_PAUSE_MS / 1000), TOTP_PAUSE_MS]);
    expect((await h.codeIn(key)).status).toBe(429);                                       // even the right code waits
    expect(h.notices()).toContain("Sign-in from outside is paused for 15 minutes after 5 wrong codes.");
    expect(parse(await h.local(s, "GET", "/ui/outside")).pausedForMs).toBeGreaterThan(TOTP_PAUSE_MS - 60_000);
  }, 20_000);

  it("Off closes the link and ends every session from outside; setting up a new app ends them too; removing turns it off", async () => {
    const h = await startFleet();
    const s = await h.hostSignIn();
    let key = await h.enroll(s);
    await h.local(s, "POST", "/ui/outside/switch", { on: true });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    const a = await h.codeIn(key) as { cookie: string; sessionId: string };
    expect((await h.local(s, "POST", "/ui/outside/switch", { on: false })).status).toBe(200);
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("closed"));
    expect(h.any.webSessions.list(undefined, (r: SessionRecord) => r.remote === "totp")).toEqual([]);
    // On again, signed in again; a new app ends that session.
    await h.local(s, "POST", "/ui/outside/switch", { on: true });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    await new Promise(r => setTimeout(r, 10));
    const b = await h.codeIn(key, 1) as { cookie: string; sessionId: string; status: number };
    expect(b.status).toBe(200);
    key = await h.enroll(s);
    expect(h.any.webSessions.list(undefined, (r: SessionRecord) => r.remote === "totp")).toEqual([]);
    expect((await h.outside("GET", "/ui/agent-proposals", { session: b })).status).toBe(401);
    expect(a).toBeTruthy();
    // Remove: the switch off, the link closed.
    expect((await h.local(s, "POST", "/ui/outside/remove", {})).status).toBe(200);
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("closed"));
    expect(parse(await h.local(s, "GET", "/ui/outside"))).toMatchObject({ enrolled: false, outside: false, link: null });
  }, 20_000);

  it("a dropped tunnel is reopened (after 30 s, then 2 min, no more); the link running out turns the switch off with a Notice", async () => {
    const h = await startFleet();
    const s = await h.hostSignIn();
    await h.enroll(s);
    await h.local(s, "POST", "/ui/outside/switch", { on: true });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.tunnel.fail = true;
    h.tunnel.exits.at(-1)!();                                                              // the tunnel drops
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("closed"));
    expect(h.tunnel.starts).toBe(1);
    await vi.advanceTimersByTimeAsync(OUTSIDE_LINK_RETRY_MS[0]!);
    await vi.waitFor(() => expect(h.tunnel.starts).toBe(2));
    await vi.advanceTimersByTimeAsync(OUTSIDE_LINK_RETRY_MS[1]!);
    await vi.waitFor(() => expect(h.tunnel.starts).toBe(3));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.tunnel.starts).toBe(3);                                                       // twice, no more
    expect(h.notices()).toContain("The outside link has ended (it could not be reopened). Turn it on again on the AgEnD computer, in Settings → Access & security.");
    expect(parse(await h.local(s, "GET", "/ui/outside")).outside).toBe(true);           // still on: the next start tries again
    // It opens again; then its lifetime runs out: off, and said so.
    vi.useRealTimers();
    h.tunnel.fail = false;
    await h.local(s, "POST", "/ui/outside/switch", { on: false });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("closed"));
    await h.local(s, "POST", "/ui/outside/switch", { on: true });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    await h.any.publicWebLink.close("expired");
    expect(parse(await h.local(s, "GET", "/ui/outside")).outside).toBe(false);
    expect(h.notices()).toContain("The outside link has ended (its time ran out). Turn it on again on the AgEnD computer, in Settings → Access & security.");
  }, 30_000);

  it("the switch survives a restart: the link opens again when the fleet starts; a chat fleet never opens it", async () => {
    const h = await startFleet();
    const s = await h.hostSignIn();
    await h.enroll(s);
    await h.local(s, "POST", "/ui/outside/switch", { on: true });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    await h.stop();
    const again = await startFleet(h.dir);
    expect(again.any.outsideOn()).toBe(true);
    again.any.openOutsideLink([0]);                                                        // what start() does for it
    await vi.waitFor(() => expect(again.fm.getPublicWebStatus().state).toBe("open"));
    expect(again.any.publicWebLink.openSignin().owner).toMatchObject({ adapterId: "host", userId: "operator" });
    await again.any.publicWebLink.close("outside off");
    // A chat-connected fleet: the same file, but the switch reads off and nothing opens.
    again.fm.fleetConfig = { ...again.fm.fleetConfig, channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } } as never;
    expect(again.any.outsideOn()).toBe(false);
    again.any.openOutsideLink([0]);
    await new Promise(r => setTimeout(r, 50));
    expect(again.fm.getPublicWebStatus().state).toBe("closed");
  }, 20_000);

  it("#3015 review 2: stored go-ahead receipts from outside: none after Off (and On again), after a new app, after removal; a newly authorized one holds", async () => {
    const h = await startFleet();
    const s = await h.hostSignIn();
    let key = await h.enroll(s);
    const open = async () => { await h.local(s, "POST", "/ui/outside/switch", { on: true }); await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open")); };
    const receipt = async (offset = 0) => {
      const r = await h.codeIn(key, offset) as { status: number; sessionId: string };
      expect(r.status).toBe(200);
      const record = h.any.webSessions.authenticate(r.sessionId, tokenEpoch(h.token), { touch: false, surface: "gateway", exposureId: h.any.publicWebLink.exposureId });
      const now = h.any.webAuthority({ session: record, gateway: true, peer: "quick_link" });
      expect(now.authority.kind).toBe("web-verified");
      return now.authority as HumanAuthority;                                           // what a delivery receipt stores
    };
    const reads = (a: HumanAuthority) => h.fm.receiptAuthorityNow(a).kind;
    await open();
    const first = await receipt();
    expect(reads(first)).toBe("web-verified");
    await new Promise(r => setTimeout(r, 5));
    await h.local(s, "POST", "/ui/outside/switch", { on: false });
    expect(reads(first)).toBe("none");
    await open();
    expect(reads(first)).toBe("none");                                                   // On again: never back
    await new Promise(r => setTimeout(r, 5));
    const second = await receipt(1);                                                      // a newly authorized one: holds
    expect(reads(second)).toBe("web-verified");
    await new Promise(r => setTimeout(r, 5));
    key = await h.enroll(s);                                                              // a new app
    await open();
    expect(reads(second)).toBe("none");
    await new Promise(r => setTimeout(r, 5));
    const third = await receipt();
    expect(reads(third)).toBe("web-verified");
    await new Promise(r => setTimeout(r, 5));
    await h.local(s, "POST", "/ui/outside/remove", {});
    expect(reads(third)).toBe("none");
  }, 30_000);

  it("#3015 review 1: an Off that cannot be saved answers 503 and still closes the link and ends the sessions; asked again once saving works: 200", async () => {
    const h = await startFleet();
    const s = await h.hostSignIn();
    const key = await h.enroll(s);
    await h.local(s, "POST", "/ui/outside/switch", { on: true });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    expect((await h.codeIn(key)).status).toBe(200);
    const store = h.any.webRemoteAccess();
    vi.spyOn(store, "flush" as never).mockImplementationOnce(function (this: any) { this.dirty = true; return false; } as never);
    const off = await h.local(s, "POST", "/ui/outside/switch", { on: false });
    expect([off.status, parse(off).error]).toEqual([503, "unsaved"]);
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("closed"));
    expect(h.any.webSessions.list(undefined, (r: SessionRecord) => r.remote === "totp")).toEqual([]);
    expect((await h.local(s, "POST", "/ui/outside/switch", { on: false })).status).toBe(200);   // dirty: written now
    expect(store.unsaved).toBe(false);
  }, 20_000);

  it("#3015 review 3: the link's lifetime running out while it is still opening turns the switch off; that opening retries nothing", async () => {
    let release!: () => void;
    let mono = 0;
    const held = new Promise<void>(r => { release = r; });
    const h = await startFleet(undefined, { ensure: async () => { await held; return { path: "/stub/cloudflared", source: "agend" }; }, now: () => mono,
      web: { public_link: { ttl_minutes: 1 } } });
    const s = await h.hostSignIn();
    await h.enroll(s);
    expect((await h.local(s, "POST", "/ui/outside/switch", { on: true })).status).toBe(200);
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("starting"));
    mono += 61_000;
    expect(h.fm.getPublicWebStatus().state).not.toBe("open");                            // the real deadline check closes it
    await vi.waitFor(() => expect(h.any.outsideOn()).toBe(false));
    release();
    await vi.waitFor(() => expect(h.any.outsideOpening).toBe(false));
    expect([h.any.outsideAttempt, h.tunnel.starts, h.fm.getPublicWebStatus().state]).toEqual([null, 0, "closed"]);
    expect(h.notices()).toContain("The outside link has ended (its time ran out). Turn it on again on the AgEnD computer, in Settings → Access & security.");
  }, 20_000);

  it("#3015 review 4: the quick and named link options going off keep a session from outside authorized; an account's session over the link loses it", async () => {
    const h = await startFleet(undefined, { web: { verified_authority: { enabled: true, named_link: true, quick_link: true } } });
    const s = await h.hostSignIn();
    const key = await h.enroll(s);
    await h.local(s, "POST", "/ui/outside/switch", { on: true });
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    const remote = await h.codeIn(key) as { status: number; cookie: string; sessionId: string };
    expect(remote.status).toBe(200);
    h.fm.webAuthorityState();                                                             // the options seen on
    // An account's session over the same link, authorized as one would be (control: it is pruned).
    const exposureId = h.any.publicWebLink.exposureId;
    const { record: account } = h.any.webSessions.create({ tier: "admin", surface: "gateway", label: "acct", tokenEpoch: tokenEpoch(h.token), exposureId, owner: { adapterId: "dc", userId: "1" } });
    const auth = h.any.sessionAuthorizationStore();
    const state = h.fm.webAuthorityState();
    auth.authorize(account.handle, { adapterId: "dc", userId: "1" }, Date.now(), state.epoch, Date.now() + 3_600_000, "quick_link");
    const remoteHandle = h.any.webSessions.list(undefined, (r: SessionRecord) => r.remote === "totp")[0].handle;
    expect([!!auth.get(remoteHandle), !!auth.get(account.handle)]).toEqual([true, true]);
    h.fm.fleetConfig = { ...h.fm.fleetConfig, web: { ...h.fm.fleetConfig!.web, verified_authority: { enabled: true, named_link: false, quick_link: false } } } as never;
    h.fm.webAuthorityState();                                                             // the options seen off
    expect([!!auth.get(remoteHandle), !!auth.get(account.handle)]).toEqual([true, false]);
    expect(parse(await h.outside("GET", "/ui/agent-proposals", { session: remote })).owner).toBe(true);
  }, 20_000);
});

