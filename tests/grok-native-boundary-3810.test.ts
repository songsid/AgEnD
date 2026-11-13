/** Alpha only: an exact local Grok lease never becomes proof for a Windows Runtime pane. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { consumedWatches } from "../src/delivery-consumed-watch.js";
const roots: string[] = [];
afterEach(() => { consumedWatches.stopAll(); vi.restoreAllMocks(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
it("refuses a local Grok checkpoint on a native pane, without opening a local proof reader", () => {
  const p = mkdtempSync(join(tmpdir(), "grok-native3810-")); roots.push(p); const instance = join(p, "instance"); mkdirSync(instance);
  const log: any = { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } };
  const d: any = new Daemon("worker", { working_directory: p, backend: "grok" } as any, instance, false, undefined as any, undefined as any, log);
  d.nativePaneLifecycle = {};
  const markConsumed = vi.fn(), readChunk = vi.fn(); d.setDeliveryOutboxPort({ complete: vi.fn(), markConsumed });
  const start = vi.spyOn(consumedWatches, "start").mockReturnValue(true);
  d.finishDurableDelivery({ deliveryId: "3810", attemptNo: 1 }, "uncertain", "unproven", { submissionMode: "idle_submit", transcriptCheckpoint: { backend: "grok", path: "/host/updates.jsonl", offset: 0, ownedGrok: { sessionId: "4b388fc1-2601-4552-bd03-4a6e2edcf8e0", current: () => true, readChunk } } });
  expect(start).not.toHaveBeenCalled(); expect(readChunk).not.toHaveBeenCalled(); expect(markConsumed).not.toHaveBeenCalled();
});
it("does not even ask the host backend for a delivery session when preparing a native paste", async () => {
  const p = mkdtempSync(join(tmpdir(), "grok-native3810-")); roots.push(p); const instance = join(p, "instance"); mkdirSync(instance);
  const log: any = { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } };
  const getDeliverySessionId = vi.fn(() => null);
  const d: any = new Daemon("worker", { working_directory: p, backend: "grok" } as any, instance, false, undefined as any, undefined as any, log);
  d.nativePaneLifecycle = {}; d.backend = { getDeliverySessionId }; d.tmux = {};
  vi.spyOn(d, "capturePaneEvidence").mockResolvedValue(null);
  vi.spyOn(d, "paneInTmuxMode").mockResolvedValue(false);
  vi.spyOn(d, "durableAttemptEvidence").mockResolvedValue({ backend: "grok", backendVersion: null, windowId: "@w", transcriptPath: null, transcriptOffset: null, transcriptSessionId: null, submissionMode: "idle_submit" });
  d.setDeliveryOutboxPort({ begin: () => "begun" });
  await expect(d.writeMessageToPane("fixture", "@w", false, undefined, undefined, { reached: false }, { deliveryId: "3810", attemptNo: 1 }, false, () => true, undefined, () => { throw new Error("native before paste"); })).rejects.toThrow("native before paste");
  expect(getDeliverySessionId).not.toHaveBeenCalled();
});
