import { EventEmitter } from "node:events";
import { writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { captureSessionOomRetry, clearSessionOomStopForRetry, readSessionOomStop, writeSessionOomStop } from "../src/session-oom-stop.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { selfEvidence } from "./helpers/self-oom-evidence.js";
let root: string, fm: FleetManager;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-oom-actions-")); });
afterEach(() => { fm?.clearNoncePromptsForInstance("worker"); fm?.spawnGate?.shutdown(); fm?.memoryPressure?.stop(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function setup() {
  const notifyAlert = vi.fn(async () => ({ messageId: "offer", chatId: "group", threadId: "general-topic" }));
  const editMessageRemoveButtons = vi.fn(async () => {});
  const adapter: any = { id: "telegram", type: "telegram", sendText: vi.fn(async () => ({ messageId: "notice", chatId: "group" })), notifyAlert, editMessageRemoveButtons, editMessage: vi.fn(async () => {}) };
  fm = new FleetManager(root); fm.fleetConfig = { defaults: {}, channels: [{ id: "telegram", type: "telegram", mode: "topic", group_id: "group", access: { mode: "locked", allowed_users: ["admin"] } }], instances: {
    general: { general_topic: true, topic_id: "general-topic", working_directory: root }, worker: { topic_id: "worker-topic", working_directory: root },
  } } as any;
  fm.adapter = adapter; fm.worlds.set("telegram", { id: "telegram", adapter, groupId: "group", channelConfig: fm.fleetConfig!.channels![0] } as any);
  fm.lifecycle.daemons.set("general", {} as any);
  const dir = fm.getInstanceDir("worker"); mkdirSync(dir, { recursive: true });
  const stop = () => writeSessionOomStop(dir, { owner: { bootId: "b", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 }, configuration: "a".repeat(64), sessionKey: "session", stoppedAt: Date.now(), count: 2, victim: { pid: 123, at: Date.now() }, evidence: selfEvidence() });
  stop();
  const click = (id: string, userId = "admin") => (fm as any).handleExitRestartPrompt({ callbackData: id, chatId: "group", threadId: "general-topic", messageId: "offer", userId }, "telegram");
  return { notifyAlert, editMessageRemoveButtons, stop, dir, click };
}
it.each([0, 1])("offers evidence and admin-only exactly-once Resume/Fresh (%i)", async action => {
  const h = setup(); const restart = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue();
  await fm.notifySessionOomStop("worker");
  const alert = h.notifyAlert.mock.calls[0] as any;
  expect(alert[1].message).toContain("60% of RAM"); expect(alert[1].message).toContain("6.0×");
  const choices = alert[1].choices;
  expect(choices.map((x: any) => x.label)).toEqual(["Resume", "Fresh session"]);
  const prompts = (fm as any).needsYouPrompts();
  const items = deriveNeedsYou({ prompts, instances: [], deliveries: [], ownerOf: () => "telegram" });
  expect(items).toHaveLength(1); expect(items[0]?.detail).toContain("self-caused"); expect(items[0]?.actions).toHaveLength(2);
  await h.click(choices[action].id, "stranger"); expect(restart).not.toHaveBeenCalled();
  await h.click(choices[action].id); await h.click(choices[action].id);
  expect(restart).toHaveBeenCalledTimes(1);
  expect(restart).toHaveBeenCalledWith("worker", { explicit: true, freshStart: action === 1, sessionOomRetry: captureSessionOomRetry(h.dir) });
});
it("carries the offered revision through async retirement, refusing a newer stop before invalidation", async () => {
  const h = setup(); await fm.notifySessionOomStop("worker");
  vi.spyOn(fm.lifecycle, "runTransition").mockRejectedValue(new Error("inert transition boundary"));
  let invalidated = false; vi.spyOn(fm.lifecycle, "invalidate").mockImplementation(() => { invalidated = true; });
  h.editMessageRemoveButtons.mockImplementation(async () => { clearSessionOomStopForRetry(h.dir, captureSessionOomRetry(h.dir)); h.stop(); });
  const choices = (h.notifyAlert.mock.calls[0] as any)[1].choices;
  await h.click(choices[0].id);
  expect(invalidated).toBe(false); expect(readSessionOomStop(h.dir).blocked).toBe(true);
});

it("also offers controls for a safely stored positive history fallback", async () => {
  const h = setup(); unlinkSync(join(h.dir, "session-oom-stop.json"));
  writeFileSync(join(h.dir, "crash-history.jsonl"), JSON.stringify({ instance: "worker", timestamp: new Date(100).toISOString(), crashType: "window", reason: "session_oom", oomEvidence: selfEvidence() }) + "\n");
  await fm.notifySessionOomStop("worker");
  expect(h.notifyAlert).toHaveBeenCalledTimes(1);
  expect((h.notifyAlert.mock.calls[0] as any)[1].choices).toHaveLength(2);
});

it("a current real lifecycle OOM stop publishes actions, while a replaced owner cannot", async () => {
  const h = setup();
  const daemon = new EventEmitter(); fm.lifecycle.daemons.set("worker", daemon as any);
  fm.lifecycle.attachIncidentHandlers("worker", daemon as any);
  daemon.emit("supervision_ended", { name: "worker", reason: "self caused", remedy: "retry", cause: "session_oom" });
  await vi.waitFor(() => expect(h.notifyAlert).toHaveBeenCalledTimes(1));
  expect((h.notifyAlert.mock.calls[0] as any)[1].choices).toHaveLength(2);
  fm.clearNoncePromptsForInstance("worker");
  fm.lifecycle.daemons.set("worker", new EventEmitter() as any);
  daemon.emit("supervision_ended", { name: "worker", reason: "self caused", remedy: "retry", cause: "session_oom" });
  await Promise.resolve();
  expect(h.notifyAlert).toHaveBeenCalledTimes(1);
});

it.each([0, 1])("unknown-cause breaker offers honest admin Resume/Fresh (%i), bound to the stopped launch", async action => {
  const h = setup(); unlinkSync(join(h.dir, "session-oom-stop.json"));
  const owner = { bootId: "unknown-boot", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 };
  const daemon = Object.assign(new EventEmitter(), { isUnclearOomStopped: () => true, getInteractionSnapshot: () => ({ owner }) });
  fm.lifecycle.daemons.set("worker", daemon as any);
  fm.lifecycle.attachIncidentHandlers("worker", daemon as any);
  const restart = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue();
  daemon.emit("supervision_ended", { name: "worker", cause: "oom_unclear", reason: "out of memory, cause unclear", remedy: "retry", exitCode: 137 });
  await vi.waitFor(() => expect(h.notifyAlert).toHaveBeenCalledTimes(1));
  const alert = (h.notifyAlert.mock.calls[0] as any)[1];
  expect(alert.message).toContain("out of memory, cause unclear"); expect(alert.message).not.toContain("self-caused");
  expect(alert.choices.map((c: any) => c.label)).toEqual(["Resume", "Fresh session"]);
  const items = deriveNeedsYou({ prompts: (fm as any).needsYouPrompts(), instances: [], deliveries: [], ownerOf: () => "telegram" });
  expect(items[0]?.detail).toContain("cause unclear"); expect(items[0]?.actions).toHaveLength(2);
  await h.click(alert.choices[action].id, "stranger"); expect(restart).not.toHaveBeenCalled();
  await h.click(alert.choices[action].id); await h.click(alert.choices[action].id);
  expect(restart).toHaveBeenCalledTimes(1);
  const opts = restart.mock.calls[0]![1]!;
  expect(opts).toMatchObject({ explicit: true, freshStart: action === 1 });
  expect(opts.recoveryCurrent?.()).toBe(true);
  owner.spawnGeneration++;
  expect(opts.recoveryCurrent?.()).toBe(false);
});
it("an unknown-cause action cannot invalidate a replacement launch during asynchronous button retirement", async () => {
  const h = setup(); unlinkSync(join(h.dir, "session-oom-stop.json"));
  const owner = { bootId: "unknown-boot", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 };
  const daemon = { isUnclearOomStopped: () => true, getInteractionSnapshot: () => ({ owner: { ...owner } }) };
  fm.lifecycle.daemons.set("worker", daemon as any);
  await fm.notifySessionOomStop("worker", true);
  const invalidated = vi.spyOn(fm.lifecycle, "invalidate").mockImplementation(() => {});
  vi.spyOn(fm.lifecycle, "runTransition").mockRejectedValue(Error("forbidden transition"));
  h.editMessageRemoveButtons.mockImplementation(async () => { owner.spawnGeneration++; });
  await h.click((h.notifyAlert.mock.calls[0] as any)[1].choices[0].id);
  expect(invalidated).not.toHaveBeenCalled();
});
it("a current unknown-cause action without a tombstone reaches the real serialized restart admission", async () => {
  const h = setup(); unlinkSync(join(h.dir, "session-oom-stop.json"));
  const owner = { bootId: "unknown-boot", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 };
  fm.lifecycle.daemons.set("worker", { isUnclearOomStopped: () => true, getInteractionSnapshot: () => ({ owner: { ...owner } }) } as any);
  await fm.notifySessionOomStop("worker", true);
  const invalidated = vi.spyOn(fm.lifecycle, "invalidate").mockImplementation(() => {});
  // Admission is real; the serialized external stop/start boundary stays inert.
  const transition = vi.spyOn(fm.lifecycle, "runTransition").mockRejectedValue(Error("inert transition boundary"));
  await h.click((h.notifyAlert.mock.calls[0] as any)[1].choices[0].id);
  expect(invalidated).toHaveBeenCalledWith("worker"); expect(transition).toHaveBeenCalledTimes(1);
});
