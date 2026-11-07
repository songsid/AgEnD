/**
 * D3 (decision bcbb541f, M-2623): with no authenticator and no General to take a card, a held Settings change waited for
 * `agend settings confirm <id>` on the host. The host operator's own session — its code issued to `agend web` on this
 * computer (`/auth/issue-code` answers only loopback since #3345), used from this computer now — carries that same trust:
 * it confirms the change at Save, with no click added. Never bare loopback (a session from any other code is not one);
 * never forwarded, a public Host or a gateway; a change a General can take keeps its card (D1).
 *   - chat fleet, no General can take it: the host's session confirms (this file);
 *   - web-only fleet: the host operator already confirms its own changes (#2910); the ones that open a link or go out to
 *     a Hub (noSelfConfirm) are web-claude's B2b, on the same helper.
 * The provenance is one helper (hostSessionHere), shared with B2b.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

// The helper's own table is B2b's (tests/settings-totp-confirm-b2b.test.ts, "hostSessionHere …").

// ── A real fleet: its web server, sign-in over HTTP ──
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
const CHAT = { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } };
async function startFleet(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-d3-")); dirs.push(dir);
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true } }, ...config } as never;
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (any.healthServer as Server).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
  const stop = () => new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); });
  /** The launch link's own code (`agend web`), or another code; signed in from where `extra` says. */
  const signIn = async (code?: string, extra: Record<string, string> = {}) => {
    code ??= JSON.parse((await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).body).code as string;
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin, ...extra }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    const set = res.headers["set-cookie"]; const sessionId = (Array.isArray(set) ? set[0] : set)!.split(";")[0]!.split("=")[1]!;
    return { sessionId, record: any.webSessions.authenticate(sessionId, tokenEpoch(token), { touch: false }) as SessionRecord };
  };
  const reqOf = (sessionId: string, extra: Record<string, string> = {}) => ({ method: "PUT", socket: { remoteAddress: "127.0.0.1" },
    headers: { host: `127.0.0.1:${port}`, origin, "sec-fetch-site": "same-origin", cookie: `agend_session=${sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(sessionId), ...extra } });
  return { fm, any, stop, signIn, reqOf };
}
type Fleet = Awaited<ReturnType<typeof startFleet>>;
/** A held change (connecting a Telegram bot — it needs confirming) with an apply that only records it ran. */
function held(h: Fleet, opts: { noSelfConfirm?: true } = {}) {
  const store = new SettingsConfirmationStore({ audit: vi.fn(), notify: vi.fn() }); stores.push(store);
  const effect = prepareSettingsEffect("PUT", "/api/settings/fleet/channels", [{ ...CHAT.channel, id: "tg" }], { config: h.fm.fleetConfig, classic: {} });
  const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
  const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
    fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
    ...opts, current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
  return { store, view, apply };
}

describe("D3 on a chat fleet: a change no General can take is confirmed by the host's own session here", () => {
  it("the launch-link session on this computer confirms it — labelled this computer's admin, applied once, no card", async () => {
    setLocale("en");
    const h = await startFleet(CHAT);
    try {
      const s = await h.signIn();
      const a = held(h);
      const self = h.any.settingsSelfConfirmation(a.store, h.reqOf(s.sessionId), a.view.id);
      expect([self?.label, self?.current()]).toEqual(["This computer's admin", true]);
      const done = await a.store.decide(a.view.id, "confirm", { ...self, via: "web" });
      expect([done.state, done.outcome?.decided_by_label, a.apply.mock.calls.length]).toEqual(["applied", "This computer's admin", 1]);
    } finally { await h.stop(); }
  }, 20_000);
  it("never bare loopback, never from elsewhere: another code's session, a forwarded request, a public Host or a gateway get nothing", async () => {
    const h = await startFleet(CHAT);
    try {
      const host = await h.signIn();
      const chatCode = await h.signIn(h.fm.issueDashboardLogin()!.display);            // a code sent by chat, used here
      const a = held(h);
      const ask = (sessionId: string, extra: Record<string, string> = {}) => h.any.settingsSelfConfirmation(a.store, h.reqOf(sessionId, extra), a.view.id);
      expect([chatCode.record.host, ask(chatCode.sessionId)]).toEqual([undefined, null]);
      expect(ask(host.sessionId, { "x-forwarded-for": "198.51.100.7" })).toBeNull();
      expect(ask(host.sessionId, { host: "agend.example.test" })).toBeNull();
      const gw = h.reqOf(host.sessionId);
      bindGatewayRequest(gw, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://abc.trycloudflare.com", isCurrent: () => true });
      expect(h.any.settingsSelfConfirmation(a.store, gw, a.view.id)).toBeNull();
      expect(a.apply).not.toHaveBeenCalled();
      // A change that opens a link (#2453 noSelfConfirm) is not widened by D3: it still waits (residual, for the leader).
      const link = held(h, { noSelfConfirm: true });
      expect(h.any.settingsSelfConfirmation(link.store, h.reqOf(host.sessionId), link.view.id)).toBeNull();
    } finally { await h.stop(); }
  }, 20_000);
  it("a change a General can take keeps its card (D1); asked again when it is confirmed: a General come up, or the session signed out, refuses it", async () => {
    const h = await startFleet(CHAT);
    try {
      const s = await h.signIn();
      const card = vi.spyOn(h.any, "settingsCardPossible").mockReturnValue(true);
      const a = held(h);
      expect(h.any.settingsSelfConfirmation(a.store, h.reqOf(s.sessionId), a.view.id)).toBeNull();
      card.mockReturnValue(false);
      const b = held(h);
      const self = h.any.settingsSelfConfirmation(b.store, h.reqOf(s.sessionId), b.view.id);
      expect(self?.current()).toBe(true);
      card.mockReturnValue(true);                                                      // a General came up before it ran
      await expect(b.store.decide(b.view.id, "confirm", { ...self, via: "web" })).rejects.toMatchObject({ code: "admin_required" });
      card.mockReturnValue(false);
      const c = held(h);
      const again = h.any.settingsSelfConfirmation(c.store, h.reqOf(s.sessionId), c.view.id);
      h.any.webSessions.revokeByHandle(s.record.handle);                                 // signed out before it ran
      await expect(c.store.decide(c.view.id, "confirm", { ...again, via: "web" })).rejects.toMatchObject({ code: "admin_required" });
      expect([b.store.inspect(b.view.id)?.state, c.store.inspect(c.view.id)?.state, b.apply.mock.calls.length, c.apply.mock.calls.length]).toEqual(["pending", "pending", 0, 0]);
    } finally { await h.stop(); }
  }, 20_000);
});
