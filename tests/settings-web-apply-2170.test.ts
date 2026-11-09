/**
 * #2170 / AGEND-122 (upstream #3486, R1): a signed-in human fleet admin's own Apply now confirms a held Settings change,
 * by the role of the live cookie session (settings-role.ts) — not by a per-browser proof. No DM authorization (#1939), no
 * chat card that could have been posted, no host session: from this computer, a LAN name or a link, for every class of change
 * (an opened link, the Hub's outward changes included). What stays, and what these tests prove:
 * - The gate: a self-confirmation is asked after the change is held; it claims the change (state applying,
 *   confirmation "web") before the chat prompt runs, so no card is posted; every confirmation check still runs at
 *   execution; a reused request (same key) is not confirmed again; with none, the change waits as before.
 * - The fleet: who qualifies (an admin cookie session whose account is an admin of the change's connections — authorized in a
 *   DM or not, a General's card possible or not, here or from another device or over an option-on link, and the host's own
 *   owner-less session), who does not (an account that is not an admin of the scope, a guest, a header token, the web
 *   authorization switch off, "Only this computer can authorize" off this computer, a link whose option is off, a local
 *   cookie replayed over a link, an ordinary owner-less admin session on a chat fleet, expired, another platform's account),
 *   a sign-out / expiry / token rotation / switch / demotion between Apply and execution (stale), General's notice (content and
 *   where it goes), and the Notice a change that opens a link makes when confirmed from another device.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { setLocale } from "../src/locale.js";
import { SettingsHttpConfirmation, type SettingsSelfConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const roots: string[] = [], stores: SettingsConfirmationStore[] = [], fleets: Array<{ fm: FleetManager; any: any }> = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const f of fleets.splice(0)) { for (const p of f.any.pendingNonceButtons.values()) clearTimeout(p.timer); f.fm.stormWindow.shutdown(); f.fm.spawnGate.shutdown(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── The gate, with the real Settings handler behind it ──
function gateHarness(self: (req: any, id: string) => SettingsSelfConfirmation | null) {
  const root = mkdtempSync(join(tmpdir(), "agend-2170-gate-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, instances: {}, channels: [{ id: "dc", type: "discord", mode: "topic", bot_token_env: "DISCORD_TOKEN", group_id: "100", access: { mode: "locked", allowed_users: ["1"] } }] };
  writeFileSync(path, yaml.dump(config));
  let revision = 0;
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); revision++; });
  const ctx = { fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => config, saveFleetConfig: save, lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() } } as unknown as SettingsApiContext;
  const notify = vi.fn();
  const store = new SettingsConfirmationStore({ audit: vi.fn(), notify }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => revision });
  const asked = vi.fn(self);
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => req.headers.cookie ? { id: req.headers.cookie === "other" ? "session-b" : "session-a", label: "browser", source: "web_session", current: () => true } : null,
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(), selfConfirm: asked,
  });
  async function request(body: unknown, key = "k1") {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new EventEmitter() as any;
      req.method = "PUT"; req.url = "/api/settings/fleet/channels"; req.headers = { "idempotency-key": key, cookie: "opaque" }; req.destroy = () => undefined;
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, ctx);
      try { gate.handle(req, res, new URL(req.url, "http://localhost"), next); queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); }
      catch (err) { reject(err); }
    });
  }
  const candidate = () => [{ ...config.channels[0], access: { mode: "locked", allowed_users: ["2"] } }];
  /** #2868: the pending routes (no body): a read, or "Apply now"; `cookie: false` — no session. */
  function call(method: string, url: string, o: { cookie?: boolean; other?: boolean } = {}) {
    return new Promise<{ status: number; body: any }>((resolve) => {
      const req = new EventEmitter() as any;
      req.method = method; req.url = url; req.headers = o.cookie === false ? {} : { cookie: o.other ? "other" : "opaque" }; req.destroy = () => undefined;
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      expect(gate.handle(req, res, new URL(url, "http://localhost"), () => false), `${method} ${url} is the gate's`).toBe(true);
    });
  }
  return { config, save, store, notify, asked, request, candidate, call };
}

describe("the gate: the request's own confirmation", () => {
  it("confirmed by the request itself: applying at once (confirmation web), applied exactly once, no chat prompt, the outcome heard", async () => {
    const done = vi.fn();
    const h = gateHarness(() => ({ label: "Ada", current: () => true, done }));
    const r = await h.request(h.candidate());
    expect([r.status, r.body.result, r.body.pending_change.state, r.body.pending_change.confirmation]).toEqual([202, "pending_confirmation", "applying", { kind: "web" }]);
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    const view = done.mock.calls[0]![0];
    expect([view.state, view.outcome.decided_by_label, h.config.channels[0].access.allowed_users, h.save.mock.calls.length]).toEqual(["applied", "Ada", ["2"], 1]);
    await tick();
    expect(h.notify.mock.calls.map((c) => c[0].state)).toEqual(["applying"]);   // the prompt's turn came after the claim: nothing to prompt
  });
  it("none: the change waits for a confirmation, as before", async () => {
    const h = gateHarness(() => null);
    const r = await h.request(h.candidate());
    expect([r.body.pending_change.state, r.body.pending_change.confirmation.kind, h.save.mock.calls.length]).toEqual(["pending", "posting", 0]);
    await tick();
    expect(h.notify.mock.calls.map((c) => c[0].state)).toEqual(["pending"]);
    // #2868: the notifier attached no General card: the host's command is then the way.
    expect(h.store.get(r.body.pending_change.id, "session-a")?.confirmation.kind ?? h.store.list("session-a")[0]?.confirmation.kind).toBe("host_cli");
  });
  it("execution still checks it: a confirmation no longer current when it runs leaves the change applied by nobody", async () => {
    let asks = 0;
    const done = vi.fn();
    const h = gateHarness(() => ({ label: "Ada", current: () => asks++ < 1, done }));      // current at Apply, not after
    await h.request(h.candidate());
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect([done.mock.calls[0]![0].state, h.save.mock.calls.length, h.config.channels[0].access.allowed_users]).toEqual(["stale", 0, ["1"]]);
  });
  it("not current at Apply: nothing claimed — the change waits for chat or the host, as before", async () => {
    const h = gateHarness(() => ({ label: "Ada", current: () => false }));
    const r = await h.request(h.candidate());
    await tick();
    expect([r.body.pending_change.state, h.store.get(r.body.pending_change.id, "session-a")!.state, h.save.mock.calls.length, h.notify.mock.calls.map((c) => c[0].state)])
      .toEqual(["pending", "pending", 0, ["pending"]]);
  });
  it("the same request again (its key): the held change it is, never confirmed a second time", async () => {
    const h = gateHarness(() => null);
    const first = await h.request(h.candidate(), "same");
    const again = await h.request(h.candidate(), "same");
    expect([again.body.pending_change.id, h.asked.mock.calls.length]).toEqual([first.body.pending_change.id, 1]);
  });
  it("…and two sent at once with that key (both past the replay check, the second joins the first at propose): asked once", async () => {
    const h = gateHarness(() => null);
    const [one, two] = await Promise.all([h.request(h.candidate(), "twin"), h.request(h.candidate(), "twin")]);
    expect([two.body.pending_change.id, h.asked.mock.calls.length]).toEqual([one.body.pending_change.id, 1]);
  });
});

// ── The fleet: who qualifies ──
const TOKEN = "c".repeat(48);
function fleet(platform: "telegram" | "discord" = "telegram", ids = ["a", "b"], types: Record<string, "telegram" | "discord"> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2170-fleet-")); roots.push(dir);
  const fm = new FleetManager(dir), any = fm as any;
  const channels = ids.map((id, i) => ({ id, type: types[id] ?? platform, mode: "topic", group_id: `-100${i + 1}`, access: { mode: "open", allowed_users: [`${id}-F`, "both-F"] } }));
  fm.fleetConfig = { defaults: { backend: "codex" }, channels, web: { verified_authority: { enabled: true } },
    instances: Object.fromEntries(ids.map((id, i) => [`general_${id}`, { working_directory: dir, general_topic: true, channel_id: id, topic_id: i + 1 }])) } as any;
  const adapters = channels.map((channel) => Object.assign(new EventEmitter(), { id: channel.id, type: channel.type,
    notifyAlert: vi.fn(async (chatId: string, _a: unknown, o: any) => ({ chatId, messageId: `${channel.id}-prompt`, threadId: o?.threadId })),
    editMessageRemoveButtons: vi.fn(async () => {}), sendText: vi.fn(async (_chatId: string, _text: string, _opts?: unknown) => ({ chatId: channel.group_id, messageId: "notice" })) }));
  fm.adapter = adapters[0] as any;
  channels.forEach((channel, i) => {
    const adapter = adapters[i]!; fm.adapters.set(channel.id, adapter as any);
    fm.worlds.set(channel.id, { id: channel.id, adapter, groupId: channel.group_id, channelConfig: channel, accessManager: new AccessManager(channel.access as any, join(dir, `${channel.id}.json`)) } as any);
    any.daemons.set(`general_${channel.id}`, new EventEmitter()); any.adapterState.set(channel.id, { status: "connected", retryCount: 0 });
  });
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  const store: SettingsConfirmationStore = new SettingsConfirmationStore({ audit: vi.fn(), notify: (view) => (view.state === "pending" ? any.promptSettingsChange(store, view) : undefined) });
  stores.push(store); fleets.push({ fm, any });
  /** A browser session: its account (adapter, user) — DM-authorized (#1939) only when asked: the decision no longer reads it;
   *  `lan`: reached by a LAN name from another device, not on this computer; `host`: the session `agend web` minted on this
   *  computer (an admin with no account); a request carrying its cookie. */
  const session = (owner: { adapterId: string; userId: string } | null, opts: { authorize?: boolean; tier?: "admin" | "guest"; lan?: boolean; host?: boolean } = {}) => {
    const c = any.webSessions.create({ tier: opts.tier ?? "admin", surface: "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN), ...(owner ? { owner } : {}), ...(opts.host ? { host: true as const } : {}) });
    if (opts.authorize && owner) expect(any.authorizeWebSession(c.record, "loopback", false)).toMatchObject({ ok: true });
    const origin = opts.lan ? "192.168.1.20:19280" : "127.0.0.1:19280";
    const req = { method: "PUT", socket: { remoteAddress: opts.lan ? "192.168.1.20" : "127.0.0.1" }, headers: { host: origin, origin: `http://${origin}`, "sec-fetch-site": "same-origin",
      cookie: `agend_session=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
    return { req, record: c.record, id: c.sessionId };
  };
  /** The web token in a header, no cookie: the CLI's and a script's way in — never a session. */
  const headerToken = { method: "PUT", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19280", authorization: `Bearer ${TOKEN}` } };
  /** The Notice a remote confirmation posts (notifyFleetError), caught here instead of reaching a General. */
  const notices = () => vi.spyOn(any, "notifyFleetError").mockReturnValue(true);
  /** A held change on connection a's access (or one whose scope is unknown). */
  const propose = (opts: { unknown?: boolean; both?: boolean; primary?: boolean; unchanged?: () => Promise<boolean> } = {}) => {
    const body = channels.map((ch) => (ch.id === "a" || opts.both ? { ...ch, access: { ...ch.access, allowed_users: [...ch.access.allowed_users, "new-F"] } } : ch));
    const effect = prepareSettingsEffect("PUT", "/api/settings/fleet/channels", body, { config: fm.fleetConfig, classic: {} });
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections,
      authority: opts.unknown ? { connections: [], primaryGeneral: false, unknown: true } : opts.primary ? { connections: [], primaryGeneral: true, unknown: false } : effect.diff!.authority,
      current: () => true, unchanged: opts.unchanged ?? (async () => true), snapshot: () => null, apply }).view;
    return { view, apply };
  };
  return { fm, any, store, adapters, session, propose, headerToken, notices };
}

describe("#2453 / AGEND-122: turning a link option on is confirmed like any other change — its Apply now, announced when it is from another device", () => {
  /** A held web change (PUT /api/settings/fleet/web), as the gate proposes it: its one mark (opensLink) from the trusted effect. */
  function proposeWeb(f: ReturnType<typeof fleet>, verified_authority: Record<string, unknown>) {
    const effect = prepareSettingsEffect("PUT", "/api/settings/fleet/web", { verified_authority }, { config: f.fm.fleetConfig, classic: {} });
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    const view = f.store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
      ...(effect.diff!.opensLink ? { opensLink: true as const } : {}),
      current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
    return { view, apply, opensLink: effect.diff!.opensLink === true };
  }
  /** Apply now as the page does it: the self-confirmation, the store's decision, then General's / the Notice's `done`. */
  async function applyNow(f: ReturnType<typeof fleet>, req: any, id: string) {
    const self = f.any.settingsSelfConfirmation(f.store, req, id);
    const view = await f.store.decide(id, "confirm", { ...self, via: "web" });
    await self.done(view);
    return view;
  }
  // The link options: on `quick_link` the release default is on (#2819), so the option is first turned off for "opens it".
  const OPTIONS = [["named_link", "named link"], ["quick_link", "quick link"]] as const;
  const optionOff = (f: ReturnType<typeof fleet>, key: string) => { (f.fm.fleetConfig as any).web = { verified_authority: { [key]: false } }; };
  it.each(OPTIONS)("a signed-in admin on this computer turning the %s option on — alone or with other keys — gets Apply now: opensLink is its only mark, and on this computer no Notice", async (key) => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), notice = f.notices();
    optionOff(f, key);
    const alone = proposeWeb(f, { [key]: true }), mixed = proposeWeb(f, { [key]: true, loopback_only: true });
    expect([alone.opensLink, mixed.opensLink, f.store.opensLink(alone.view.id), f.store.opensLink(mixed.view.id)]).toEqual([true, true, true, true]);
    expect([f.any.settingsSelfConfirmation(f.store, s.req, alone.view.id)?.label, f.any.settingsSelfConfirmation(f.store, s.req, mixed.view.id)?.label]).toEqual([expect.stringMatching(/\(web-verified\)$/), expect.stringMatching(/\(web-verified\)$/)]);
    expect([(await applyNow(f, s.req, alone.view.id)).state, alone.apply.mock.calls.length, mixed.apply.mock.calls.length, notice.mock.calls.length]).toEqual(["applied", 1, 0, 0]);
  });
  it.each(OPTIONS)("…from another device (a LAN name) the same admin gets Apply now too, and the %s change is announced: one Notice, not throttled, naming who and the outcome", async (key) => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }, { lan: true }), notice = f.notices();
    optionOff(f, key);
    const p = proposeWeb(f, { [key]: true });
    expect([(await applyNow(f, s.req, p.view.id)).state, p.apply.mock.calls.length]).toEqual(["applied", 1]);
    expect(notice).toHaveBeenCalledOnce();
    expect(notice.mock.calls[0]).toEqual([expect.stringMatching(/^🔔 A Settings change that opens a public link was confirmed from another device by \S+\.\n.*\nOutcome: Change applied\.\nIf this was not you/s), { throttle: false }]);
    expect(f.adapters.every(a => a.sendText.mock.calls.length === 0), "the Notice is the one announcement (not General's \"confirmed from the web\" too)").toBe(true);
  });
  it("…who still must not: a guest, a header token, the web authorization switch off, \"Only this computer can authorize\" from another device, an admin of nothing here", () => {
    const f = fleet(), p = proposeWeb(f, { named_link: true }), ask = (req: any) => f.any.settingsSelfConfirmation(f.store, req, p.view.id);
    expect(ask(f.session({ adapterId: "a", userId: "a-F" }).req), "control: the same admin").not.toBeNull();
    expect([ask(f.session({ adapterId: "a", userId: "a-F" }, { tier: "guest" }).req), ask(f.headerToken),
      ask(f.session({ adapterId: "a", userId: "stranger" }).req)]).toEqual([null, null, null]);
    const lan = f.session({ adapterId: "a", userId: "a-F" }, { lan: true }).req;
    expect(ask(lan), "control: from another device").not.toBeNull();
    (f.fm.fleetConfig as any).web.verified_authority.loopback_only = true;
    expect([ask(lan), ask(f.session({ adapterId: "a", userId: "a-F" }).req) !== null]).toEqual([null, true]);   // this computer's own browser still may
    (f.fm.fleetConfig as any).web.verified_authority = { enabled: false };
    expect(ask(f.session({ adapterId: "a", userId: "a-F" }).req)).toBeNull();
  });
  /** A session over the public link (the named one, or the quick one), as the gateway binds it. */
  function overLink(f: ReturnType<typeof fleet>, key: "named_link" | "quick_link", on: boolean) {
    const named = key === "named_link", host = named ? "agend.example.com" : "abc-def.trycloudflare.com", X = "e".repeat(32);
    (f.fm.fleetConfig as any).web = { ...(named ? { public_link: { hostname: host } } : {}), verified_authority: { enabled: true, [key]: on } };
    const c = f.any.webSessions.create({ tier: "admin", surface: "gateway", exposureId: X, label: "phone", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: "a-F" } });
    const req = { method: "PUT", socket: { remoteAddress: "127.0.0.1" }, headers: { host, origin: `https://${host}`, "sec-fetch-site": "same-origin",
      cookie: `__Host-agend_session=${c.sessionId}; agend_session=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
    bindGatewayRequest(req, { surface: "gateway", ...(named ? { named: true } : {}), exposureId: X, expectedOrigin: `https://${host}`, isCurrent: () => true });
    return req;
  }
  it.each(OPTIONS)("a %s session over the public link (option on) is a role-ok admin there: Apply now — never DM-authorized — and its change that opens a link is announced", async (key) => {
    const f = fleet(), notice = f.notices(), req = overLink(f, key, true);
    expect(f.any.settingsRole(req).role, "control: not on this computer, an admin over its own link").toMatchObject({ ok: true, onHost: false, account: true });
    const other = key === "named_link" ? "quick_link" : "named_link", plain = f.propose();
    (f.fm.fleetConfig as any).web.verified_authority[other] = false;                              // the other option is what this change turns on
    const opens = proposeWeb(f, { [other]: true });
    expect([(await applyNow(f, req, plain.view.id)).state, notice.mock.calls.length]).toEqual(["applied", 0]);
    expect(f.store.opensLink(opens.view.id)).toBe(true);
    expect([(await applyNow(f, req, opens.view.id)).state, notice.mock.calls.length, notice.mock.calls[0]?.[1]]).toEqual(["applied", 1, { throttle: false }]);
  });
  it.each(OPTIONS)("…with the %s option off: none (link_off); the owner's switches hold over the link too", (key) => {
    const f = fleet(), req = overLink(f, key, false), p = f.propose();
    expect([f.any.settingsRole(req).role, f.any.settingsSelfConfirmation(f.store, req, p.view.id)]).toEqual([{ ok: false, reason: "link_off" }, null]);
    (f.fm.fleetConfig as any).web.verified_authority[key] = true;
    expect(f.any.settingsSelfConfirmation(f.store, req, p.view.id), "control: option on").not.toBeNull();
    (f.fm.fleetConfig as any).web.verified_authority.loopback_only = true;
    expect([f.any.settingsRole(req).role, f.any.settingsSelfConfirmation(f.store, req, p.view.id)]).toEqual([{ ok: false, reason: "loopback_only" }, null]);
    (f.fm.fleetConfig as any).web.verified_authority = { enabled: false, [key]: true };
    expect(f.any.settingsRole(req).role).toEqual({ ok: false, reason: "disabled" });
  });
  it("a request over the public link carrying a local cookie is never the self-confirming authority — named link or not (a session is bound to its surface)", () => {
    const f = fleet(), p = f.propose();
    for (const named of [true, false]) {
      const s = f.session({ adapterId: "a", userId: "a-F" });
      expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id), "control: on this computer").not.toBeNull();
      bindGatewayRequest(s.req, { surface: "gateway", named, exposureId: "e1", expectedOrigin: "https://agend.example.com", isCurrent: () => true });
      expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
    }
  });
});

describe("the fleet: who may confirm by applying", () => {
  it("web-verified, an admin of the change's connection: confirmed — applied, no chat card, General told on the other connection", async () => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), p = f.propose();
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    expect(self?.label).toMatch(/\(web-verified\)$/);
    const view = await f.store.decide(p.view.id, "confirm", { ...self, via: "web" });
    await self.done(view);
    await tick();
    expect([view.state, p.apply.mock.calls.length, f.any.pendingNonceButtons.size, f.adapters[0]!.notifyAlert.mock.calls.length + f.adapters[1]!.notifyAlert.mock.calls.length]).toEqual(["applied", 1, 0, 0]);
    const [chatId, text, opts] = f.adapters[1]!.sendText.mock.calls[0]!;
    expect([chatId, /^✅ Settings change confirmed from the web by .+ \(web-verified\)\nSource: web dashboard\nRequester: browser\n/.test(text), /Outcome: Change applied\.$/.test(text), opts]).toEqual(["-1002", true, true, { threadId: "2", allowedMentions: { parse: [] } }]);
    expect(f.adapters[0]!.sendText).not.toHaveBeenCalled();                                   // never on the connection the change affects
  });
  it("an admin of another connection only: none — the chat card, as before", () => {
    const f = fleet(), s = f.session({ adapterId: "b", userId: "b-F" }), p = f.propose();
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  it("the account's DM authorization of this browser (#1939) is not asked: authorized or not, an admin's Apply now is the same", async () => {
    const f = fleet(), p = f.propose(), plain = f.session({ adapterId: "a", userId: "a-F" }), authorized = f.session({ adapterId: "a", userId: "a-F" }, { authorize: true });
    expect([f.any.sessionAuthorizationStore()?.get(plain.record.handle) ?? null, f.any.sessionAuthorizationStore()?.get(authorized.record.handle)?.handle]).toEqual([null, authorized.record.handle]);   // control: one was, one never was
    const [one, two] = [plain, authorized].map(s => f.any.settingsSelfConfirmation(f.store, s.req, p.view.id));
    expect([one?.label, two?.label]).toEqual([expect.stringMatching(/\(web-verified\)$/), expect.stringMatching(/\(web-verified\)$/)]);
    expect([(await f.store.decide(p.view.id, "confirm", { ...one, via: "web" })).state, p.apply.mock.calls.length]).toEqual(["applied", 1]);
  });
  // #2390: the card fleet admins answer, in the fleet's language — the English "Confirm" users saw on 2.3.0-beta.22.
  it("zh-TW: the chat card's title, source and Confirm / Reject read in Chinese, and so does the outcome it is retired with", async () => {
    setLocale("zh-TW");
    try {
      const f = fleet(), p = f.propose();
      await tick(); await tick();
      const alert = f.adapters[1]!.notifyAlert.mock.calls[0]![1] as { message: string; choices: Array<{ label: string }> };
      expect(alert.message.split("\n").slice(0, 3)).toEqual(["🔒 設定變更等待 fleet 管理員確認", "來源：網頁儀表板", "提出者：browser"]);
      expect(alert.choices.map((c) => c.label)).toEqual(["確認", "拒絕"]);
      const view = await f.store.decide(p.view.id, "reject", { label: "admin", current: () => true });
      expect(view.outcome?.message).toBe("變更已被拒絕。");
    } finally { setLocale("en"); }
  });
  it("an admin of one of the change's two connections only: none", () => {
    const f = fleet(), p = f.propose({ both: true });
    expect(f.store.affectedConnections(p.view.id)).toEqual(["a", "b"]);
    expect(f.any.settingsSelfConfirmation(f.store, f.session({ adapterId: "a", userId: "a-F" }).req, p.view.id)).toBeNull();
  });
  // AGEND-122: a chat card that could have been posted is no longer a condition of Apply now; General's notice goes only where one could.
  it("no General a chat card could be posted in (the change's own, or one disconnected): still Apply now — the notice has nowhere to go, the change is applied", async () => {
    const f = fleet(), both = f.propose({ both: true }), bothAdmin = f.session({ adapterId: "a", userId: "both-F" });
    const view = await f.store.decide(both.view.id, "confirm", { ...f.any.settingsSelfConfirmation(f.store, bothAdmin.req, both.view.id), via: "web" });
    expect([view.state, both.apply.mock.calls.length, f.adapters.map(a => a.sendText.mock.calls.length)]).toEqual(["applied", 1, [0, 0]]);
    const g = fleet(), p = g.propose(), s = g.session({ adapterId: "a", userId: "a-F" });
    g.any.adapterState.set("b", { status: "disconnected", retryCount: 1 });
    const self = g.any.settingsSelfConfirmation(g.store, s.req, p.view.id);
    expect(self?.label).toMatch(/\(web-verified\)$/);
    await self.done(await g.store.decide(p.view.id, "confirm", { ...self, via: "web" }));
    expect([p.apply.mock.calls.length, g.adapters.map(a => a.sendText.mock.calls.length)]).toEqual([1, [0, 0]]);
  });
  it("no account: on a chat fleet only the host's own session (agend web) is the fleet's admin — \"This fleet's admin\", even from another device; any other owner-less session and a guest's: none", async () => {
    const f = fleet(), p = f.propose(), ask = (req: any) => f.any.settingsSelfConfirmation(f.store, req, p.view.id);
    expect([ask(f.session(null).req), ask(f.session(null, { lan: true }).req), ask(f.session({ adapterId: "a", userId: "a-F" }, { tier: "guest" }).req)]).toEqual([null, null, null]);
    const here = ask(f.session(null, { host: true }).req), away = ask(f.session(null, { host: true, lan: true }).req);
    expect([here?.label, away?.label]).toEqual(["This fleet's admin", "This fleet's admin"]);
    const view = await f.store.decide(p.view.id, "confirm", { ...here, via: "web" });
    await here.done(view);
    expect([view.state, p.apply.mock.calls.length, f.adapters.map(a => a.sendText.mock.calls.length)], "no account, no \"confirmed by …\" notice").toEqual(["applied", 1, [0, 0]]);
  });
  it("a whole-fleet change (primaryGeneral: the Hub, the connection list, sensitive fleet settings) needs the PRIMARY connection's admin too: a secondary connection's admin is refused at entry and at execution; the primary's passes", async () => {
    const f = fleet(), p = f.propose({ primary: true });
    const primary = f.session({ adapterId: "a", userId: "a-F" }), secondary = f.session({ adapterId: "b", userId: "b-F" }), both = f.session({ adapterId: "b", userId: "both-F" });
    expect(f.any.settingsPrimaryGeneral()).toMatchObject({ owner: "a" });
    expect(f.any.settingsSelfConfirmation(f.store, secondary.req, p.view.id), "a secondary connection's admin").toBeNull();
    expect(f.any.settingsSelfConfirmation(f.store, primary.req, p.view.id)?.label).toMatch(/\(web-verified\)$/);
    const self = f.any.settingsSelfConfirmation(f.store, both.req, p.view.id);          // an admin of both: qualifies…
    expect(self).not.toBeNull();
    f.fm.fleetConfig!.channels![0]!.access!.allowed_users = ["a-F"];
    expect(self!.current(), "…until it is no longer the primary connection's admin when the change runs").toBe(false);
  });
  it("a connection id configured twice (the account's own, or one the change touches) is never confirmed by a chat account", () => {
    const f = fleet("telegram", ["a", "a"]), p = f.propose({ both: true }), s = f.session({ adapterId: "a", userId: "a-F" });
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  it("signed in on another connection, an admin of the change's connection: qualifies (the account's own connection and the change's are both asked)", () => {
    const f = fleet(), p = f.propose(), s = f.session({ adapterId: "b", userId: "both-F" });
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).not.toBeNull();       // admin of a, from b: qualifies
    f.fm.fleetConfig!.channels![1]!.access!.allowed_users = ["b-F"];                         // …no longer an admin of its own connection b
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  it("General's model offline still allows a server-owned chat card and verified self-confirmation", () => {
    const f = fleet(), p = f.propose(), s = f.session({ adapterId: "a", userId: "a-F" });
    f.any.daemons.delete("general_b");
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).not.toBeNull();
  });
  it("the only connected General is on another platform: still Apply now — no card could go there and no notice does (a notice is posted on the change's own platform only)", async () => {
    const f = fleet("telegram", ["a", "b", "c"], { c: "discord" }), p = f.propose(), s = f.session({ adapterId: "a", userId: "a-F" });
    f.any.adapterState.set("b", { status: "disconnected", retryCount: 1 });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    expect(self?.label).toMatch(/\(web-verified\)$/);
    await self.done(await f.store.decide(p.view.id, "confirm", { ...self, via: "web" }));
    expect([p.apply.mock.calls.length, f.adapters.map(a => a.sendText.mock.calls.length)]).toEqual([1, [0, 0, 0]]);
  });
  it("two Generals a card could go to: the notice is posted once", async () => {
    const f = fleet("telegram", ["a", "b", "c"]), p = f.propose(), s = f.session({ adapterId: "a", userId: "a-F" });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    await self.done(await f.store.decide(p.view.id, "confirm", { ...self, via: "web" }));
    expect(f.adapters.map((a) => a.sendText.mock.calls.length)).toEqual([0, 1, 0]);
  });
  it("an unknown scope fails closed for a chat account — even an admin of its own connection (the classifier cannot say whom the change touches); a host session is judged by its own rule", () => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), p = f.propose({ unknown: true });
    expect(f.store.authorityOf(p.view.id)).toMatchObject({ unknown: true });
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id), "an admin of its own connection").toBeNull();
    expect(f.any.settingsSelfConfirmation(f.store, f.session({ adapterId: "b", userId: "a-F" }).req, p.view.id), "not an admin of its own connection").toBeNull();
    expect(f.any.settingsSelfConfirmation(f.store, f.session(null, { host: true }).req, p.view.id)?.label, "the host's own session").toBe("This fleet's admin");
  });
  it("over the public link: none (a public-link session is never web-verified)", () => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), p = f.propose();
    bindGatewayRequest(s.req, { surface: "public", exposureId: "e1", expectedOrigin: "https://x.example", isCurrent: () => true } as any);
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  // AGEND-122: the role is asked again at execution, on the same request's cookie. (Settings → Web → Revoke only withdraws the
  // DM authorizations of #1939 — what ends a session's say here is the session itself, the token, the switch, its account.)
  it.each([
    ["signed out (its session revoked)", (f: any, s: any) => f.any.webSessions.revokeById(s.id)],
    ["every browser signed out (/dashboard revoke)", (f: any) => f.any.revokeWebSessions()],
    ["the web token rotated", (f: any) => writeFileSync(join(f.any.dataDir, "web.token"), "d".repeat(48), { mode: 0o600 })],
    ["the web authorization switch turned off", (f: any) => { f.fm.fleetConfig.web.verified_authority.enabled = false; }],
    ["\"Only this computer can authorize\" turned on, for a browser on another device", (f: any) => { f.fm.fleetConfig.web.verified_authority.loopback_only = true; }, true],
  ] as Array<[string, (f: any, s: any) => void, boolean?]>)("its role asked again when it executes: %s after Apply — stale, nothing written", async (_n, end, lan) => {
    let release!: () => void;
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }, { lan: !!lan });
    const p = f.propose({ unchanged: () => new Promise<boolean>((r) => { release = () => r(true); }) });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    expect(self?.current(), "control: current at Apply").toBe(true);
    const decided = f.store.decide(p.view.id, "confirm", { ...self, via: "web" });
    end(f, s);
    release();
    const view = await decided;
    expect([self.current(), view.state, p.apply.mock.calls.length]).toEqual([false, "stale", 0]);
  });
  it("expired after Apply (max_session_hours past): stale, nothing written", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 19, 10, 0, 0) });
    let release!: () => void;
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" });
    const p = f.propose({ unchanged: () => new Promise<boolean>((r) => { release = () => r(true); }) });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    const decided = f.store.decide(p.view.id, "confirm", { ...self, via: "web" });
    vi.setSystemTime(Date.UTC(2026, 9, 21, 11, 0, 0));                                       // 49 h later: past the 48 h default
    release();
    expect([(await decided).state, self.current(), p.apply.mock.calls.length]).toEqual(["stale", false, 0]);
  });
  it("no longer the connection's admin when it executes: stale, nothing written", async () => {
    let release!: () => void;
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" });
    const p = f.propose({ unchanged: () => new Promise<boolean>((r) => { release = () => r(true); }) });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    const decided = f.store.decide(p.view.id, "confirm", { ...self, via: "web" });
    f.fm.fleetConfig!.channels![0]!.access!.allowed_users = ["someone-else"];
    release();
    expect([(await decided).state, p.apply.mock.calls.length]).toEqual(["stale", 0]);
  });
  it("verified on another connection, no longer the changed connection's admin when it executes: stale", async () => {
    let release!: () => void;
    const f = fleet(), s = f.session({ adapterId: "b", userId: "both-F" });              // still an admin of its own connection b throughout
    const p = f.propose({ unchanged: () => new Promise<boolean>((r) => { release = () => r(true); }) });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    const decided = f.store.decide(p.view.id, "confirm", { ...self, via: "web" });
    f.fm.fleetConfig!.channels![0]!.access!.allowed_users = ["a-F"];
    release();
    expect([(await decided).state, p.apply.mock.calls.length, f.any.settingsRole(s.req).role.ok]).toEqual(["stale", 0, true]);
  });
  // #2205 review P2, AGEND-122: General is only where the notice goes now — it is no longer a condition of the confirmation. Gone
  // between Apply and execution, the change still applies (the admin's own role is what was asked) and the notice goes to whichever
  // General is still reachable, else nowhere.
  it.each([
    ["General's model disappears", ["a", "b"], (f: any) => f.any.daemons.delete("general_b"), [0, 1]],
    ["General's route lifetime ends (a fresh route is read when the notice is posted)", ["a", "b"], (f: any) => f.any.lifecycle.invalidate("general_b"), [0, 1]],
    ["General's connection drops (retrying)", ["a", "b"], (f: any) => f.any.adapterState.set("b", { status: "retrying", retryCount: 1 }), [0, 0]],
    ["one General's agent stops, another is still there", ["a", "b", "c"], (f: any) => f.any.daemons.delete("general_b"), [0, 1, 0]],
    ["every General's connection drops", ["a", "b", "c"], (f: any) => { for (const id of ["b", "c"]) f.any.adapterState.set(id, { status: "retrying", retryCount: 1 }); }, [0, 0, 0]],
  ] as Array<[string, string[], (f: any) => void, number[]]>)("between Apply and execution, %s: applied; the notice (sent per General) %j", async (_n, ids, change, notices) => {
    let release!: () => void;
    const f = fleet("telegram", ids), s = f.session({ adapterId: "a", userId: "a-F" });
    const p = f.propose({ unchanged: () => new Promise<boolean>((r) => { release = () => r(true); }) });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    const decided = f.store.decide(p.view.id, "confirm", { ...self, via: "web" });
    change(f);
    release();
    const view = await decided;
    await self.done(view);
    expect([view.state, p.apply.mock.calls.length, f.adapters.map(a => a.sendText.mock.calls.length)]).toEqual(["applied", 1, notices]);
  });
  it("General's route lifetime ended since Apply: the route captured with it is refused (its followStop throws, nothing begins) — the change itself still applies", async () => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), p = f.propose(), self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id), begin = vi.fn(async () => {});
    await self.followStop("worker", begin);   // a stop of some other agent: General's route must be the one it began with
    expect(begin, "control: its route is current at Apply").toHaveBeenCalledOnce();
    f.any.lifecycle.invalidate("general_b");
    await expect(self.followStop("worker", begin)).rejects.toThrow("Settings route expired");
    expect([begin.mock.calls.length, (await f.store.decide(p.view.id, "confirm", { ...self, via: "web" })).state]).toEqual([1, "applied"]);
  });
  it("expired (max_session_hours past): none", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 19, 10, 0, 0) });
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), p = f.propose();
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).not.toBeNull();
    vi.setSystemTime(Date.UTC(2026, 9, 21, 11, 0, 0));                                       // 49 h later: past the 48 h default
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  // The scope's admin check must be asked as that account (its own platform), never by its user id alone: a Discord account whose id
  // equals a Telegram admin's is not that admin. (The role's own check passes — it is an admin of its Discord connection c.)
  it("an account on another platform whose user id is the same as an admin's here: none (ids are per platform)", () => {
    const f = fleet(), p = f.propose();
    const other = { id: "c", type: "discord", mode: "topic", group_id: "300", access: { mode: "open", allowed_users: ["a-F"] } };
    f.fm.fleetConfig!.channels!.push(other as any);
    f.fm.worlds.set("c", { id: "c", adapter: { type: "discord" }, groupId: "300", channelConfig: other, accessManager: new AccessManager(other.access as any, join(f.any.dataDir, "c.json")) } as any);
    expect(f.any.settingsSelfConfirmation(f.store, f.session({ adapterId: "c", userId: "a-F" }).req, p.view.id)).toBeNull();
  });
  it("discord too: the same rule", async () => {
    const f = fleet("discord"), p = f.propose();
    expect([f.any.settingsSelfConfirmation(f.store, f.session({ adapterId: "a", userId: "a-F" }).req, p.view.id) !== null,
      f.any.settingsSelfConfirmation(f.store, f.session({ adapterId: "b", userId: "b-F" }).req, p.view.id)]).toEqual([true, null]);
  });
});

describe("#2868: where it is confirmed, and Apply now", () => {
  it("the save answers \"posting\"; a General card attached makes it \"chat\" with where it went; none attached: \"host_cli\"", async () => {
    const h = gateHarness(() => null);
    const r = await h.request(h.candidate());
    const id = r.body.pending_change.id;
    expect(r.body.pending_change.confirmation).toEqual({ kind: "posting", code: id });
    expect(h.store.attachPrompt(id, vi.fn(), { platform: "discord", connection: "dc" })).toBe(true);
    await tick();
    expect(h.store.get(id, "session-a")!.confirmation, "attached before the notifier settled: it stays chat").toEqual({ kind: "chat", code: id, where: [{ platform: "discord", connection: "dc" }] });
    const h2 = gateHarness(() => null);
    const r2 = await h2.request(h2.candidate());
    await tick();
    expect(h2.store.get(r2.body.pending_change.id, "session-a")!.confirmation).toEqual({ kind: "host_cli", code: r2.body.pending_change.id });
  });
  it("a store with no General notifier says host_cli from the start", () => {
    const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
    const { view } = store.propose({ session: "s", key: "k", bytes: 1, fingerprint: "f", source: "web_session", section: "access", requestedBy: "b", summary: ["x"],
      current: () => true, unchanged: async () => true, apply: vi.fn() });
    expect(view.confirmation.kind).toBe("host_cli");
  });
  it("its reads say whether this browser could confirm it itself now (can_self_confirm), asked at each read", async () => {
    let allow = false;
    const h = gateHarness(() => (allow ? { label: "Ada", current: () => true } : null));
    const id = (await h.request(h.candidate())).body.pending_change.id;
    expect([(await h.call("GET", `/api/settings/pending/${id}`)).body.can_self_confirm, (await h.call("GET", "/api/settings/pending")).body[0].can_self_confirm]).toEqual([undefined, undefined]);
    allow = true;
    expect([(await h.call("GET", `/api/settings/pending/${id}`)).body.can_self_confirm, (await h.call("GET", "/api/settings/pending")).body[0].can_self_confirm]).toEqual([true, true]);
    expect(h.asked.mock.calls.at(-1)![1]).toBe(id);
  });
  it("Apply now: refused (403) while this browser may not, the change still waiting; allowed: applying at once (web), applied once, General told", async () => {
    let allow = false;
    const done = vi.fn();
    const h = gateHarness(() => (allow ? { label: "Ada", current: () => true, done } : null));
    const id = (await h.request(h.candidate())).body.pending_change.id;
    const no = await h.call("POST", `/api/settings/pending/${id}/confirm`);
    expect([no.status, no.body.error, h.store.get(id, "session-a")!.state, h.save.mock.calls.length]).toEqual([403, "self_confirm_unavailable", "pending", 0]);
    allow = true;
    const yes = await h.call("POST", `/api/settings/pending/${id}/confirm`);
    expect([yes.status, yes.body.result, yes.body.pending_change.state, yes.body.pending_change.confirmation]).toEqual([202, "pending_confirmation", "applying", { kind: "web" }]);
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect([done.mock.calls[0]![0].state, done.mock.calls[0]![0].outcome.decided_by_label, h.config.channels[0].access.allowed_users, h.save.mock.calls.length]).toEqual(["applied", "Ada", ["2"], 1]);
    const again = await h.call("POST", `/api/settings/pending/${id}/confirm`);
    expect([again.status, again.body.error, h.save.mock.calls.length], "decided: not again").toEqual([409, "confirmation_not_pending", 1]);
  });
  it("Apply now: only this session's own request, and only signed in", async () => {
    let allow = false;
    const h = gateHarness(() => (allow ? { label: "Ada", current: () => true } : null));
    const id = (await h.request(h.candidate())).body.pending_change.id;
    allow = true;
    const theirs = await h.call("POST", `/api/settings/pending/${id}/confirm`, { other: true });
    expect([theirs.status, h.store.get(id, "session-a")!.state, h.save.mock.calls.length], "another session's request: not found, still waiting").toEqual([404, "pending", 0]);
    expect((await h.call("POST", `/api/settings/pending/${"0".repeat(32)}/confirm`)).status).toBe(404);
    expect((await h.call("POST", `/api/settings/pending/${"0".repeat(32)}/confirm`, { cookie: false })).status).toBe(401);
  });
});

// #3352 review F1 (security) -> AGEND-122 (R1): the Hub changes that open the fleet outward (pairing connect / confirm, publishing an
// agent, replacing the Hub's browser certificate) were never "Apply now" for the asker's browser. They are now like every other class
// of change: a signed-in fleet admin applies them (the Hub's authority is the primary General's card; none of these carry a mark
// of their own any more). The General's card still goes, and the guest / header token / not-an-admin lines still hold.
describe("#3352 F1 / AGEND-122: Hub changes that open the fleet outward are confirmed by a signed-in admin's Apply now, like any other", () => {
  const cert = { fingerprint256: "AA:".repeat(31) + "AA", validTo: "2027-01-01T00:00:00.000Z", selfSigned: true };
  const hub = (f: ReturnType<typeof fleet>, method: string, path: string, body: unknown, extra: Record<string, unknown>, binding?: string) => {
    const effect = prepareSettingsEffect(method, path, body, { config: f.fm.fleetConfig, classic: {}, ...extra } as any, binding);
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    const view = f.store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
      ...(effect.diff!.opensLink ? { opensLink: true as const } : {}),
      current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
    return { view, apply };
  };
  const pairing = { hubPairing: () => ({ summary: ["Hub pairing step"] }) };
  it.each([
    ["pairing connect", "POST", "/api/hub/member/pairing/connect", { address: "https://hub.example.test", code: "ABCD-EFGH" }, pairing, undefined],
    ["pairing confirm", "POST", "/api/hub/member/pairing/confirm", { digest: "d".repeat(64) }, pairing, undefined],
    ["publish an agent", "POST", "/api/hub/member/exposures", { agent: "builder" }, { hubExposure: () => ({ summary: ["Publish builder"] }) }, undefined],
    ["browser certificate", "POST", "/api/settings/hub/browser-certificate/apply", { reference: "12345678-1234-4321-8abc-123456789012", revision: "c".repeat(64) },
      { hubBrowserCertificate: () => ({ certificate: cert }) }, "owner"],
    ["membership", "PUT", "/api/settings/hub/membership", { enabled: true }, { hubMembership: () => ({ enabled: false }) }, undefined],
    ["retention", "PUT", "/api/settings/hub/retention", { contentDays: 14, eventDays: 60, revision: 1 }, {}, undefined],
    ["pairing disconnect", "POST", "/api/hub/member/pairing/disconnect", { hubId: "h", binding: "b" }, pairing, undefined],
  ] as Array<[string, string, string, unknown, Record<string, unknown>, string | undefined]>)("%s: Apply now for the primary General's signed-in admin, here or from another device; the General's card still goes", async (_n, method, path, body, extra, binding) => {
    const f = fleet(), p = hub(f, method, path, body, extra, binding), ask = (req: any) => f.any.settingsSelfConfirmation(f.store, req, p.view.id);
    expect(f.store.opensLink(p.view.id), "no mark of its own: only a link option carries opensLink").toBe(false);
    const s = f.session({ adapterId: "a", userId: "a-F" }), away = f.session({ adapterId: "a", userId: "a-F" }, { lan: true });
    expect([ask(s.req)?.label, ask(away.req)?.label]).toEqual([expect.stringMatching(/\(web-verified\)$/), expect.stringMatching(/\(web-verified\)$/)]);
    await vi.waitFor(() => expect(f.adapters[0]!.notifyAlert).toHaveBeenCalled());
    expect(p.apply, "the card is another way to confirm; nothing runs until one is").not.toHaveBeenCalled();
    const self = ask(s.req);
    expect([(await f.store.decide(p.view.id, "confirm", { ...self, via: "web" })).state, p.apply.mock.calls.length]).toEqual(["applied", 1]);
  });
  it("…and the ones who still must not: a guest, a header token, an account no longer an admin of its own connection", async () => {
    const f = fleet(), p = hub(f, "POST", "/api/hub/member/pairing/connect", { address: "https://hub.example.test", code: "ABCD-EFGH" }, pairing), ask = (req: any) => f.any.settingsSelfConfirmation(f.store, req, p.view.id);
    await vi.waitFor(() => expect(f.adapters[0]!.notifyAlert).toHaveBeenCalled());
    expect(ask(f.session({ adapterId: "a", userId: "a-F" }).req), "control: the admin").not.toBeNull();
    expect([ask(f.session({ adapterId: "a", userId: "a-F" }, { tier: "guest" }).req), ask(f.headerToken), ask(f.session({ adapterId: "a", userId: "stranger" }).req)]).toEqual([null, null, null]);
    expect(p.apply).not.toHaveBeenCalled();
  });
});
