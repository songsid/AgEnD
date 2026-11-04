/**
 * #1490 row 27: a hang/exit Restart button and a /model or /effort menu act for ONE lifecycle of an instance. Each
 * pins the lifecycle epoch (moved on by every stop, restart and removal — a same-name replacement included) and asks
 * it after every await before acting by name; the restart itself asks it once more before it invalidates anything.
 *
 * "Replaced" is modelled by what a stop/removal does synchronously: lifecycle.invalidate(name). The real
 * restartSingleInstance runs; only its transition (the stop+spawn) is stubbed, so "restarted" = a transition was run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager, RestartSupersededError } from "../src/fleet-manager.js";
import { t } from "../src/locale.js";

const dirs: string[] = [];
const timers: Array<ReturnType<typeof setTimeout>> = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function held() {
  let release!: () => void, entered!: () => void;
  const released = new Promise<void>(r => { release = r; });
  const reached = new Promise<void>(r => { entered = r; });
  return { release, reached, impl: async () => { entered(); await released; } };
}

function rig(backend = "codex") {
  const dir = mkdtempSync(join(tmpdir(), "agend-1490-r27-")); dirs.push(dir);
  const adapter = {
    id: "telegram-main", type: "telegram",
    sendText: vi.fn().mockResolvedValue({ messageId: "notice", chatId: "fleet-group" }),
    notifyAlert: vi.fn().mockResolvedValue({ messageId: "prompt", chatId: "fleet-group", threadId: "worker-topic" }),
    promptUser: vi.fn().mockResolvedValue("menu"),
    editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
  const fm = new FleetManager(dir);
  const any = fm as any;
  fm.fleetConfig = {
    defaults: {},
    channels: [{ id: "telegram-main", type: "telegram", mode: "topic", group_id: "fleet-group", bot_token_env: "TEST_TOKEN",
      access: { mode: "locked", allowed_users: ["admin"] } }],
    instances: {
      general: { general_topic: true, topic_id: "general-topic", working_directory: dir },
      worker: { topic_id: "worker-topic", working_directory: dir, backend },
    },
  } as any;
  fm.adapter = adapter;
  fm.worlds.set("telegram-main", { id: "telegram-main", adapter, groupId: "fleet-group", channelConfig: fm.fleetConfig!.channels![0] } as any);
  // The restart's stop+spawn: what "it restarted" means here.
  const transitions = vi.spyOn(fm.lifecycle, "runTransition").mockResolvedValue(undefined as never);
  const replace = () => fm.lifecycle.invalidate("worker");          // what a stop/removal does first, synchronously
  return { fm, any, adapter, transitions, replace };
}

const click = (id: string, messageId = "prompt") => ({ callbackData: id, chatId: "fleet-group", threadId: "worker-topic", messageId, userId: "admin", ack: vi.fn() });
const lastEdit = (adapter: any) => adapter.editMessage.mock.calls.at(-1)?.[2];

describe("hang / clean-exit Restart: the lifecycle the click was for (#1490 row 27)", () => {
  const kinds = [
    { kind: "hang", post: (fm: FleetManager) => fm.sendHangNotification("worker"), handle: "handleHangPrompt" },
    // The clean-exit offer goes to a running General.
    { kind: "exit", post: (fm: FleetManager) => { fm.lifecycle.daemons.set("general", {} as any); return fm.notifyNormalExit("worker"); }, handle: "handleExitRestartPrompt" },
  ] as const;
  for (const k of kinds) {
    it(`${k.kind}: the instance replaced while the buttons are being retired — nothing restarted, said so`, async () => {
      const { fm, any, adapter, transitions, replace } = rig();
      await k.post(fm);
      const id = adapter.notifyAlert.mock.calls[0][1].choices[0].id as string;
      const gate = held();
      adapter.editMessageRemoveButtons.mockImplementationOnce(gate.impl);
      const running = any[k.handle](click(id), "telegram-main");
      await gate.reached;
      replace();                                                    // a same-name replacement during the await
      gate.release();
      await running;
      expect(transitions).not.toHaveBeenCalled();
      expect(lastEdit(adapter)).toBe(t("restart.superseded", "worker"));
    });
    it(`${k.kind}: unchanged — the click restarts it (control)`, async () => {
      const { fm, any, adapter, transitions } = rig();
      await k.post(fm);
      const id = adapter.notifyAlert.mock.calls[0][1].choices[0].id as string;
      await any[k.handle](click(id), "telegram-main");
      expect(transitions).toHaveBeenCalledOnce();
    });
  }
});

describe("restartSingleInstance's owner fence (#1490 row 27)", () => {
  it("a fence that no longer holds: refused before anything is invalidated", async () => {
    const { fm, transitions } = rig();
    const before = fm.lifecycle.epochOf("worker");
    await expect(fm.restartSingleInstance("worker", { explicit: true, ownerCurrent: () => false })).rejects.toBeInstanceOf(RestartSupersededError);
    expect(fm.lifecycle.epochOf("worker")).toBe(before);           // a start in flight for the replacement is untouched
    expect(transitions).not.toHaveBeenCalled();
  });
  it("the pin: a stop, restart or removal of the name ends it; nothing else does", () => {
    const { any, replace } = rig();
    const pin = any.lifecyclePin("worker");
    const other = any.lifecyclePin("general");
    expect(pin()).toBe(true);
    replace();
    expect([pin(), other()]).toEqual([false, true]);
    expect(any.lifecyclePin("worker")()).toBe(true);                // the replacement's own pin
  });
});

describe("/effort and /model menus: the lifecycle the menu was offered to (#1490 row 27)", () => {
  async function effortMenu() {
    const r = rig();
    vi.spyOn(r.any, "effortLevelsFor").mockReturnValue(["low", "high"]);
    vi.spyOn(r.any, "menuClickStillCurrent").mockReturnValue(true);
    const apply = vi.spyOn(r.fm, "applyEffort");
    expect(await r.fm.promptEffortMenu("worker", "admin", "worker-topic", r.adapter, "fleet-group", "worker-topic", "telegram-main")).toBeNull();
    const ids = r.adapter.promptUser.mock.calls[0][2].map((c: { id: string }) => c.id) as string[];
    const high = ids.find(id => id.endsWith(":high"))!;
    for (const tm of r.any.pendingEffortSelects.values()) timers.push(tm.timer);
    return { ...r, apply, select: () => r.any.handleEffortSelection(click(high, "menu"), "telegram-main") };
  }
  const settle = () => new Promise(res => setTimeout(res, 20));

  it("effort: replaced between the menu and the click — not applied, the menu says why", async () => {
    const { apply, replace, select, adapter } = await effortMenu();
    replace();
    await select(); await settle();
    expect(apply).not.toHaveBeenCalled();
    expect(adapter.sendText).toHaveBeenCalledWith("fleet-group", t("menu.instance_replaced", "worker"), { threadId: "worker-topic" });
  });
  it("effort: replaced during the progress edit — not applied", async () => {
    const { apply, replace, select, adapter } = await effortMenu();
    const gate = held();
    adapter.editMessageRemoveButtons.mockImplementationOnce(gate.impl);
    const running = select();
    await gate.reached; replace(); gate.release();
    await running; await settle();
    expect(apply).not.toHaveBeenCalled();
    expect(lastEdit(adapter)).toBe(t("menu.instance_replaced", "worker"));
  });
  it("effort: unchanged — applied, with the pin carried into the restart (control)", async () => {
    const { apply, select } = await effortMenu();
    apply.mockResolvedValue("APPLIED");
    await select(); await settle();
    expect(apply).toHaveBeenCalledExactlyOnceWith("worker", "high", { current: expect.any(Function) });
    expect(apply.mock.calls[0][2]!.current!()).toBe(true);
  });

  it("applyEffort (restart backend): a pin that ended is refused before the config is touched", async () => {
    const { fm, transitions } = rig("claude-code");
    const save = vi.spyOn(fm as any, "saveFleetConfig").mockImplementation(() => {});
    expect(await fm.applyEffort("worker", "high", { current: () => false })).toBe(t("menu.instance_replaced", "worker"));
    expect(save).not.toHaveBeenCalled();
    expect(transitions).not.toHaveBeenCalled();
  });

  it("applyModel (claude runtime switch): replaced while the switch is answering — nothing saved for the replacement", async () => {
    const { fm, any, replace } = rig("claude-code");
    fm.instanceIpcClients.set("worker", { connected: true, send: vi.fn() } as any);
    vi.spyOn(any, "claudeModelKnown").mockReturnValue({ known: true, names: [] });
    const gate = held();
    vi.spyOn(any, "runRuntimeModelSwitch").mockImplementation(async () => { await gate.impl(); return { outcome: "switched", confirmed: true }; });
    const persist = vi.spyOn(any, "persistInstanceModel").mockReturnValue(true);
    const running = fm.applyModel("worker", "claude-opus-5-5", { current: any.lifecyclePin("worker") });
    await gate.reached; replace(); gate.release();
    expect(await running).toBe(t("menu.instance_replaced", "worker"));
    expect(persist).not.toHaveBeenCalled();
  });

  it("applyModel (restart): the pin travels into the restart, which refuses a replaced instance", async () => {
    const { fm, any, replace, transitions } = rig("codex");
    vi.spyOn(any, "persistInstanceModel").mockImplementation(() => { replace(); return true; });   // replaced at the last step
    await expect(fm.applyModel("worker", "gpt-5.5", { current: any.lifecyclePin("worker") })).rejects.toBeInstanceOf(RestartSupersededError);
    expect(transitions).not.toHaveBeenCalled();
  });
});
