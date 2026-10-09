import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { installKiroCompatibilityFixture } from "./helpers/kiro-process-stub.js";

// Real menus, config effects, cached Daemon ownership and lifecycle admission.
// Backend construction, persistence, IPC and every platform effect are inert.
vi.mock("../src/backend/factory.js", () => ({ createBackend: () => ({
  binaryName: "codex", getModelSwitchStrategy: () => "runtime",
  getEffortStrategy: () => "runtime", getEffortLevels: () => ["high"],
}) }));
installKiroCompatibilityFixture();
const GROUP = "-1001462";
const rigs: Array<{ dir: string; any: any }> = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    for (const map of [r.any.pendingModelSelects, r.any.pendingEffortSelects]) {
      for (const entry of map.values()) clearTimeout(entry.timer);
    }
    rmSync(r.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function rig(type: "telegram" | "discord" = "telegram") {
  const dir = mkdtempSync(join(tmpdir(), "agend-generation-fence-"));
  const fm = new FleetManager(dir), any = fm as any;
  const adapter = {
    id: "owner", type,
    notifyAlert: vi.fn(async (chatId: string, _alert: unknown, opts?: { threadId?: string }) =>
      ({ messageId: "prompt", chatId, threadId: opts?.threadId })),
    promptUser: vi.fn(async (_chat: string, _text: string, _choices: Array<{ id: string }>, _options?: unknown) => "menu"),
    editMessageRemoveButtons: vi.fn(async () => {}), editMessage: vi.fn(async () => {}),
    sendText: vi.fn(async () => ({ messageId: "notice", chatId: GROUP })),
  };
  fm.fleetConfig = { defaults: { backend: "codex" }, channels: [{
    id: adapter.id, type, mode: "topic", group_id: GROUP, bot_token_env: "TEST_TOKEN",
    access: { mode: "locked", allowed_users: ["admin"] },
  }], instances: { worker: { working_directory: dir, channel_id: adapter.id, topic_id: 10, backend: "codex" } } } as any;
  fm.adapter = adapter as any;
  fm.worlds.set(adapter.id, { id: adapter.id, adapter, channelConfig: fm.fleetConfig!.channels![0] } as any);
  fm.routing.rebuild(fm.fleetConfig!);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("worker", fm.fleetConfig!.instances.worker, dir, false,
    undefined, undefined, { child: () => logger } as any);
  any.daemons.set("worker", daemon);
  const send = vi.fn();
  fm.instanceIpcClients.set("worker", { connected: true, send } as any);
  const save = vi.spyOn(any, "saveFleetConfig").mockImplementation(() => {});
  vi.spyOn(any, "getModelOptions").mockResolvedValue([{ id: "gpt-5.5", label: "gpt-5.5" }]);
  vi.spyOn(any, "effortLevelsFor").mockReturnValue(["high"]);
  const r = { dir, fm, any, adapter, daemon, send, save }; rigs.push(r); return r;
}
async function holdClear(r: ReturnType<typeof rig>) {
  await r.fm.promptClearConfirmation("worker", "10", r.adapter as any, GROUP, "10");
  const alert = r.adapter.notifyAlert.mock.calls[0][1] as any;
  const entered = deferred(), release = deferred();
  r.adapter.editMessageRemoveButtons.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
  const running = r.any.handleClearConfirmation({
    callbackData: alert.choices[0].id, chatId: GROUP, threadId: "10", messageId: "prompt", userId: "admin",
  }, r.adapter.id, r.adapter);
  await entered.promise;
  return { release, running };
}

describe("#1462 clear keeps actual launch and queued lifecycle generations", () => {
  for (const change of ["respawn", "freeze", "queued stop"] as const) {
    it(`does not send when ${change} changes the same daemon during retirement`, async () => {
      const r = rig(), held = await holdClear(r);
      const before = r.daemon.getInteractionSnapshot().owner;
      let finish = async () => {};
      if (change === "respawn") { (r.daemon as any).beginSpawn(); (r.daemon as any).endSpawn(); }
      if (change === "freeze") (r.daemon as any).freezeRuntimeMonitors();
      if (change === "queued stop") {
        const queue = deferred(), entered = deferred();
        vi.spyOn(r.any.lifecycle, "stopInTransition").mockResolvedValue(undefined);
        const blocked = r.any.lifecycle.runTransition("worker", async () => { entered.resolve(); await queue.promise; });
        await entered.promise;
        const stop = r.any.lifecycle.stop("worker");
        finish = async () => { queue.resolve(); await blocked; await stop; };
      } else expect(r.daemon.getInteractionSnapshot().owner).not.toEqual(before);
      held.release.resolve(); await held.running; await finish();
      expect(r.any.daemons.get("worker")).toBe(r.daemon);
      expect(r.send).not.toHaveBeenCalled();
    });
  }
  for (const recovered of [false, true]) {
    it(`allows an unchanged ${recovered ? "already recovered" : "initial"} generation once`, async () => {
      const r = rig();
      if (recovered) { (r.daemon as any).beginSpawn(); (r.daemon as any).endSpawn(); }
      const held = await holdClear(r); held.release.resolve(); await held.running;
      expect(r.send).toHaveBeenCalledExactlyOnceWith({ type: "raw_paste", content: "/clear" });
    });
  }
  for (const field of ["bootId", "launchAttempt"] as const) {
    it(`rejects a changed cached ${field} with otherwise stable owners`, async () => {
      const r = rig(), held = await holdClear(r);
      if (field === "bootId") (r.daemon as any).bootId = "replacement-boot";
      else (r.daemon as any).launchAttempt++;
      held.release.resolve(); await held.running;
      expect(r.send).not.toHaveBeenCalled();
    });
  }
  for (const unavailable of ["missing", "throw", "malformed", "lifecycle"] as const) {
    for (const when of ["at claim", "after retirement"] as const) {
      it(`refuses ${unavailable} ownership ${when}`, async () => {
        const r = rig();
        const lose = () => {
          if (unavailable === "lifecycle") vi.spyOn(r.any.lifecycle, "epochOf").mockImplementation(() => { throw new Error("unavailable"); });
          else if (unavailable === "throw") vi.spyOn(r.daemon, "getInteractionSnapshot").mockImplementation(() => { throw new Error("unavailable"); });
          else vi.spyOn(r.daemon, "getInteractionSnapshot").mockReturnValue(unavailable === "missing" ? undefined as any
            : { ...r.daemon.getInteractionSnapshot(), owner: { bootId: "", spawnGeneration: undefined } } as any);
        };
        if (when === "at claim") lose();
        const held = await holdClear(r);
        if (when === "after retirement") lose();
        held.release.resolve(); await held.running;
        expect(r.send).not.toHaveBeenCalled();
      });
    }
  }
});

async function menu(r: ReturnType<typeof rig>, kind: "model" | "effort") {
  await r.fm[kind === "model" ? "promptModelMenu" : "promptEffortMenu"](
    "worker", "admin", "10", r.adapter as any, GROUP, "10", r.adapter.id);
  const choices = r.adapter.promptUser.mock.calls[0][2] as unknown as Array<{ id: string }>;
  const choice = choices.find(c => c.id.endsWith(kind === "model" ? ":gpt-5.5" : ":high"))!;
  return () => r.any[kind === "model" ? "handleModelSelection" : "handleEffortSelection"]({
    callbackData: choice.id, chatId: GROUP, threadId: "10", messageId: "menu", userId: "admin", ack: vi.fn(),
  }, r.adapter.id);
}
describe("#1462 real selectors retain the source group and reject duplicate mappings", () => {
  for (const kind of ["model", "effort"] as const) {
    for (const when of ["before click", "during progress"] as const) {
      it(`${kind}: a group rebind ${when} cannot mutate through the old menu`, async () => {
        const r = rig(), click = await menu(r, kind);
        const entered = deferred(), release = deferred();
        const move = () => { r.fm.fleetConfig!.channels![0].group_id = "-100replacement"; };
        if (when === "before click") move();
        else r.adapter.editMessageRemoveButtons.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
        const running = click();
        if (when === "during progress") { await entered.promise; move(); release.resolve(); }
        await running;
        expect(r.fm.fleetConfig!.instances.worker[kind]).toBeUndefined();
        expect(r.save).not.toHaveBeenCalled(); expect(r.send).not.toHaveBeenCalled();
      });
    }
    it(`${kind}: the current Discord resolver replaces the old duplicate target`, async () => {
      const r = rig("discord"), click = await menu(r, kind);
      r.fm.fleetConfig!.instances.reassigned = { ...r.fm.fleetConfig!.instances.worker };
      r.fm.routing.rebuild(r.fm.fleetConfig!);
      expect(r.any.resolveSlashTarget("10", r.adapter.id)).toBe("reassigned");
      await click();
      expect(r.fm.fleetConfig!.instances.worker[kind]).toBeUndefined();
      expect(r.save).not.toHaveBeenCalled(); expect(r.send).not.toHaveBeenCalled();
    });
    it(`${kind}: a Classic registration remains first even with duplicate fleet topics`, async () => {
      const r = rig(), click = await menu(r, kind);
      r.fm.fleetConfig!.instances.reassigned = { ...r.fm.fleetConfig!.instances.worker };
      r.fm.routing.rebuild(r.fm.fleetConfig!);
      r.any.classicChannels = { getInstanceByChannel: (channel: string, adapter: string) =>
        channel === "10" && adapter === r.adapter.id ? "worker" : undefined };
      await click();
      expect(r.fm.fleetConfig!.instances.worker[kind]).toBe(kind === "model" ? "gpt-5.5" : "high");
      expect(r.save).toHaveBeenCalledOnce(); expect(r.send).toHaveBeenCalledOnce();
    });
    for (const type of ["telegram", "discord"] as const) {
      it(`${kind}: an unchanged ${type} real menu persists and sends once`, async () => {
        const r = rig(type), click = await menu(r, kind); await click();
        expect(r.fm.fleetConfig!.instances.worker[kind]).toBe(kind === "model" ? "gpt-5.5" : "high");
        expect(r.save).toHaveBeenCalledOnce(); expect(r.send).toHaveBeenCalledOnce();
      });
    }
  }
});
