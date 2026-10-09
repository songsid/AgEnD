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

async function clearPrompt(r: ReturnType<typeof rig>) {
  expect(await r.fm.promptClearConfirmation("worker", "10", r.a as any, GROUP, "10")).toBeNull();
  const alert = (r.a.notifyAlert.mock.calls[0] as any[])[1];
  const callbackData = alert.choices.find((c: any) => c.id.endsWith(":confirm")).id;
  return { callbackData, chatId: GROUP, threadId: "10", messageId: "prompt", userId: "admin", ack: vi.fn() };
}

describe("#1148: clear rechecks authority and exact target after retirement awaits", () => {
  const changes = ["revoke", "rebind", "move", "replace IPC", "replace daemon", "cancel epoch"] as const;
  for (const change of changes) {
    it(`no clear after ${change} during held platform edit`, async () => {
      const r = rig(); const callback = await clearPrompt(r);
      const entered = deferred(); const release = deferred();
      r.a.editMessageRemoveButtons.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
      const running = r.any.handleClearConfirmation(callback, r.a.id, r.a);
      await entered.promise;
      const replacementSend = vi.fn();
      if (change === "revoke") r.fm.fleetConfig!.channels![0].access!.allowed_users = [];
      if (change === "rebind") r.fm.fleetConfig!.instances.worker.channel_id = r.b.id;
      if (change === "move") { r.fm.fleetConfig!.instances.worker.topic_id = 11; r.fm.routing.rebuild(r.fm.fleetConfig!); }
      if (change === "replace IPC") r.fm.instanceIpcClients.set("worker", { connected: true, send: replacementSend } as any);
      if (change === "replace daemon") r.any.daemons.set("worker", {});
      if (change === "cancel epoch") r.any.cancelPendingDeliveries("worker");
      release.resolve(); await running;
      expect(r.ipc.send, "old generation must remain untouched").not.toHaveBeenCalled();
      expect(replacementSend, "replacement must remain untouched").not.toHaveBeenCalled();
    });
  }
  it("an unchanged authorized clear still sends once despite duplicate clicks", async () => {
    const r = rig(); const callback = await clearPrompt(r);
    await r.any.handleClearConfirmation(callback, r.a.id, r.a);
    await r.any.handleClearConfirmation(callback, r.a.id, r.a);
    expect(r.ipc.send).toHaveBeenCalledExactlyOnceWith({ type: "raw_paste", content: "/clear" });
  });
});

describe("#1148: selectors bind the channel to their target within the same adapter", () => {
  for (const kind of ["model", "effort"] as const) {
    for (const when of ["before click", "during progress"] as const) {
      it(`${kind}: moving the topic ${when} cannot apply through the old menu`, async () => {
        const r = rig(); const apply = vi.spyOn(r.any, kind === "model" ? "applyModel" : "applyEffort").mockResolvedValue("APPLIED");
        const entered = deferred(); const release = deferred();
        const timer = setTimeout(() => {}, 60_000); timers.push(timer);
        const nonce = "aabbcc";
        r.any[kind === "model" ? "pendingModelSelects" : "pendingEffortSelects"].set(nonce, {
          instanceName: "worker", userId: "admin", channelId: "10", adapterId: r.a.id, timer,
          respond: vi.fn(async () => {}), adapter: r.a, adapterChatId: GROUP, adapterThreadId: "10", menuMessageId: "menu",
        });
        const move = () => { r.fm.fleetConfig!.instances.worker.topic_id = 11; r.fm.routing.rebuild(r.fm.fleetConfig!); };
        if (when === "before click") move();
        else r.a.editMessageRemoveButtons.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
        const running = r.any[kind === "model" ? "handleModelSelection" : "handleEffortSelection"]({
          callbackData: `${kind}-select:${nonce}:${kind === "model" ? "gpt-5.5" : "high"}`,
          chatId: GROUP, threadId: "10", messageId: "menu", userId: "admin", ack: vi.fn(),
        }, r.a.id);
        if (when === "during progress") { await entered.promise; move(); release.resolve(); }
        await running; await Promise.resolve(); await Promise.resolve();
        expect(apply).not.toHaveBeenCalled();
      });
    }
  }
});

function seedMenu(r: ReturnType<typeof rig>, kind: "model" | "effort", target: string, channelId: string, threadId?: string) {
  const timer = setTimeout(() => {}, 60_000); timers.push(timer);
  const nonce = "ccbbdd";
  const apply = vi.spyOn(r.any, kind === "model" ? "applyModel" : "applyEffort").mockResolvedValue("APPLIED");
  r.any[kind === "model" ? "pendingModelSelects" : "pendingEffortSelects"].set(nonce, {
    instanceName: target, userId: "admin", channelId, adapterId: r.a.id, timer,
    respond: vi.fn(async () => {}), adapter: r.a, adapterChatId: GROUP, adapterThreadId: threadId, menuMessageId: "menu",
  });
  const click = () => r.any[kind === "model" ? "handleModelSelection" : "handleEffortSelection"]({
    callbackData: `${kind}-select:${nonce}:${kind === "model" ? "gpt-5.5" : "high"}`,
    chatId: threadId ? GROUP : channelId, threadId, messageId: "menu", userId: "admin", ack: vi.fn(),
  }, r.a.id);
  return { apply, click };
}

describe("#1148 selector address controls", () => {
  for (const kind of ["model", "effort"] as const) {
    for (const source of ["TG topic", "TG no-thread General", "Classic", "Discord"] as const) {
      it(`${kind}: ${source} current target remains actionable`, async () => {
        const r = rig(); let name = "worker", channel = "10", thread: string | undefined = "10";
        if (source === "TG no-thread General") { name = "general_a"; channel = GROUP; thread = undefined; }
        if (source === "Classic") {
          channel = "classic-room"; thread = undefined;
          r.any.classicChannels = { getInstanceByChannel: (id: string, adapterId: string) => id === channel && adapterId === r.a.id ? name : undefined };
        }
        if (source === "Discord") (r.a as any).type = "discord";
        const { apply, click } = seedMenu(r, kind, name, channel, thread);
        await click(); await Promise.resolve(); await Promise.resolve();
        expect(apply).toHaveBeenCalledExactlyOnceWith(name, kind === "model" ? "gpt-5.5" : "high");
      });
    }
    it(`${kind}: the old topic reassigned to another target does not authorize the old menu`, async () => {
      const r = rig(); const { apply, click } = seedMenu(r, kind, "worker", "10", "10");
      r.fm.fleetConfig!.instances.worker.topic_id = 11;
      r.fm.fleetConfig!.instances.other = { working_directory: dirs.at(-1)!, channel_id: r.a.id, topic_id: 10 } as any;
      r.fm.routing.rebuild(r.fm.fleetConfig!);
      await click(); await Promise.resolve(); await Promise.resolve();
      expect(apply).not.toHaveBeenCalled();
    });
  }
});

describe("#1148 clear exclusions and role controls", () => {
  it("a real clear prompt is not mirrored, and its nonce cannot be used on web", async () => {
    const r = rig(); const callback = await clearPrompt(r);
    const nonce = callback.callbackData.split(":")[1];
    expect(r.fm.listWebPrompts()).toEqual([]);
    expect(await r.fm.clickWebPrompt("worker", nonce, "confirm")).toMatchObject({ status: 409 });
    expect(r.ipc.send).not.toHaveBeenCalled();
    await r.any.handleClearConfirmation(callback, r.a.id, r.a);
    expect(r.ipc.send).toHaveBeenCalledOnce();
  });
  it("cancel never reaches clear IPC", async () => {
    const r = rig(); const callback = await clearPrompt(r);
    callback.callbackData = callback.callbackData.replace(":confirm", ":cancel");
    await r.any.handleClearConfirmation(callback, r.a.id, r.a);
    expect(r.ipc.send).not.toHaveBeenCalled();
  });
  it("a held clear cannot outlive fleet stop", async () => {
    const r = rig(); const callback = await clearPrompt(r); const entered = deferred(); const release = deferred();
    r.a.editMessageRemoveButtons.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const running = r.any.handleClearConfirmation(callback, r.a.id, r.a); await entered.promise;
    r.any.shuttingDown = true; release.resolve(); await running;
    expect(r.ipc.send).not.toHaveBeenCalled();
  });
  it("replacing the owner adapter invalidates a claimed clear", async () => {
    const r = rig(); const callback = await clearPrompt(r); const entered = deferred(); const release = deferred();
    r.a.editMessageRemoveButtons.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const running = r.any.handleClearConfirmation(callback, r.a.id, r.a); await entered.promise;
    (r.fm.worlds.get(r.a.id) as any).adapter = { ...r.a };
    release.resolve(); await running;
    expect(r.ipc.send).not.toHaveBeenCalled();
  });
  for (const outcome of ["live", "revoked"] as const) {
    it(`Classic C clear is ${outcome} during retirement`, async () => {
      const r = rig(); let admin = true;
      delete r.fm.fleetConfig!.instances.worker;
      r.any.classicChannels = {
        getChannelIdByInstance: () => "classic-room", getAdapterIdByInstance: () => r.a.id,
        getBackendByInstance: () => "codex",
        getInstanceByChannel: (id: string, owner: string) => id === "classic-room" && owner === r.a.id ? "worker" : undefined,
        isAdmin: (user: string) => admin && user === "classic-admin",
      };
      expect(await r.fm.promptClearConfirmation("worker", "classic-room", r.a as any, "classic-room")).toBeNull();
      const alert = r.a.notifyAlert.mock.calls[0][1] as any;
      const entered = deferred(); const release = deferred();
      r.a.editMessageRemoveButtons.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
      const running = r.any.handleClearConfirmation({ callbackData: alert.choices[0].id, chatId: "classic-room", messageId: "prompt", userId: "classic-admin" }, r.a.id, r.a);
      await entered.promise; if (outcome === "revoked") admin = false; release.resolve(); await running;
      expect(r.ipc.send).toHaveBeenCalledTimes(outcome === "live" ? 1 : 0);
    });
  }
});

it("same-number topics in another world do not replace the selector's source mapping", async () => {
  const r = rig();
  r.fm.fleetConfig!.instances = { peer: { working_directory: dirs.at(-1)!, topic_id: 10, channel_id: r.b.id }, ...r.fm.fleetConfig!.instances };
  r.fm.routing.rebuild(r.fm.fleetConfig!);
  const { apply, click } = seedMenu(r, "model", "worker", "10", "10");
  await click(); await Promise.resolve(); await Promise.resolve();
  expect(apply).toHaveBeenCalledOnce();
});

for (const state of ["false", "throw", "disconnected", "group move"] as const) {
  it(`clear after an unavailable ${state} authority/connection does not send`, async () => {
    const r = rig(); const callback = await clearPrompt(r); const entered = deferred(); const release = deferred();
    r.a.editMessageRemoveButtons.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const running = r.any.handleClearConfirmation(callback, r.a.id, r.a); await entered.promise;
    if (state === "false") vi.spyOn(r.any, "isModelAdmin").mockReturnValue(false);
    if (state === "throw") vi.spyOn(r.any, "isModelAdmin").mockImplementation(() => { throw new Error("authority unavailable"); });
    if (state === "disconnected") r.ipc.connected = false;
    if (state === "group move") r.fm.fleetConfig!.channels![0].group_id = "-100new";
    release.resolve(); await running;
    expect(r.ipc.send).not.toHaveBeenCalled();
  });
}
