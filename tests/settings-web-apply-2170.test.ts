/**
 * #2170: a web-verified session's own Apply confirms a held Settings change — when its account is an admin of exactly
 * the change's effect owners (the chat card's own rule) and still is, verified, when it executes. Otherwise nothing
 * changes: the chat card, or the host CLI.
 * - The gate: a self-confirmation is asked after the change is held; it claims the change (state applying,
 *   confirmation "web") before the chat prompt runs, so no card is posted; every confirmation check still runs at
 *   execution; a reused request (same key) is not confirmed again; with none, the change waits as before.
 * - The fleet: who qualifies (verified + admin of the scope), who does not (not an admin of the scope, an unknown
 *   scope, unverified, a guest, the host operator's ownerless session, the public link, expired), a revocation between
 *   Apply and execution (stale), and General's notice.
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
    principal: req => req.headers.cookie ? { id: "session-a", label: "browser", source: "web_session", current: () => true } : null,
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
  return { config, save, store, notify, asked, request, candidate };
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
    expect([r.body.pending_change.state, r.body.pending_change.confirmation.kind, h.save.mock.calls.length]).toEqual(["pending", "host_cli", 0]);
    await tick();
    expect(h.notify.mock.calls.map((c) => c[0].state)).toEqual(["pending"]);
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
  /** A browser session: its account (adapter, user), authorized (#1939) or not; a request carrying its cookie. */
  const session = (owner: { adapterId: string; userId: string } | null, opts: { authorize?: boolean; tier?: "admin" | "guest" } = {}) => {
    const c = any.webSessions.create({ tier: opts.tier ?? "admin", surface: "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN), ...(owner ? { owner } : {}) });
    if (opts.authorize !== false && owner) expect(any.authorizeWebSession(c.record, "loopback", false)).toMatchObject({ ok: true });
    const req = { method: "PUT", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:19280", origin: "http://127.0.0.1:19280", "sec-fetch-site": "same-origin",
      cookie: `agend_session=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
    return { req, record: c.record };
  };
  /** A held change on connection a's access (or one whose scope is unknown). */
  const propose = (opts: { unknown?: boolean; both?: boolean; unchanged?: () => Promise<boolean> } = {}) => {
    const body = channels.map((ch) => (ch.id === "a" || opts.both ? { ...ch, access: { ...ch.access, allowed_users: [...ch.access.allowed_users, "new-F"] } } : ch));
    const effect = prepareSettingsEffect("PUT", "/api/settings/fleet/channels", body, { config: fm.fleetConfig, classic: {} });
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections,
      authority: opts.unknown ? { connections: [], primaryGeneral: false, unknown: true } : effect.diff!.authority,
      current: () => true, unchanged: opts.unchanged ?? (async () => true), snapshot: () => null, apply }).view;
    return { view, apply };
  };
  return { fm, any, store, adapters, session, propose };
}

describe("#2453 (§0.2): the named-link option is never confirmed by its asker", () => {
  /** A held web change (PUT /api/settings/fleet/web), as the gate proposes it: its mark from the trusted effect. */
  function proposeWeb(f: ReturnType<typeof fleet>, verified_authority: Record<string, unknown>) {
    const effect = prepareSettingsEffect("PUT", "/api/settings/fleet/web", { verified_authority }, { config: f.fm.fleetConfig, classic: {} });
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    const view = f.store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
      ...(effect.diff!.noSelfConfirm ? { noSelfConfirm: true as const } : {}),
      current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
    return { view, apply };
  }
  it("a web-verified local admin turning it on — alone or with other keys — gets none: a General's card or the host decides", () => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" });
    const alone = proposeWeb(f, { named_link: true }), mixed = proposeWeb(f, { named_link: true, loopback_only: true });
    expect([f.any.settingsSelfConfirmation(f.store, s.req, alone.view.id), f.any.settingsSelfConfirmation(f.store, s.req, mixed.view.id),
      alone.apply.mock.calls.length, mixed.apply.mock.calls.length]).toEqual([null, null, 0, 0]);
  });
  it("control — the same admin's ordinary change is still confirmed by applying it (#2170 unchanged)", () => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), p = f.propose();
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)?.label).toMatch(/\(web-verified\)$/);
  });
  it("a named-link session web-verified over the gateway (option on) is still never the self-confirming authority", () => {
    const f = fleet();
    (f.fm.fleetConfig as any).web = { public_link: { hostname: "agend.example.com" }, verified_authority: { enabled: true, named_link: true } };
    const X = "e".repeat(32);
    const c = f.any.webSessions.create({ tier: "admin", surface: "gateway", exposureId: X, label: "phone", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: "a-F" } });
    expect(f.any.authorizeWebSession(c.record, "named_link", true)).toMatchObject({ ok: true });
    const req = { method: "PUT", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "agend.example.com", origin: "https://agend.example.com", "sec-fetch-site": "same-origin",
      cookie: `__Host-agend_session=${c.sessionId}; agend_session=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
    bindGatewayRequest(req, { surface: "gateway", named: true, exposureId: X, expectedOrigin: "https://agend.example.com", isCurrent: () => true });
    expect(f.any.webAuthority({ session: c.record, gateway: true, peer: "named_link" }).authority.kind, "control: it is web-verified there").toBe("web-verified");
    const p = f.propose();
    expect(f.any.settingsSelfConfirmation(f.store, req, p.view.id)).toBeNull();
  });
  it("§0.3: a web-verified local admin turning the quick-link option on — alone or with other keys — gets none", () => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" });
    const alone = proposeWeb(f, { quick_link: true }), mixed = proposeWeb(f, { quick_link: true, loopback_only: true });
    expect([f.any.settingsSelfConfirmation(f.store, s.req, alone.view.id), f.any.settingsSelfConfirmation(f.store, s.req, mixed.view.id),
      alone.apply.mock.calls.length, mixed.apply.mock.calls.length]).toEqual([null, null, 0, 0]);
  });
  it("§0.3: a quick-link session web-verified over the gateway (option on) is still never the self-confirming authority", () => {
    const f = fleet();
    (f.fm.fleetConfig as any).web = { verified_authority: { enabled: true, quick_link: true } };
    const X = "e".repeat(32);
    const c = f.any.webSessions.create({ tier: "admin", surface: "gateway", exposureId: X, label: "phone", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: "a-F" } });
    expect(f.any.authorizeWebSession(c.record, "quick_link", true)).toMatchObject({ ok: true });
    const req = { method: "PUT", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "abc-def.trycloudflare.com", origin: "https://abc-def.trycloudflare.com", "sec-fetch-site": "same-origin",
      cookie: `__Host-agend_session=${c.sessionId}; agend_session=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId) } };
    bindGatewayRequest(req, { surface: "gateway", exposureId: X, expectedOrigin: "https://abc-def.trycloudflare.com", isCurrent: () => true });
    expect(f.any.webAuthority({ session: c.record, gateway: true, peer: "quick_link" }).authority.kind, "control: it is web-verified there").toBe("web-verified");
    const p = f.propose();
    expect(f.any.settingsSelfConfirmation(f.store, req, p.view.id)).toBeNull();
  });
  it("a request over the public link is never the self-confirming authority — named link or not", () => {
    const f = fleet(), p = f.propose();
    for (const named of [true, false]) {
      const s = f.session({ adapterId: "a", userId: "a-F" });
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
  it.each([
    ["an admin of another connection only", { adapterId: "b", userId: "b-F" }, {}],
    ["signed in with an account, not authorized (#1939)", { adapterId: "a", userId: "a-F" }, { authorize: false }],
  ] as const)("%s: none — the chat card, as before", (_n, owner, opts) => {
    const f = fleet(), s = f.session(owner, opts as any), p = f.propose();
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
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
  it("no General a chat card could be posted in (the change's own, or one disconnected): none — the host CLI, as before", () => {
    const f = fleet(), both = f.propose({ both: true });
    expect(f.any.settingsSelfConfirmation(f.store, f.session({ adapterId: "a", userId: "both-F" }).req, both.view.id)).toBeNull();
    const g = fleet(), p = g.propose(), s = g.session({ adapterId: "a", userId: "a-F" });
    expect(g.any.settingsSelfConfirmation(g.store, s.req, p.view.id)).not.toBeNull();
    g.any.adapterState.set("b", { status: "disconnected", retryCount: 1 });
    expect(g.any.settingsSelfConfirmation(g.store, s.req, p.view.id)).toBeNull();
  });
  it("the host operator's own session (no account) and a guest's: none", () => {
    const f = fleet(), p = f.propose();
    expect(f.any.settingsSelfConfirmation(f.store, f.session(null).req, p.view.id)).toBeNull();
    expect(f.any.settingsSelfConfirmation(f.store, f.session({ adapterId: "a", userId: "a-F" }, { tier: "guest", authorize: false }).req, p.view.id)).toBeNull();
  });
  it("an account on a connection whose id is configured twice: none", () => {
    const f = fleet(), p = f.propose(), s = f.session({ adapterId: "b", userId: "both-F" });
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).not.toBeNull();       // admin of a, from b: qualifies
    f.fm.fleetConfig!.channels!.push({ ...f.fm.fleetConfig!.channels![1]! } as any);
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  it("General's agent not running (no chat card could be posted): none", () => {
    const f = fleet(), p = f.propose(), s = f.session({ adapterId: "a", userId: "a-F" });
    f.any.daemons.delete("general_b");
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  it("the only connected General is on another platform: none", () => {
    const f = fleet("telegram", ["a", "b", "c"], { c: "discord" }), p = f.propose(), s = f.session({ adapterId: "a", userId: "a-F" });
    f.any.adapterState.set("b", { status: "disconnected", retryCount: 1 });
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  it("two Generals a card could go to: the notice is posted once", async () => {
    const f = fleet("telegram", ["a", "b", "c"]), p = f.propose(), s = f.session({ adapterId: "a", userId: "a-F" });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    await self.done(await f.store.decide(p.view.id, "confirm", { ...self, via: "web" }));
    expect(f.adapters.map((a) => a.sendText.mock.calls.length)).toEqual([0, 1, 0]);
  });
  it("an unknown scope: none — even for the right admin", () => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), p = f.propose({ unknown: true });
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  it("over the public link: none (a public-link session is never web-verified)", () => {
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), p = f.propose();
    bindGatewayRequest(s.req, { surface: "public", exposureId: "e1", expectedOrigin: "https://x.example", isCurrent: () => true } as any);
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
  it("its authority asked again when it executes: revoked after Apply (Settings → Web → Revoke) — stale, nothing written", async () => {
    let release!: () => void;
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" });
    const p = f.propose({ unchanged: () => new Promise<boolean>((r) => { release = () => r(true); }) });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    const decided = f.store.decide(p.view.id, "confirm", { ...self, via: "web" });
    f.any.revokeWebAuthority();
    release();
    const view = await decided;
    expect([self.current(), view.state, p.apply.mock.calls.length]).toEqual([false, "stale", 0]);
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
    const f = fleet(), s = f.session({ adapterId: "b", userId: "both-F" });              // still verified on b throughout
    const p = f.propose({ unchanged: () => new Promise<boolean>((r) => { release = () => r(true); }) });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    const decided = f.store.decide(p.view.id, "confirm", { ...self, via: "web" });
    f.fm.fleetConfig!.channels![0]!.access!.allowed_users = ["a-F"];
    release();
    expect([(await decided).state, p.apply.mock.calls.length, f.any.webAuthority({ session: s.record, gateway: false, peer: "loopback" }).authority.kind]).toEqual(["stale", 0, "web-verified"]);
  });
  // #2205 review P2: the General a card could go to is asked again too — gone between Apply and execution, the change
  // is the host CLI's, as it would have been at Apply; another one left, it applies.
  it.each([
    ["General's agent stops", ["a", "b"], (f: any) => f.any.daemons.delete("general_b"), "stale", 0],
    ["General's connection drops (retrying)", ["a", "b"], (f: any) => f.any.adapterState.set("b", { status: "retrying", retryCount: 1 }), "stale", 0],
    ["one General's agent stops, another is still there", ["a", "b", "c"], (f: any) => f.any.daemons.delete("general_b"), "applied", 1],
  ] as const)("between Apply and execution, %s", async (_n, ids, change, state, applied) => {
    let release!: () => void;
    const f = fleet("telegram", [...ids]), s = f.session({ adapterId: "a", userId: "a-F" });
    const p = f.propose({ unchanged: () => new Promise<boolean>((r) => { release = () => r(true); }) });
    const self = f.any.settingsSelfConfirmation(f.store, s.req, p.view.id);
    const decided = f.store.decide(p.view.id, "confirm", { ...self, via: "web" });
    change(f);
    release();
    expect([(await decided).state, p.apply.mock.calls.length]).toEqual([state, applied]);
  });
  it("expired (max_session_hours past): none", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 19, 10, 0, 0) });
    const f = fleet(), s = f.session({ adapterId: "a", userId: "a-F" }), p = f.propose();
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).not.toBeNull();
    vi.setSystemTime(Date.UTC(2026, 9, 21, 11, 0, 0));                                       // 49 h later: past the 48 h default
    expect(f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)).toBeNull();
  });
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
