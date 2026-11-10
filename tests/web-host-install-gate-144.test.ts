/**
 * AGEND-144 (Prism on #3536/#3539): the dashboard's Install of an AI CLI on the AgEnD computer is a held change of the Settings gate, like any other that acts on the
 * host — not a route that checks a session and starts. Real here: FleetManager's session store, its settings policy (settingsDirectCreationAllowed, the admin's own
 * authenticator and "ask for my code" switch), the real SettingsHttpConfirmation with the principal built as the fleet builds it, and the real route behind it
 * (handleWebRequest → WebHostInstalls). Faked: only the installer itself (`startWebInstall` records what it was asked and what authority it was given).
 *   - the default stays lenient: an administrator's Install is applied at once (no second confirmation), from this computer and from the LAN;
 *   - an administrator who asked for their own code takes it for an Install off this computer — the digest the page showed, once, their own app's;
 *   - the public link, a guest and a read session are refused before anything is held; a request that did not come through the gate (a hand-built POST with a valid
 *     admin cookie) starts nothing; only `{ backend }` for a CLI that has an install is ever proposed;
 *   - the authority travels with the run: strict switched on between admission and execution leaves the change stale, and an asker that is no longer current when the
 *     installer would open refuses the start.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { handleWebRequest } from "../src/web-api.js";
import { authorizeSession, WEB_CSRF_HEADER } from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { bindGatewayRequest, gatewayRequestContext } from "../src/web-request-context.js";
import { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";
import { settingsFingerprint } from "../src/settings-transaction.js";

const TOKEN = "d".repeat(48);
const SECRET = base32Encode(Buffer.from("0123456789abcdefghij"));
const codeAt = (ms: number) => hotp(base32Decode(SECRET)!, totpStep(ms));
const roots: string[] = [], stores: SettingsConfirmationStore[] = [], fleets: any[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const a of fleets.splice(0)) { a.fm.stormWindow.shutdown(); a.fm.spawnGate.shutdown(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const WHERE = {
  lan: { remoteAddress: "192.0.2.20", host: "192.0.2.5:19280" },
  here: { remoteAddress: "127.0.0.1", host: "127.0.0.1:19280" },
} as const;

function harness(o: { enrolled?: boolean; strict?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-144-")); roots.push(dir);
  if (o.enrolled) writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0, ...(o.strict ? { strict: true } : {}) },
    outside: true, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  const fm = new FleetManager(dir), any = fm as any;
  fm.fleetConfig = { defaults: { backend: "codex" }, instances: { general: { working_directory: dir, general_topic: true } } } as any;
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  const store = new SettingsConfirmationStore({ audit: vi.fn() });
  stores.push(store); fleets.push({ fm });
  // The installer: what it was asked, and the asker's authority as it was handed over (a test may switch it).
  const starts: Array<{ backend: string; mode: string; current: () => boolean }> = [];
  let before: (() => Promise<void>) | null = null;
  vi.spyOn(fm, "startWebInstall").mockImplementation((async (backend: string, _reporter: unknown, execution: { current(): boolean } | undefined, mode: string = "install") => {
    if (before) await before();
    const current = () => !execution || execution.current();
    if (!current()) return { refused: "failed" };
    starts.push({ backend, mode, current }); return { started: true };
  }) as never);
  const session = (kind: "code" | "guest" | "read", where: keyof typeof WHERE, opts: { gateway?: boolean } = {}) => {
    const c = any.webSessions.create({ tier: kind === "code" ? "admin" : kind, surface: opts.gateway ? "gateway" : "local", label: "Firefox on Linux", tokenEpoch: tokenEpoch(TOKEN),
      ...(kind === "guest" ? { owner: { adapterId: "telegram", userId: "42" } } : {}), ...(opts.gateway ? { exposureId: "x" } : {}) });
    const w = WHERE[where];
    const req: any = { method: "POST", socket: { remoteAddress: w.remoteAddress },
      headers: { host: w.host, origin: `http://${w.host}`, "sec-fetch-site": "same-origin", cookie: `${opts.gateway ? "__Host-agend_session" : "agend_session"}=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
    if (opts.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: `http://${w.host}`, isCurrent: () => true, named: false } as any);
    return { req, gateway: !!opts.gateway, host: w.host, record: c.record as SessionRecord, id: c.sessionId as string };
  };
  // The real gate, its principal built as the fleet builds it; the real route behind it. Its second baseline look (at execution) can be held.
  let calls = 0, hold: Promise<void> | null = null;
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => {
      const auth = authorizeSession(req, any.webToken, any.webSessions, { touch: false });
      if (auth.kind !== "ok") return null;
      const record = auth.session, sessions = any.webSessions, exposure = gatewayRequestContext(req);
      return { id: record.idHash, label: record.label, source: exposure ? "public_link" : "web_session", requester: { handle: record.handle, label: record.label },
        localAdmin: () => record.tier === "admin" && record.surface === "local" && !exposure,
        current: () => sessions === any.webSessions && !!any.webToken && sessions.isCurrent(record, tokenEpoch(any.webToken)) && (!exposure || exposure.isCurrent()) };
    },
    baseline: async () => { const config = fm.fleetConfig; if (hold && ++calls > 1) await hold; return { config, classic: {}, fingerprint: settingsFingerprint(config) } as any; },
    snapshot: () => fm.fleetConfig,
    selfConfirm: (req, id) => any.settingsSelfConfirmation(store, req, id),
    totp: { state: (req, id) => any.settingsTotpState(store, req, id), confirm: (req, id, code, digest) => any.settingsTotpConfirm(store, req, id, code, digest) },
    remote: req => any.settingsPageIsRemote(req),
    directCreationPolicy: req => any.settingsDirectCreationAllowed(req),
    directHostInstall: true,
  });
  const next = (rq: any, rs: any, u: URL) => handleWebRequest(rq, rs, u, fm as any);
  const send = (s: { req: any; gateway?: boolean; host?: string }, method: string, path: string, body: unknown, through: "gate" | "route" = "gate") => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req: any = Object.assign(new EventEmitter(), s.req, { method, url: path, destroy: () => {} });
    req.headers = { ...s.req.headers, "idempotency-key": `k${Math.random()}`, "content-type": "application/json" };
    if (s.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: `http://${s.host}`, isCurrent: () => true, named: false } as any);
    let status = 0;
    const res: any = { destroyed: false, headersSent: false, once: () => {}, setHeader: () => {}, writeHead(code: number) { status = code; this.headersSent = true; }, end(v: string) { resolve({ status, body: JSON.parse(v) }); } };
    try {
      const url = new URL(path, "http://localhost");
      const handled = through === "gate" ? gate.handle(req, res, url, next) : next(req, res, url);
      expect(handled).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body))); req.emit("end"); });
    } catch (e) { reject(e); }
  });
  const install = (s: { req: any; gateway?: boolean; host?: string }, backend = "grok") => send(s, "POST", "/ui/host-install", { backend });
  const stateOf = (r: { body: any }, s: { record: SessionRecord }) => store.get(r.body.pending_change.id, s.record.idHash)?.state;
  const settle = () => new Promise(r => setTimeout(r, 30));
  return { fm, any, store, session, starts, install, send, stateOf, settle,
    beforeStart: (fn: (() => Promise<void>) | null) => { before = fn; },
    holdExecution: () => { calls = 0; let release!: () => void; hold = new Promise<void>(r => { release = r; }); return () => { hold = null; release(); }; } };
}

describe("the lenient default: an administrator's Install is applied at once, through the gate", () => {
  it.each(["here", "lan"] as const)("an admin session from %s: held and applied with no second confirmation; the installer was asked for that CLI and the run is the page's to read", async (where) => {
    const h = harness({ enrolled: true }), s = h.session("code", where);
    const r = await h.install(s);
    expect([r.status, r.body.result]).toEqual([202, "pending_confirmation"]);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.starts.map(x => x.backend)).toEqual(["grok"]);
    expect(h.fm.webHostInstalls.view()).toMatchObject({ backend: "grok", phase: "running", startedOn: "Firefox on Linux" });
    const view = h.store.get(r.body.pending_change.id, s.record.idHash)!;
    expect(view.summary.join(" ")).toContain("Install grok");
  });
  it("a second kind of CLI the registry installs goes the same way; what was proposed is only `{ backend }`", async () => {
    const h = harness(), s = h.session("code", "here");
    const r = await h.install(s, "codex");
    await vi.waitFor(() => expect(h.stateOf(r, s), JSON.stringify(h.store.get(r.body.pending_change.id, s.record.idHash)?.outcome)).toBe("applied"));
    expect(h.starts.map(x => x.backend)).toEqual(["codex"]);
  });
});

describe("an administrator who asked for their own code takes it for an Install off this computer", () => {
  it("held (pending, the code is offered with the digest); a wrong digest and a wrong code start nothing; the right one does, once", async () => {
    const h = harness({ enrolled: true, strict: true }), s = h.session("code", "lan");
    const r = await h.install(s);
    expect([r.status, r.body.pending_change.state, r.body.pending_change.totp]).toEqual([202, "pending", "ready"]);
    await h.settle();
    expect([h.starts.length, h.stateOf(r, s)]).toEqual([0, "pending"]);
    const path = `/api/settings/pending/${r.body.pending_change.id}/confirm-totp`;
    const wrongDigest = await h.send(s, "POST", path, { code: codeAt(Date.now()), digest: "0".repeat(64) });
    expect([wrongDigest.status, wrongDigest.body.error]).toEqual([409, "confirmation_changed"]);
    const wrongCode = await h.send(s, "POST", path, { code: "000000", digest: r.body.pending_change.confirm_digest });
    expect(wrongCode.status).toBe(401);
    await h.settle();
    expect([h.starts.length, h.stateOf(r, s)]).toEqual([0, "pending"]);
    const ok = await h.send(s, "POST", path, { code: codeAt(Date.now()), digest: r.body.pending_change.confirm_digest });
    expect(ok.status).toBe(202);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.starts.map(x => x.backend)).toEqual(["grok"]);
  });
  it("the same strict admin on this computer: applied at once (nothing is asked there)", async () => {
    const h = harness({ enrolled: true, strict: true }), s = h.session("code", "here");
    const r = await h.install(s);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.starts.length).toBe(1);
  });
  it("strict switched on after admission but before execution: the policy is asked again — stale, nothing is installed", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "lan");
    const release = h.holdExecution();
    const r = await h.install(s);                                                // admitted while the switch was off
    expect(r.status).toBe(202);
    h.any.webOutsideStrict(h.session("code", "here").req, true);                  // the admin turns it on from the computer
    release();
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("stale"));
    expect(h.starts.length).toBe(0);
  });
  it("the session revoked while the confirmed install waits to open (the authority handed to the installer goes false): nothing opens, the run is refused", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "here");
    h.beforeStart(async () => { h.any.webSessions.revoke?.(s.record.handle) ?? h.any.webSessions.revokeAll?.(); });
    const r = await h.install(s);
    await vi.waitFor(() => expect(["failed", "stale"]).toContain(h.stateOf(r, s)));
    expect(h.starts.length).toBe(0);
    expect(h.fm.webHostInstalls.view()).toBeNull();
  });
});

describe("who may not, and what never becomes a held change", () => {
  it("the public link: refused before anything is proposed", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "here", { gateway: true });
    const r = await h.install(s);
    expect([r.status, r.body.error]).toEqual([403, "install_not_over_public_link"]);
    expect(h.store.list(s.record.idHash)).toEqual([]);
    expect(h.starts.length).toBe(0);
  });
  it.each(["guest", "read"] as const)("a %s session: refused, and no change is held for another administrator to confirm", async (kind) => {
    const h = harness({ enrolled: true }), s = h.session(kind, "here");
    const r = await h.install(s);
    expect([r.status, r.body.error]).toEqual([403, "install_needs_a_local_admin"]);
    expect(h.store.list(s.record.idHash)).toEqual([]);
    expect(h.starts.length).toBe(0);
  });
  it("a request that did not come through the gate — a hand-built POST carrying a valid admin cookie — starts nothing", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "here");
    const r = await h.send(s, "POST", "/ui/host-install", { backend: "grok" }, "route");
    expect([r.status, r.body.error]).toEqual([403, "install_confirmation_required"]);
    expect(h.starts.length).toBe(0);
  });
  it.each([
    ["an extra key", { backend: "grok", command: "rm -rf /" }, "install_args"],
    ["no backend", {}, "install_args"],
    ["a backend that is not a registry id", { backend: "Grok; ls" }, "install_args"],
  ] as const)("%s: refused before it is proposed", async (_name, body, error) => {
    const h = harness({ enrolled: true }), s = h.session("code", "here");
    const r = await h.send(s, "POST", "/ui/host-install", body);
    expect([r.status, r.body.error]).toEqual([400, error]);
    expect(h.store.list(s.record.idHash)).toEqual([]);
    expect(h.starts.length).toBe(0);
  });
});

describe("Update takes the same path (the audited release is the server's, shown in the held change)", () => {
  // AGEND-154: `acknowledged` — the page that knows the named exception says so in the request (`acceptLatestUnaudited`).
  const update = (h: ReturnType<typeof harness>, s: { req: any; gateway?: boolean; host?: string }, backend = "grok", acknowledged = backend === "antigravity") => h.send(s, "POST", "/ui/host-update", acknowledged ? { backend, acceptLatestUnaudited: true } : { backend });
  it("an admin: applied at once in update mode; the held change names the audited release; the page's body carried only the CLI's id", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "lan");
    const r = await update(h, s);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.starts.map(x => [x.backend, x.mode])).toEqual([["grok", "update"]]);
    const view = h.store.get(r.body.pending_change.id, s.record.idHash)!;
    expect(view.summary.join(" ")).toMatch(/Update grok .* to \d+\.\d+\.\d+/);
  });
  it("a strict admin off this computer takes their own digest-bound code; nothing starts before it, the right code starts one update", async () => {
    const h = harness({ enrolled: true, strict: true }), s = h.session("code", "lan");
    const r = await update(h, s);
    expect([r.body.pending_change.state, r.body.pending_change.totp]).toEqual(["pending", "ready"]);
    await h.settle();
    expect(h.starts.length).toBe(0);
    const ok = await h.send(s, "POST", `/api/settings/pending/${r.body.pending_change.id}/confirm-totp`, { code: codeAt(Date.now()), digest: r.body.pending_change.confirm_digest });
    expect(ok.status).toBe(202);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.starts.map(x => x.mode)).toEqual(["update"]);
  });
  // AGEND-153: the named exception takes the very same path — held change, the asker's own code, no public link, no guest — and its held change says LATEST and "not audited".
  it("AGEND-153 Antigravity (the named exception): an admin's update is held and applied like any other, and the held change says it goes to the LATEST release, not audited", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "lan");
    const r = await update(h, s, "antigravity");
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.starts.map(x => [x.backend, x.mode])).toEqual([["antigravity", "update"]]);
    const text = h.store.get(r.body.pending_change.id, s.record.idHash)!.summary.join(" ");
    expect(text).toMatch(/Update antigravity .*LATEST release \(not audited by AgEnD\)/);
    expect(text).not.toMatch(/to \d+\.\d+\.\d+/);
  });
  it("AGEND-154 fail-first: an older page's `{ backend: \"antigravity\" }` (the button it labels 'Update to 1.5.3') is refused 409 latest_ack_required BEFORE it is proposed — nothing is held, nothing starts; a pinned CLI that claims the exception is refused too", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "lan");
    const old = await update(h, s, "antigravity", false);
    expect([old.status, old.body.error]).toEqual([409, "latest_ack_required"]);
    const claimed = await update(h, s, "grok", true);
    expect([claimed.status, claimed.body.error]).toEqual([409, "latest_ack_mismatch"]);
    await h.settle();
    expect(h.store.list(s.record.idHash)).toEqual([]);
    expect(h.starts.length).toBe(0);
  });
  it("AGEND-153 Antigravity: a strict admin takes their own digest-bound code first; the public link, a guest and a hand-built POST start nothing", async () => {
    const strict = harness({ enrolled: true, strict: true }), s = strict.session("code", "lan");
    const r = await update(strict, s, "antigravity");
    expect([r.body.pending_change.state, r.body.pending_change.totp]).toEqual(["pending", "ready"]);
    await strict.settle();
    expect(strict.starts.length).toBe(0);
    const ok = await strict.send(s, "POST", `/api/settings/pending/${r.body.pending_change.id}/confirm-totp`, { code: codeAt(Date.now()), digest: r.body.pending_change.confirm_digest });
    expect(ok.status).toBe(202);
    await vi.waitFor(() => expect(strict.stateOf(r, s)).toBe("applied"));
    expect(strict.starts.map(x => [x.backend, x.mode])).toEqual([["antigravity", "update"]]);
    const h = harness({ enrolled: true });
    const link = h.session("code", "here", { gateway: true }), guest = h.session("guest", "here"), admin = h.session("code", "here");
    expect((await update(h, link, "antigravity")).body.error).toBe("install_not_over_public_link");
    expect((await update(h, guest, "antigravity")).body.error).toBe("install_needs_a_local_admin");
    expect((await h.send(admin, "POST", "/ui/host-update", { backend: "antigravity" }, "route")).body.error).toBe("install_confirmation_required");
    expect(h.store.list(admin.record.idHash)).toEqual([]);
    expect(h.starts.length).toBe(0);
  });
  it("the public link, a guest and a hand-built POST start nothing; a CLI with no update is refused before it is proposed", async () => {
    const h = harness({ enrolled: true });
    const link = h.session("code", "here", { gateway: true }), guest = h.session("guest", "here"), admin = h.session("code", "here");
    expect((await update(h, link)).body.error).toBe("install_not_over_public_link");
    expect((await update(h, guest)).body.error).toBe("install_needs_a_local_admin");
    expect((await h.send(admin, "POST", "/ui/host-update", { backend: "grok" }, "route")).body.error).toBe("install_confirmation_required");
    const none = await update(h, admin, "muse");
    expect([none.status, none.body.error]).toEqual([400, "unsupported"]);
    expect(h.store.list(admin.record.idHash)).toEqual([]);
    expect(h.starts.length).toBe(0);
  });
});

