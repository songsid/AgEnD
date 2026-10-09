import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";

const fixtures: Array<{ dir: string; fm: FleetManager; any: any; store: SettingsConfirmationStore }> = [];
afterEach(() => {
  for (const r of fixtures.splice(0)) {
    r.store.close(); for (const p of r.any.pendingNonceButtons.values()) clearTimeout(p.timer);
    r.fm.stormWindow.shutdown(); r.fm.spawnGate.shutdown(); rmSync(r.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
function rig(platform: "telegram" | "discord" = "telegram", ids = ["a", "b"]) {
  const dir = mkdtempSync(join(tmpdir(), "agend-settings-target-")), fm = new FleetManager(dir), any = fm as any;
  const channels = ids.map((id, i) => ({ id, type: platform, mode: "topic", group_id: `-100${i + 1}`,
    access: { mode: "open", allowed_users: [id + "-F"] } }));
  fm.fleetConfig = { defaults: { backend: "codex" }, channels, instances: Object.fromEntries(ids.map((id, i) =>
    ["general_" + id, { working_directory: dir, general_topic: true, channel_id: id, topic_id: i + 1 }])) } as any;
  const adapters = channels.map(channel => Object.assign(new EventEmitter(), { id: channel.id, type: platform,
    notifyAlert: vi.fn(async (chatId: string, _alert: unknown, options: any) => ({ chatId, messageId: channel.id + "-prompt", threadId: options?.threadId })),
    editMessageRemoveButtons: vi.fn(async () => {}), sendText: vi.fn(async () => ({ chatId: channel.group_id, messageId: "reply" })),
  }));
  fm.adapter = adapters[0] as any;
  channels.forEach((channel, i) => {
    const adapter = adapters[i]!; fm.adapters.set(channel.id, adapter as any);
    fm.worlds.set(channel.id, { id: channel.id, adapter, groupId: channel.group_id, channelConfig: channel,
      accessManager: new AccessManager(channel.access as any, join(dir, channel.id + ".json")) } as any);
    any.daemons.set("general_" + channel.id, new EventEmitter()); any.adapterState.set(channel.id, { status: "connected", retryCount: 0 });
  });
  const store: SettingsConfirmationStore = new SettingsConfirmationStore({ audit: vi.fn(), notify: view => any.promptSettingsChange(store, view) });
  any.settingsConfirmation = { store };
  const r = { dir, fm, any, channels, adapters, store }; fixtures.push(r); return r;
}
function propose(r: ReturnType<typeof rig>, affected: boolean, options: { body?: any; unchanged?: () => Promise<boolean>; beforeCommit?: () => Promise<void> } = {}) {
  const body = options.body ?? (affected ? r.channels.map(ch => ch.id === "a" ? { ...ch, access: { ...ch.access, allowed_users: [...ch.access.allowed_users, "new-F"] } } : ch)
    : { public_link: { ttl_minutes: 60 } });
  const effect = prepareSettingsEffect("PUT", affected ? "/api/settings/fleet/channels" : "/api/settings/fleet/web", body,
    { config: r.fm.fleetConfig, classic: {} });
  const apply = vi.fn(async (_current: () => boolean, execution: any) => {
    if (options.beforeCommit) await options.beforeCommit();
    return execution.commit(() => "applied");
  });
  const view = r.store.propose({ session: "browser", key: "request", bytes: 1, source: "web_session", section: effect.diff!.section,
    requestedBy: "browser", fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary,
    affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
    current: () => true, unchanged: options.unchanged ?? (async () => true), snapshot: () => null, apply }).view;
  return { view, apply };
}
async function prompt(r: ReturnType<typeof rig>) {
  await vi.waitFor(() => expect(r.any.pendingNonceButtons.size).toBe(1));
  const entry = [...r.any.pendingNonceButtons.values()][0] as any;
  const data = { callbackData: `settings-confirm:${entry.nonce}:confirm`, chatId: entry.chatId, threadId: entry.threadId,
    messageId: entry.messageId, userId: "", ack: vi.fn() };
  return { entry, data };
}

describe.each(["telegram", "discord"] as const)("#1490 row11 %s: fallback never changes authority", platform => {
  it("a fallback bot's sole admin cannot confirm another existing connection", async () => {
    const r = rig(platform), p = propose(r, true), { entry, data } = await prompt(r);
    expect(entry.adapterId).toBe("b");
    await r.any.dispatchAdapterCallback({ ...data, userId: "b-F" }, "b", r.adapters[1]);
    expect(p.apply).not.toHaveBeenCalled();
    expect(r.store.get(p.view.id, "browser")!.state).toBe("pending");
    expect(r.any.pendingNonceButtons.has(entry.nonce)).toBe(true);
  });
  it("the existing target's admin can use a same-platform fallback without being that bot's admin", async () => {
    const r = rig(platform), p = propose(r, true), { data } = await prompt(r);
    await r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]);
    expect(p.apply).toHaveBeenCalledOnce();
    expect(r.store.get(p.view.id, "browser")!.state).toBe("applied");
  });
  it("fleet-wide confirmation retains primary General authority after delivery fallback", async () => {
    const r = rig(platform); r.adapters[0]!.notifyAlert.mockRejectedValue(Error("inert primary unavailable"));
    const p = propose(r, false), { entry, data } = await prompt(r);
    expect(entry.adapterId).toBe("b");
    await r.any.dispatchAdapterCallback({ ...data, userId: "b-F" }, "b", r.adapters[1]);
    expect(p.apply).not.toHaveBeenCalled();
    expect(r.store.get(p.view.id, "browser")!.state).toBe("pending");
  });
  it("the primary General admin can confirm a fleet-wide change on the fallback", async () => {
    const r = rig(platform); r.adapters[0]!.notifyAlert.mockRejectedValue(Error("inert primary unavailable"));
    const p = propose(r, false), { data } = await prompt(r);
    await r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]);
    expect(p.apply).toHaveBeenCalledOnce();
    expect(r.store.get(p.view.id, "browser")!.state).toBe("applied");
  });
  it("a stopped primary General does not transfer fleet-wide authority to its delivery fallback", async () => {
    const r = rig(platform); r.any.daemons.delete("general_a");
    const p = propose(r, false), { data } = await prompt(r);
    await r.any.dispatchAdapterCallback({ ...data, userId: "b-F" }, "b", r.adapters[1]); expect(p.apply).not.toHaveBeenCalled();
    await r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]); expect(p.apply).toHaveBeenCalledOnce();
  });
  it("when the primary connection has no configured General, the first configured General supplies fleet-wide F", async () => {
    const r = rig(platform); delete r.fm.fleetConfig!.instances.general_a;
    const p = propose(r, false), { data } = await prompt(r);
    await r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]); expect(p.apply).not.toHaveBeenCalled();
    await r.any.dispatchAdapterCallback({ ...data, userId: "b-F" }, "b", r.adapters[1]); expect(p.apply).toHaveBeenCalledOnce();
  });
  it("an empty fallback admin list does not veto the target's admin", async () => {
    const r = rig(platform); r.channels[1]!.access.allowed_users = [];
    const p = propose(r, true), { data } = await prompt(r);
    await r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]);
    expect(p.apply).toHaveBeenCalledOnce();
  });
  it("two existing targets require their admin intersection, not either target or the fallback", async () => {
    const r = rig(platform, ["a", "b", "c"]);
    for (const ch of r.channels.slice(0, 2)) ch.access.allowed_users.push("common-F");
    const body = r.channels.map(ch => ch.id === "c" ? ch : { ...ch, group_id: ch.group_id + "changed" });
    const p = propose(r, true, { body }), { data, entry } = await prompt(r);
    expect(entry.adapterId).toBe("c");
    for (const userId of ["a-F", "b-F", "c-F"]) {
      await r.any.dispatchAdapterCallback({ ...data, userId }, "c", r.adapters[2]);
      expect(p.apply).not.toHaveBeenCalled(); expect(r.any.pendingNonceButtons.has(entry.nonce)).toBe(true);
    }
    await r.any.dispatchAdapterCallback({ ...data, userId: "common-F" }, "c", r.adapters[2]);
    expect(p.apply).toHaveBeenCalledOnce();
  });
  it("adding a connection cannot bypass the existing target's F or primary General F", async () => {
    const r = rig(platform); for (const ch of r.channels) ch.access.allowed_users.push("common-F");
    const body = [...r.channels.map(ch => ch.id === "b" ? { ...ch, group_id: ch.group_id + "changed" } : ch),
      { ...r.channels[0], id: "new", group_id: "-100new" }];
    const p = propose(r, true, { body }), { data } = await prompt(r);
    for (const userId of ["a-F", "b-F"]) {
      await r.any.dispatchAdapterCallback({ ...data, userId }, "a", r.adapters[0]);
      expect(p.apply).not.toHaveBeenCalled();
    }
    await r.any.dispatchAdapterCallback({ ...data, userId: "common-F" }, "a", r.adapters[0]);
    expect(p.apply).toHaveBeenCalledOnce();
  });
  it("cross-platform existing targets remain host-only", async () => {
    const r = rig(platform, ["a", "b", "c"]); r.channels[1]!.type = platform === "telegram" ? "discord" : "telegram";
    r.adapters[1]!.type = r.channels[1]!.type;
    const p = propose(r, true, { body: r.channels.map(ch => ch.id === "c" ? ch : { ...ch, group_id: ch.group_id + "changed" }) });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(r.any.pendingNonceButtons.size).toBe(0);
    for (const adapter of r.adapters) expect(adapter.notifyAlert).not.toHaveBeenCalled();
    expect(r.store.get(p.view.id, "browser")!.confirmation.kind).toBe("host_cli");
  });
  it("live membership is rechecked after the actual baseline await", async () => {
    const r = rig(platform); let release!: (value: boolean) => void;
    const held = new Promise<boolean>(yes => { release = yes; }), unchanged = vi.fn(() => held);
    const p = propose(r, true, { unchanged }), { data } = await prompt(r);
    const deciding = r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]);
    await vi.waitFor(() => expect(unchanged).toHaveBeenCalledOnce());
    r.channels[0]!.access.allowed_users = [];
    release(true); await deciding;
    expect(p.apply).not.toHaveBeenCalled();
    expect(r.store.get(p.view.id, "browser")!.state).toBe("stale");
  });
  it("the real execution capability retains target F through a later apply await", async () => {
    const r = rig(platform); let release!: () => void;
    const held = new Promise<void>(yes => { release = yes; }), beforeCommit = vi.fn(() => held);
    const p = propose(r, true, { beforeCommit }), { data } = await prompt(r);
    const deciding = r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]);
    await vi.waitFor(() => expect(beforeCommit).toHaveBeenCalledOnce());
    r.channels[0]!.access.allowed_users = []; release(); await deciding;
    expect(r.store.get(p.view.id, "browser")!.state).toBe("failed");
    await expect(p.apply.mock.results[0]!.value).rejects.toThrow("settings_execution_stale");
  });
  it("changing target platform during admission cannot compare the old platform's user ID", async () => {
    const r = rig(platform); let release!: (value: boolean) => void;
    const held = new Promise<boolean>(yes => { release = yes; }), unchanged = vi.fn(() => held);
    const p = propose(r, true, { unchanged }), { data } = await prompt(r);
    const deciding = r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]);
    await vi.waitFor(() => expect(unchanged).toHaveBeenCalledOnce());
    r.channels[0]!.type = platform === "telegram" ? "discord" : "telegram";
    release(true); await deciding;
    expect(p.apply).not.toHaveBeenCalled();
    expect(r.store.get(p.view.id, "browser")!.state).toBe("stale");
  });
  it("reselecting primary during the baseline await invalidates fleet-wide authority", async () => {
    const r = rig(platform); let release!: (value: boolean) => void;
    const held = new Promise<boolean>(yes => { release = yes; }), unchanged = vi.fn(() => held);
    const p = propose(r, false, { unchanged }), { data } = await prompt(r);
    const deciding = r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "a", r.adapters[0]);
    await vi.waitFor(() => expect(unchanged).toHaveBeenCalledOnce());
    r.channels.reverse(); release(true); await deciding;
    expect(p.apply).not.toHaveBeenCalled();
    expect(r.store.get(p.view.id, "browser")!.state).toBe("stale");
  });
  it("a stopped prompt General cannot confirm even with valid target F", async () => {
    const r = rig(platform), p = propose(r, true), { data } = await prompt(r);
    r.any.ipcStoppingInstances.add("general_b");
    await r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]);
    expect(p.apply).not.toHaveBeenCalled();
    expect(r.store.get(p.view.id, "browser")!.state).toBe("pending");
  });
  it("a different-platform fallback remains host-only, even with the same numeric ID", async () => {
    const r = rig(platform); r.channels[0]!.access.allowed_users = ["42"]; r.channels[1]!.access.allowed_users = ["42"];
    r.channels[1]!.type = platform === "telegram" ? "discord" : "telegram";
    r.adapters[1]!.type = r.channels[1]!.type;
    const p = propose(r, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(r.any.pendingNonceButtons.size).toBe(0);
    expect(r.adapters[1]!.notifyAlert).not.toHaveBeenCalled();
    expect(r.store.get(p.view.id, "browser")!.confirmation.kind).toBe("host_cli");
  });
});

function httpGate(r: ReturnType<typeof rig>) {
  const path = join(r.dir, "fleet.yaml"); writeFileSync(path, yaml.dump(r.fm.fleetConfig));
  const save = vi.fn(() => {
    noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), r.fm.fleetConfig);
    writeFileSync(path, yaml.dump(r.fm.fleetConfig));
  });
  const ctx = { fleetConfig: r.fm.fleetConfig, dataDir: r.dir, configPath: path, logger: r.any.logger,
    getRawFleetConfig: () => r.fm.fleetConfig, saveFleetConfig: save } as unknown as SettingsApiContext;
  const baselines = new SettingsBaselines({ dataDir: r.dir, configPath: () => path, config: () => r.fm.fleetConfig, current: () => 1 });
  const gate = new SettingsHttpConfirmation(r.store, { principal: req => req.headers.cookie ? {
    id: "browser", label: "browser", source: "web_session", current: () => true } : null,
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot() });
  r.any.settingsConfirmation = gate;
  async function request(body: unknown) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = Object.assign(new EventEmitter(), { method: "PUT", url: "/api/settings/fleet/channels",
        headers: { cookie: "inert-session", "idempotency-key": "http-request" }, destroy() {} });
      let status = 0;
      const res: any = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader() {},
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } };
      try {
        const url = new URL(req.url, "http://localhost");
        expect(gate.handle(req as any, res, url, (r, s, u) => handleSettingsRequest(r, s, u, ctx))).toBe(true);
        queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (error) { reject(error); }
    });
  }
  return { save, path, request };
}
describe.each(["telegram", "discord"] as const)("#1490 %s: real HTTP projection → nonce → writer", platform => {
  it("only target F admits the actual normalized access write, exactly once", async () => {
    const r = rig(platform), h = httpGate(r), body = r.channels.map(ch => ch.id === "a"
      ? { ...ch, access: { ...ch.access, allowed_users: ["a-F", "new-F"] } } : ch);
    const response = await h.request(body);
    expect(response.status).toBe(202); expect(h.save).not.toHaveBeenCalled();
    const id = response.body.pending_change.id;
    expect(response.body.pending_change).not.toHaveProperty("authority");
    expect(r.store.authorityOf(id)).toEqual({ connections: ["a"], primaryGeneral: false, unknown: false });
    const { entry, data } = await prompt(r); expect(entry.adapterId).toBe("b");
    await r.any.dispatchAdapterCallback({ ...data, userId: "b-F" }, "b", r.adapters[1]);
    expect(h.save).not.toHaveBeenCalled(); expect(r.store.get(id, "browser")!.state).toBe("pending");
    await r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]);
    expect(h.save).toHaveBeenCalledOnce(); expect(r.store.get(id, "browser")!.state).toBe("applied");
    expect((yaml.load(readFileSync(h.path, "utf8")) as any).channels[0].access.allowed_users).toEqual(["a-F", "new-F"]);
    await r.any.dispatchAdapterCallback({ ...data, userId: "a-F" }, "b", r.adapters[1]); expect(h.save).toHaveBeenCalledOnce();
  });
});
