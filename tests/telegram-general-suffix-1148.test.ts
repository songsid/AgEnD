import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { installKiroCompatibilityFixture } from "./helpers/kiro-process-stub.js";

// Real ingress/nonce/selector/TopicCommands methods. Every platform/lifecycle
// effect is inert, with private state only; the global process guard stays on.
installKiroCompatibilityFixture();
const GROUP = "-1001148";
const dirs: string[] = [];
const timers: Array<ReturnType<typeof setTimeout>> = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-command-fence-")); dirs.push(dir);
  const fm = new FleetManager(dir);
  const any = fm as any;
  const makeAdapter = (id: string) => ({
    id, type: "telegram",
    sendText: vi.fn(async () => ({ messageId: "notice", chatId: GROUP })),
    notifyAlert: vi.fn(async (chatId: string, _alert: unknown, opts?: { threadId?: string }) =>
      ({ messageId: "prompt", chatId, threadId: opts?.threadId })),
    editMessageRemoveButtons: vi.fn(async () => {}), editMessage: vi.fn(async () => {}),
    react: vi.fn(async () => {}), unreact: vi.fn(async () => {}),
  });
  const a = makeAdapter("tg-a"); const b = makeAdapter("tg-b");
  const channel = (id: string) => ({ id, type: "telegram", mode: "topic", group_id: GROUP,
    bot_token_env: "TEST_TOKEN", access: { mode: "open", allowed_users: ["admin"] } });
  fm.fleetConfig = { defaults: { backend: "codex" }, channels: [channel(a.id), channel(b.id)], instances: {
    general_a: { working_directory: dir, channel_id: a.id, general_topic: true, topic_id: 1 },
    general_b: { working_directory: dir, channel_id: b.id, general_topic: true, topic_id: 2 },
    worker: { working_directory: dir, channel_id: a.id, topic_id: 10, backend: "codex" },
  } } as any;
  fm.adapter = a as any;
  for (const adapter of [a,b]) {
    fm.adapters.set(adapter.id, adapter as any);
    fm.worlds.set(adapter.id, { id: adapter.id, adapterId: adapter.id, adapter, groupId: GROUP,
      channelConfig: fm.fleetConfig!.channels!.find(ch => ch.id === adapter.id),
      botUsername: adapter === a ? "AlphaBot" : "BetaBot",
      accessManager: new AccessManager({ mode: "open", allowed_users: ["admin"] } as any, join(dir, adapter.id + ".json")),
    } as any);
  }
  fm.routing.rebuild(fm.fleetConfig!);
  const ipc = { connected: true, send: vi.fn() };
  fm.instanceIpcClients.set("worker", ipc as any);
  any.daemons.set("worker", {});
  any.daemons.set("general_a", {}); any.daemons.set("general_b", {});
  vi.spyOn(any, "deliverToInstance").mockResolvedValue(undefined);
  vi.spyOn(any.topicCommands, "getStatusText").mockResolvedValue("STATUS-CARD");
  // Never let an accidental dispatch escape into a lifecycle/CLI effect.
  vi.spyOn(any, "startLoginSession").mockResolvedValue("LOGIN-CARD");
  vi.spyOn(any.topicCommands, "runPauseWake").mockResolvedValue("PAUSE-CARD");
  vi.spyOn(any.topicCommands, "handleUpdateCommand").mockResolvedValue(undefined);
  vi.spyOn(any.topicCommands, "handleRestartCommand").mockResolvedValue(undefined);
  return { fm, any, a, b, ipc };
}

const inbound = (adapterId: string, text: string, messageId: string) => ({
  source: "telegram", adapterId, chatId: GROUP, threadId: undefined, messageId,
  userId: "admin", username: "Admin", text, isBotMessage: false, timestamp: new Date(),
});

describe("#1148: no-thread General addresses its bot before shared dedup", () => {
  for (const text of ["/status@BetaBot", "/status@bEtAbOt", "/install-cli@BetaBot codex"]) {
    it(`wrong receiver leaves the intended key available: ${text}`, async () => {
      const r = rig();
      await r.any.handleInboundMessage(inbound(r.a.id, text, "shared"));
      expect(r.a.sendText, "wrong bot must neither handle nor refuse").not.toHaveBeenCalled();
      expect(r.any.recentMessageIds.size, "wrong bot must not burn the shared key").toBe(0);
      await r.any.handleInboundMessage(inbound(r.b.id, text, "shared"));
      expect(r.b.sendText).toHaveBeenCalled();
      expect(r.any.recentMessageIds.size).toBe(1);
      await r.any.handleInboundMessage(inbound(r.b.id, text, "shared"));
      if (text.startsWith("/status")) expect(r.any.topicCommands.getStatusText).toHaveBeenCalledOnce();
      else expect(r.any.startLoginSession).toHaveBeenCalledOnce();
      expect(r.any.deliverToInstance).not.toHaveBeenCalled();
    });
  }
  it("a bare no-thread command retains receiving General routing", async () => {
    const r = rig();
    await r.any.handleInboundMessage(inbound(r.a.id, "/status", "bare"));
    expect(r.a.sendText).toHaveBeenCalledOnce();
    expect(r.b.sendText).not.toHaveBeenCalled();
  });
  for (const text of ["/status@AlphaBot", "/status@aLpHaBoT", "/install_cli@AlphaBot codex"]) {
    it(`an addressed no-thread command is handled once: ${text}`, async () => {
      const r = rig();
      await r.any.handleInboundMessage(inbound(r.a.id, text, "addressed"));
      expect(r.a.sendText).toHaveBeenCalled();
      expect(r.b.sendText).not.toHaveBeenCalled();
      expect(r.any.recentMessageIds.size).toBe(1);
    });
  }
  it("an unknown bot identity cannot validate a suffixed command or burn its key", async () => {
    const r = rig(); (r.fm.worlds.get(r.a.id) as any).botUsername = undefined;
    await r.any.handleInboundMessage(inbound(r.a.id, "/status@AlphaBot", "unknown"));
    expect(r.a.sendText).not.toHaveBeenCalled();
    expect(r.any.recentMessageIds.size).toBe(0);
  });
});


describe("#1148 suffix boundaries", () => {
  it("no message id cannot authorize a wrong receiver", async () => {
    const r = rig(); const msg = inbound(r.a.id, "/status@BetaBot", "unused");
    (msg as any).messageId = undefined;
    await r.any.handleInboundMessage(msg);
    expect(r.a.sendText).not.toHaveBeenCalled();
    expect(r.any.topicCommands.getStatusText).not.toHaveBeenCalled();
    expect(r.any.recentMessageIds.size).toBe(0);
  });
  it("a missing General does not make a wrong suffix consume dedup", async () => {
    const r = rig(); r.any.daemons.delete("general_a"); r.any.daemons.delete("general_b");
    await r.any.handleInboundMessage(inbound(r.a.id, "/status@BetaBot", "missing"));
    expect(r.any.recentMessageIds.size).toBe(0);
    expect(r.a.sendText).not.toHaveBeenCalled();
  });
  it("present-thread unknown username retains its existing permissive suffix handling", async () => {
    const r = rig(); (r.fm.worlds.get(r.a.id) as any).botUsername = undefined;
    await r.any.handleInboundMessage({ ...inbound(r.a.id, "/status@BetaBot", "thread"), threadId: "1" });
    expect(r.any.topicCommands.getStatusText).toHaveBeenCalledOnce();
    expect(r.a.sendText).toHaveBeenCalled();
  });
  it("outside-forum and foreign topic copies remain Classic candidates", () => {
    const r = rig(); (r.fm.worlds.get(r.a.id) as any).botUsername = undefined;
    for (const chatId of ["42", "-100elsewhere"]) {
      const msg = { ...inbound(r.a.id, "/start@BetaBot", "classic"), chatId, threadId: "1" };
      const normalized = r.any.inboundRouteThreadId(msg);
      expect(normalized).toBeUndefined();
      expect(r.any.isOwnerCommandCopy(msg, normalized)).toBe(true);
    }
  });
  for (const alias of ["/sys-info", "/sys_info"]) {
    it(`${alias}@AlphaBot remains ordinary input, while the unsuffixed alias runs diagnostics`, async () => {
      const r = rig(); const sysinfo = vi.spyOn(r.any.topicCommands, "handleSysInfoCommand").mockResolvedValue(undefined);
      await r.any.handleInboundMessage(inbound(r.a.id, alias, "bare-alias"));
      expect(sysinfo).toHaveBeenCalledOnce();
      await r.any.handleInboundMessage(inbound(r.a.id, alias + "@AlphaBot", "suffixed-alias"));
      expect(sysinfo).toHaveBeenCalledOnce();
      expect(r.any.deliverToInstance).toHaveBeenCalledOnce();
    });
  }
});

for (const known of [true, false]) {
  it(`Classic unknown-username policy is retained (known=${known})`, async () => {
    const r = rig(); if (!known) (r.fm.worlds.get(r.a.id) as any).botUsername = undefined;
    r.any.classicChannels = { hasChannel: () => false, isAdmin: () => true };
    const stop = vi.spyOn(r.any, "handleClassicStop").mockResolvedValue("STOP-CARD");
    await r.any.handleInboundMessage({ ...inbound(r.a.id, "/stop@BetaBot", "private"), chatId: "42" });
    expect(stop).toHaveBeenCalledTimes(known ? 0 : 1);
  });
}
