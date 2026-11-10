/**
 * AGEND-148 (Prism R3 on #3539, P2-1): installing — and so Updating — an AI CLI on a paired Windows computer (`POST /ui/runtimes/machines/:id/cli-install`) is a held change of the
 * Settings gate, like the same operation on the AgEnD computer (AGEND-144). The Runtime's Update button reuses this route, and Install had inherited the omission: an administrator with
 * authenticator enforcement on got 202 and one `cli.install` with no pending change and no code. Real here: FleetManager's session store and settings policy (the admin's own
 * authenticator and "ask for my code" switch), the real SettingsHttpConfirmation with its principal built as the fleet builds it, and the real Runtime handler behind it
 * (handleWebRequest → handleRuntimeRequest). Faked: only the paired computer (`hub.callAccount` records `cli.install`, and its answer is that computer's owner's own switch).
 *   - the lenient default is unchanged: an administrator's request is applied at once, from this computer and from the LAN;
 *   - an administrator who asked for their own code takes it off this computer: nothing is sent to the computer before the digest-bound code, and the right one sends exactly one;
 *   - the PC owner's consent stays the computer's own: a confirmed request that the computer refuses (its switch is off) fails with that reason — the gate neither replaces nor bypasses it;
 *   - the public link, a guest and a read session are refused before anything is held, and a request that did not come through the gate (a hand-built POST with a valid cookie) sends nothing.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { handleWebRequest } from "../src/web-api.js";
import { authorizeSession, WEB_CSRF_HEADER } from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { bindGatewayRequest, gatewayRequestContext } from "../src/web-request-context.js";
import { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";
import { settingsFingerprint } from "../src/settings-transaction.js";

const TOKEN = "e".repeat(48), MACHINE = "12345678-1234-4321-abcd-123456789012";
const INSTALL = `/ui/runtimes/machines/${MACHINE}/cli-install`;
const SECRET = base32Encode(Buffer.from("0123456789abcdefghij"));
const codeAt = (ms: number) => hotp(base32Decode(SECRET)!, totpStep(ms));
const roots: string[] = [], stores: SettingsConfirmationStore[] = [], fleets: any[] = [];
beforeEach(() => { vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); });
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const a of fleets.splice(0)) { a.fm.stormWindow.shutdown(); a.fm.spawnGate.shutdown(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

const WHERE = {
  lan: { remoteAddress: "192.0.2.20", host: "192.0.2.5:19280" },
  here: { remoteAddress: "127.0.0.1", host: "127.0.0.1:19280" },
} as const;

function harness(o: { enrolled?: boolean; strict?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-148-")); roots.push(dir);
  if (o.enrolled) writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0, ...(o.strict ? { strict: true } : {}) },
    outside: true, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  const fm = new FleetManager(dir), any = fm as any;
  fm.fleetConfig = { defaults: { backend: "codex" }, instances: { general: { working_directory: dir, general_topic: true } } } as any;
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  const store = new SettingsConfirmationStore({ audit: vi.fn() });
  stores.push(store); fleets.push({ fm });
  // The paired computer, as the Runtime handler sees it: what `cli.install` was asked and with whom as the actor; its answer is that computer's owner's own switch.
  const calls: Array<{ operation: string; payload: any }> = [];
  let answer: () => Promise<unknown> = async () => ({ version: "0.167.0" });
  // AGEND-153: what the computer already has (its last inventory) — the route sends `cli.update` for the named exception's CLI when it is there.
  let inventory: unknown;
  const hub = {
    machine: (id: string) => id === MACHINE ? { id, status: "online", runtimeInfo: { capabilities: ["exec", "remote-signin", "cli-install", "cli-update"] }, ...(inventory ? { inventory } : {}) } : undefined,
    callAccount: async (_id: string, operation: string, payload: any) => { calls.push({ operation, payload }); return answer(); },
    listMachines: () => [], diagnosticTasks: () => [],
  };
  vi.spyOn(fm, "runtimeCoordinator").mockReturnValue(hub as never);
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
  let looks = 0, hold: Promise<void> | null = null;
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => {
      const auth = authorizeSession(req, any.webToken, any.webSessions, { touch: false });
      if (auth.kind !== "ok") return null;
      const record = auth.session, sessions = any.webSessions, exposure = gatewayRequestContext(req);
      return { id: record.idHash, label: record.label, source: exposure ? "public_link" : "web_session", requester: { handle: record.handle, label: record.label },
        localAdmin: () => record.tier === "admin" && record.surface === "local" && !exposure,
        current: () => sessions === any.webSessions && !!any.webToken && sessions.isCurrent(record, tokenEpoch(any.webToken)) && (!exposure || exposure.isCurrent()) };
    },
    baseline: async () => { const config = fm.fleetConfig; if (hold && ++looks > 1) await hold; return { config, classic: {}, fingerprint: settingsFingerprint(config) } as any; },
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
  // AGEND-154: `latest` — the page that knows the named exception says so in the request (`acceptLatestUnaudited`).
  const install = (s: { req: any; gateway?: boolean; host?: string }, cli = "codex", latest = false) => send(s, "POST", INSTALL, latest ? { cli, acceptLatestUnaudited: true } : { cli });
  const stateOf = (r: { body: any }, s: { record: SessionRecord }) => store.get(r.body.pending_change.id, s.record.idHash)?.state;
  const settle = () => new Promise(r => setTimeout(r, 30));
  const installs = () => calls.filter(c => c.operation === "cli.install");
  const updates = () => calls.filter(c => c.operation === "cli.update");
  return { fm, any, store, session, calls, installs, updates, install, send, stateOf, settle, has: (id: string, version: string) => { inventory = { home: "C:\\D", clis: [{ id, path: `C:\\tools\\${id}.exe`, version }] }; },
    answerWith: (fn: () => Promise<unknown>) => { answer = fn; },
    holdExecution: () => { looks = 0; let release!: () => void; hold = new Promise<void>(r => { release = r; }); return () => { hold = null; release(); }; } };
}

describe("the lenient default: an administrator's request is applied at once, through the gate", () => {
  it.each(["here", "lan"] as const)("an admin session from %s: held and applied with no second confirmation; the computer is asked once, with the opaque admin name", async (where) => {
    const h = harness({ enrolled: true }), s = h.session("code", where);
    const r = await h.install(s);
    expect([r.status, r.body.result]).toEqual([202, "pending_confirmation"]);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.installs()).toHaveLength(1);
    expect(h.installs()[0]!.payload).toEqual({ cli: "codex", actor: expect.stringMatching(/^admin:[a-f0-9]{16}$/) });
    expect(h.store.get(r.body.pending_change.id, s.record.idHash)!.summary.join(" ")).toMatch(/Install codex 0\.\d+\.\d+ on the paired Windows computer/);
  });
});

// AGEND-153: the named exception on a computer takes the very same gate: held, the asker's own code when they asked for it, and only then one `cli.update` to the computer; the held change says LATEST and "not audited".
describe("AGEND-153: Antigravity's update to the vendor's latest goes through the same gate", () => {
  it("the held change says it goes to the LATEST release, not audited — alongside the pinned install it would be on a computer without it", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "lan");
    h.has("antigravity", "1.5.3");
    const r = await h.install(s, "antigravity", true);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    const text = h.store.get(r.body.pending_change.id, s.record.idHash)!.summary.join(" ");
    expect(text).toMatch(/Install antigravity 1\.5\.3 on the paired Windows computer/);
    expect(text).toMatch(/If antigravity is already on the paired Windows computer .*updates it to the vendor's LATEST release \(not audited by AgEnD\)/);
    // a CLI whose update is the pinned install carries no such sentence
    const other = await h.install(s, "codex");
    await vi.waitFor(() => expect(h.stateOf(other, s)).toBe("applied"));
    expect(h.store.get(other.body.pending_change.id, s.record.idHash)!.summary.join(" ")).not.toMatch(/LATEST/);
  });
  it("a strict admin off this computer: nothing is sent until their own digest-bound code; then exactly one `cli.update` with the CLI id and the opaque admin name", async () => {
    const h = harness({ enrolled: true, strict: true }), s = h.session("code", "lan");
    h.has("antigravity", "1.5.3");
    const r = await h.install(s, "antigravity", true);
    expect([r.status, r.body.pending_change.state, r.body.pending_change.totp]).toEqual([202, "pending", "ready"]);
    await h.settle();
    expect([h.calls.filter(c => c.operation.startsWith("cli.")).length, h.stateOf(r, s)]).toEqual([0, "pending"]);
    const ok = await h.send(s, "POST", `/api/settings/pending/${r.body.pending_change.id}/confirm-totp`, { code: codeAt(Date.now()), digest: r.body.pending_change.confirm_digest });
    expect(ok.status).toBe(202);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.installs()).toHaveLength(0);
    expect(h.updates()).toHaveLength(1);
    expect(h.updates()[0]!.payload).toEqual({ cli: "antigravity", actor: expect.stringMatching(/^admin:[a-f0-9]{16}$/) });
  });
  // AGEND-154 (Prism P2-1 on #3552): the older page module sends `{ cli }` for this very button. It is held like any install (the held change cannot tell an install from an update — only the route can see
  // the computer's inventory), but when it is confirmed the route refuses it: it is never run as the latest exception, and the one-shot admission is not spent.
  it("AGEND-154 fail-first: an older page's `{ cli }` for an Antigravity the computer already has is not run as the latest exception — nothing is sent to the computer; the same click from the current page (`acceptLatestUnaudited`) is", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "lan");
    h.has("antigravity", "1.5.3");
    const old = await h.install(s, "antigravity");
    await h.settle();
    expect(h.calls.filter(c => c.operation.startsWith("cli."))).toEqual([]);
    expect(h.stateOf(old, s)).toBe("failed");
    const current = await h.install(s, "antigravity", true);
    await vi.waitFor(() => expect(h.stateOf(current, s)).toBe("applied"));
    expect(h.updates()).toHaveLength(1);
    expect(h.installs()).toHaveLength(0);
  });
  it("the public link and a guest start nothing; a hand-built POST is refused", async () => {
    const h = harness({ enrolled: true });
    h.has("antigravity", "1.5.3");
    expect((await h.install(h.session("code", "here", { gateway: true }), "antigravity")).body.error).toBeTruthy();
    expect((await h.install(h.session("guest", "here"), "antigravity")).body.error).toBeTruthy();
    expect((await h.send(h.session("code", "here"), "POST", INSTALL, { cli: "antigravity" }, "route")).body.error).toBe("install_confirmation_required");
    await h.settle();
    expect(h.calls.filter(c => c.operation.startsWith("cli."))).toEqual([]);
  });
});

describe("an administrator who asked for their own code takes it before anything is sent to the computer", () => {
  it("LAN, strict: held (the code is offered with the digest); a wrong digest and a wrong code send nothing; the right one sends exactly one", async () => {
    const h = harness({ enrolled: true, strict: true }), s = h.session("code", "lan");
    const r = await h.install(s);
    expect([r.status, r.body.pending_change.state, r.body.pending_change.totp]).toEqual([202, "pending", "ready"]);
    await h.settle();
    expect([h.installs().length, h.stateOf(r, s)]).toEqual([0, "pending"]);
    const path = `/api/settings/pending/${r.body.pending_change.id}/confirm-totp`;
    const wrongDigest = await h.send(s, "POST", path, { code: codeAt(Date.now()), digest: "0".repeat(64) });
    expect([wrongDigest.status, wrongDigest.body.error]).toEqual([409, "confirmation_changed"]);
    expect((await h.send(s, "POST", path, { code: "000000", digest: r.body.pending_change.confirm_digest })).status).toBe(401);
    await h.settle();
    expect([h.installs().length, h.stateOf(r, s)]).toEqual([0, "pending"]);
    const ok = await h.send(s, "POST", path, { code: codeAt(Date.now()), digest: r.body.pending_change.confirm_digest });
    expect(ok.status).toBe(202);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.installs()).toHaveLength(1);
    expect(h.installs()[0]!.payload.cli).toBe("codex");
  });
  it("the same strict admin on this computer: applied at once (nothing is asked there)", async () => {
    const h = harness({ enrolled: true, strict: true }), s = h.session("code", "here");
    const r = await h.install(s);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("applied"));
    expect(h.installs()).toHaveLength(1);
  });
  it("strict switched on after admission but before execution: the policy is asked again — stale, nothing is sent", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "lan");
    const release = h.holdExecution();
    const r = await h.install(s);                                                // admitted while the switch was off
    expect(r.status).toBe(202);
    h.any.webOutsideStrict(h.session("code", "here").req, true);                  // the admin turns it on from the computer
    release();
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("stale"));
    expect(h.installs()).toHaveLength(0);
  });
});

describe("the PC owner's consent is the computer's own and stays separate", () => {
  it("a confirmed request that the computer refuses (its install switch is off) fails with the computer's own sentence; the gate did not replace that check", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "here");
    h.answerWith(async () => { throw new Error("The owner of that computer has not turned on installing CLIs"); });
    const r = await h.install(s);
    await vi.waitFor(() => expect(h.stateOf(r, s)).toBe("failed"));
    expect(JSON.stringify(h.store.get(r.body.pending_change.id, s.record.idHash)!.outcome)).toContain("has not turned on installing CLIs");
    expect(h.installs()).toHaveLength(1);                                         // it WAS asked: the computer's switch decided
  });
});

describe("who may not, and what never becomes a held change", () => {
  it("the public link: refused before anything is proposed", async () => {
    const h = harness({ enrolled: true }), s = h.session("code", "here", { gateway: true });
    const r = await h.install(s);
    expect([r.status, r.body.error]).toEqual([403, "install_not_over_public_link"]);
    expect(h.store.list(s.record.idHash)).toEqual([]);
    expect(h.calls).toEqual([]);
  });
  it.each(["guest", "read"] as const)("a %s session: refused, and no change is held for another administrator to confirm", async (kind) => {
    const h = harness({ enrolled: true }), s = h.session(kind, "here");
    const r = await h.install(s);
    expect([r.status, r.body.error]).toEqual([403, "install_needs_a_local_admin"]);
    expect(h.store.list(s.record.idHash)).toEqual([]);
    expect(h.calls).toEqual([]);
  });
  it("a request that did not come through the gate — a hand-built POST carrying a valid admin cookie — sends nothing", async () => {
    const h = harness({ enrolled: true, strict: true }), s = h.session("code", "lan");
    const r = await h.send(s, "POST", INSTALL, { cli: "codex" }, "route");
    expect([r.status, r.body.error]).toEqual([403, "install_confirmation_required"]);
    expect(h.calls).toEqual([]);
  });
  it.each([
    ["an extra key", { cli: "codex", version: "9.9.9" }, "install_args"],
    ["no cli", {}, "install_args"],
    ["a CLI the Runtime does not install", { cli: "grok" }, "unsupported"],
    ["a CLI that is not an id", { cli: "codex@9; ls" }, "unsupported"],
  ] as const)("%s: refused before it is proposed", async (_name, body, error) => {
    const h = harness({ enrolled: true }), s = h.session("code", "here");
    const r = await h.send(s, "POST", INSTALL, body);
    expect([r.status, r.body.error]).toEqual([400, error]);
    expect(h.store.list(s.record.idHash)).toEqual([]);
    expect(h.calls).toEqual([]);
  });
  it("what is not an install is unchanged: the computer's switches are read directly, with no held change", async () => {
    const h = harness({ enrolled: true, strict: true }), s = h.session("code", "lan");
    h.answerWith(async () => ({ accounts: { on: false }, install: { on: true } }));
    const r = await h.send(s, "GET", `/ui/runtimes/machines/${MACHINE}/remote-setup`, {}, "route");
    expect(r.status).toBe(200);
    expect(h.store.list(s.record.idHash)).toEqual([]);
  });
});
