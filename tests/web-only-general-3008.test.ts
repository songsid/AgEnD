/**
 * #3008 G1–G3 (alpha.3; the user's simplified form hmsg-33c3d609, decision 5: a web-only General, minimal and opt-in):
 * a fleet with no chat connection needs no General (its Notices and Needs you need no model), and may have exactly one —
 * the agent its owner ticks.
 *  - the validator: no "no general_topic instance" warning on a web-only fleet; a warning when it has two; a chat fleet
 *    keeps its warning when it has none;
 *  - Settings: ticking a second agent as the General is refused before it is proposed (409 one_general), and so is
 *    "every agent is a General" in the defaults with more than one agent; unticking, re-saving the General itself and a
 *    chat fleet's second General are unchanged;
 *  - adding a chat connection later never makes two: the ticked General is bound to that chat's own General topic
 *    (Telegram's thread 1, Discord's general channel) by the startup's topic pass — no forum topic, no second General.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { addsSecondGeneral } from "../src/web-only-fleet.js";
import { csrfTokenFor } from "../src/web-session.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-3008-general-")); dirs.push(d); return d; };
const TG = { type: "telegram", mode: "topic", bot_token_env: "AGEND_TEST_TG_TOKEN", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } };
const DC = { type: "discord", mode: "topic", bot_token_env: "AGEND_TEST_TG_TOKEN", group_id: "123456789012345678", general_channel_id: "223456789012345678", access: { mode: "locked", allowed_users: ["1"] } };

describe("#3008 G1 the validator", () => {
  const warnings = (cfg: Record<string, unknown>) => validateFleetConfig({ defaults: {}, ...cfg }).warnings.map(w => w.message).filter(m => /general_topic/.test(m));
  it("a web-only fleet: none is fine, one is fine, two are warned; a chat fleet with none keeps its warning", () => {
    expect(warnings({ instances: { a: { working_directory: "/w/a" } } })).toEqual([]);
    expect(warnings({ instances: { a: { working_directory: "/w/a", general_topic: true }, b: { working_directory: "/w/b" } } })).toEqual([]);
    expect(warnings({ instances: { a: { working_directory: "/w/a", general_topic: true }, b: { working_directory: "/w/b", general_topic: true } } }))
      .toEqual(["more than one general_topic instance on a fleet with no chat connection — keep one General (untick the others)"]);
    expect(warnings({ channel: TG, instances: { a: { working_directory: "/w/a" } } })).toEqual(["no general_topic instance — there is no general dispatcher to receive un-topic'd messages"]);
  });
  it("#3021 review P3: inherited flags count — defaults.general_topic with two agents is warned; an explicit false is not a General", () => {
    const two = "more than one general_topic instance on a fleet with no chat connection — keep one General (untick the others)";
    expect(warnings({ defaults: { general_topic: true }, instances: { a: { working_directory: "/w/a" }, b: { working_directory: "/w/b" } } })).toEqual([two]);
    expect(warnings({ defaults: { general_topic: true }, instances: { a: { working_directory: "/w/a" }, b: { working_directory: "/w/b", general_topic: false } } })).toEqual([]);
  });
});

interface Res { status: number; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}

async function fleet(config: Record<string, unknown>) {
  const dir = temp();
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  fm.fleetConfig = { defaults: {}, web: { verified_authority: { enabled: true } }, ...config } as never;
  any.saveFleetConfig = vi.fn();
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((any.healthServer as Server).address() as { port: number }).port, token = fm.getDashboardAccess().token!, origin = `http://127.0.0.1:${port}`;
  const signInWith = (code: string) => new Promise<{ cookie: string; sessionId: string }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "POST", path: "/auth/login", headers: { "content-type": "application/json", origin } }, res => {
      const set = res.headers["set-cookie"]; res.resume();
      res.on("end", () => { const cookie = (Array.isArray(set) ? set[0] : set)!.split(";")[0]!; resolve({ cookie, sessionId: cookie.split("=")[1]! }); });
    });
    r.on("error", reject); r.end(JSON.stringify({ code }));
  });
  // This computer's admin (`agend web --code`), signed in here.
  const host = await signInWith(JSON.parse((await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).body).code as string);
  const call = async (method: string, path: string, body: unknown, as = host) => {
    const r = await raw(port, method, path, { cookie: as.cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", [WEB_CSRF_HEADER]: csrfTokenFor(as.sessionId) }, JSON.stringify(body));
    return { status: r.status, body: JSON.parse(r.body || "null") };
  };
  const stop = () => new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); });
  return { fm, any, call, stop, signInWith };
}

describe("#3008 G1 Settings: one General on a fleet with no chat connection", () => {
  it("ticking a second is refused before anything is proposed; unticking it first, then ticking another, works", async () => {
    const h = await fleet({ instances: { planner: { working_directory: "/w/p", general_topic: true }, builder: { working_directory: "/w/b" } } });
    try {
      const second = await h.call("PATCH", "/api/settings/fleet/instances/builder", { general_topic: true });
      expect([second.status, second.body]).toEqual([409, { error: "one_general" }]);
      expect(h.fm.fleetConfig!.instances.builder.general_topic).not.toBe(true);
      // A new agent created as a General: refused too.
      expect((await h.call("POST", "/api/settings/fleet/instances", { name: "third", working_directory: "/w/t", general_topic: true })).body).toEqual({ error: "one_general" });
      // Saving the General itself again is not a second one.
      expect((await h.call("PATCH", "/api/settings/fleet/instances/planner", { general_topic: true, description: "routes work" })).status).not.toBe(409);
      // This computer's admin confirms its own change as it saves it (202, then applied).
      const generals = () => Object.entries(h.fm.fleetConfig!.instances).filter(([, c]) => c.general_topic === true).map(([n]) => n);
      expect((await h.call("PATCH", "/api/settings/fleet/instances/planner", { general_topic: false })).status).toBe(202);
      await vi.waitFor(() => expect(generals()).toEqual([]));
      expect((await h.call("PATCH", "/api/settings/fleet/instances/builder", { general_topic: true })).status).toBe(202);
      await vi.waitFor(() => expect(generals()).toEqual(["builder"]));
    } finally { await h.stop(); }
  }, 20_000);
  it("two ticks proposed while there was none (not confirmed as saved), confirmed one after the other: one General — the second is stale (the fleet changed under it)", async () => {
    const h = await fleet({ instances: { a: { working_directory: "/w/a" }, b: { working_directory: "/w/b" } } });
    try {
      // An admin session that is not this computer's admin (an ordinary code): its changes wait for a confirmation.
      const { tokenEpoch } = await import("../src/web-session.js");
      const code = h.any.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(h.fm.getDashboardAccess().token!) }).display;
      const other = await h.signInWith(code);
      const ta = await h.call("PATCH", "/api/settings/fleet/instances/a", { general_topic: true }, other);
      const tb = await h.call("PATCH", "/api/settings/fleet/instances/b", { general_topic: true }, other);
      expect([ta.status, tb.status]).toEqual([202, 202]);
      const store = h.any.settingsGate().store, actor = { label: "host", current: () => true };
      const first = await store.decide(ta.body.pending_change.id, "confirm", actor);
      const second = await store.decide(tb.body.pending_change.id, "confirm", actor);
      expect([first.state, second.state]).toEqual(["applied", "stale"]);
      expect(Object.entries(h.fm.fleetConfig!.instances).filter(([, c]) => c.general_topic === true).map(([n]) => n)).toEqual(["a"]);
    } finally { await h.stop(); }
  }, 20_000);
  it("\"every agent is a General\" in the defaults: refused with more than one agent; a chat fleet's second General is unchanged", async () => {
    const h = await fleet({ instances: { a: { working_directory: "/w/a" }, b: { working_directory: "/w/b" } } });
    try {
      expect(await h.call("PUT", "/api/settings/fleet/defaults", { general_topic: true })).toEqual({ status: 409, body: { error: "one_general" } });
    } finally { await h.stop(); }
    const chat = await fleet({ channel: TG, instances: { general: { working_directory: "/w/g", general_topic: true, topic_id: 1 }, other: { working_directory: "/w/o" } } });
    try {
      expect((await chat.call("PATCH", "/api/settings/fleet/instances/other", { general_topic: true })).status).not.toBe(409);
    } finally { await chat.stop(); }
  }, 20_000);
});

describe("#3008 G3 adding a chat connection later never makes two Generals", () => {
  async function restart(fleetCfg: Record<string, unknown>) {
    const dir = temp(), path = join(dir, "fleet.yaml");
    writeFileSync(path, JSON.stringify(fleetCfg));
    const fm = new FleetManager(dir) as any;
    clearInterval(fm.sessionPruneTimer);
    fm.loadConfig(path);
    fm.createForumTopic = vi.fn(async () => 3040);
    fm.saveFleetConfig = vi.fn();
    await fm.topicCommands.autoCreateTopics();
    return fm;
  }
  it.each([["Telegram", TG, 1], ["Discord", DC, "223456789012345678"]] as const)("%s: the ticked General is bound to the chat's own General (no forum topic, still one)", async (_p, channel, topic) => {
    vi.stubEnv("AGEND_TEST_TG_TOKEN", "fake");
    const fm = await restart({ defaults: {}, channel, instances: { planner: { working_directory: temp(), general_topic: true }, builder: { working_directory: temp() } } });
    expect(fm.fleetConfig.instances.planner.topic_id).toBe(topic);
    expect(fm.createForumTopic.mock.calls.map((c: unknown[]) => c[0])).toEqual(["builder"].map(() => expect.any(String)));   // only the worker gets a topic
    expect(Object.values(fm.fleetConfig.instances).filter((c: any) => c.general_topic === true)).toHaveLength(1);
  });
});

describe("#3021 review P2: every door that creates an agent — never a second General on a web-only fleet", () => {
  // A web-only fleet with one General by the defaults (`defaults.general_topic: true`, one agent): a new agent from ANY
  // door would inherit it. Control: the same fleet without that default creates an ordinary agent.
  const viaDefaults = { defaults: { general_topic: true }, instances: { a: { working_directory: "/w/a" } } };
  const ticked = { defaults: {}, instances: { a: { working_directory: "/w/a", general_topic: true } } };
  const effect = (config: Record<string, unknown>, method: string, path: string, body: unknown) => {
    try { prepareSettingsEffect(method, path, body, { config: config as never, classic: {} }); return "proposed"; }
    catch (err) { return (err as { code?: string }).code ?? String(err); }
  };
  it.each([
    ["Settings → New agent (Linux)", "POST", "/ui/instances", { topic_name: "b" }],
    ["Settings → New agent (Windows)", "POST", "/ui/instances", { runtime: "windows", topic_name: "b", backend: "codex", directory: "C:\\w\\b", sandbox: "read-only" }],
    ["the web-only setup", "POST", "/api/settings/quickstart/commit", { web_only: true, instance_name: "b", backend: "claude-code" }],
    ["Settings → Agents (create)", "POST", "/api/settings/fleet/instances", { name: "b", working_directory: "/w/b" }],
  ] as const)("%s: refused before it is proposed (409 one_general); without the default it is proposed", (_door, method, path, body) => {
    expect(effect(viaDefaults, method, path, body)).toBe("one_general");
    expect(effect(ticked, method, path, body)).not.toBe("one_general");
  });
  it("ticking \"every agent is a General\" in the defaults is refused on a web-only fleet, even with one agent; a chat fleet is unchanged", () => {
    expect(effect({ defaults: {}, instances: { a: { working_directory: "/w/a" } } }, "PUT", "/api/settings/fleet/defaults", { general_topic: true })).toBe("one_general");
    expect(effect({ channel: TG, defaults: {}, instances: { a: { working_directory: "/w/a" } } }, "PUT", "/api/settings/fleet/defaults", { general_topic: true })).not.toBe("one_general");
  });
  it("an agent's create_instance and a Windows agent ask the same rule", async () => {
    expect([addsSecondGeneral(viaDefaults as never), addsSecondGeneral(ticked as never), addsSecondGeneral({ ...viaDefaults, channel: TG } as never),
      addsSecondGeneral({ defaults: { general_topic: true }, instances: {} } as never)]).toEqual([true, false, false, false]);
    const h = await fleet(viaDefaults);
    try {
      const respond = vi.fn();
      await h.fm.lifecycle.handleCreate({ topic_name: "b" } as never, respond);
      expect(respond.mock.calls[0]?.[1]).toMatch(/^one_general:/);
      expect(Object.keys(h.fm.fleetConfig!.instances)).toEqual(["a"]);
    } finally { await h.stop(); }
  }, 20_000);
  it("over HTTP: the web-only setup and New agent answer 409 one_general before anything is made", async () => {
    const h = await fleet(viaDefaults);
    try {
      expect(await h.call("POST", "/ui/instances", { topic_name: "b" })).toMatchObject({ status: 409, body: { error: "one_general" } });
      expect(await h.call("POST", "/api/settings/quickstart/commit", { web_only: true, instance_name: "b", backend: "claude-code" })).toMatchObject({ status: 409, body: { error: "one_general" } });
      expect(Object.keys(h.fm.fleetConfig!.instances)).toEqual(["a"]);
    } finally { await h.stop(); }
  }, 20_000);
});

