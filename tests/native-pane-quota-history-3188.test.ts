/** Native startup shares the quota scanner; provider history must come from the owned runner. */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import { createNativePaneBackend } from "../src/backend/native-pane.js";
const MESSAGE = "You’ve hit your usage limit. Try again at 8:59 AM.";
const ready = (message = MESSAGE) => `■ ${message}\n\n› Ask Codex to do anything\n  Context 100% left`;
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(disposition: "resumed" | "reattached" | "fresh" = "resumed", provider: "codex" | "claude-code" = "codex") {
  const dir = mkdtempSync(join(tmpdir(), "agend-native-quota-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const sessionId = randomUUID(), paneId = randomUUID(); let text = ready(), valid = true;
  const forbidden = vi.fn(() => { throw Error("Coordinator host/provider access is forbidden"); });
  const pane = { getWindowId: () => paneId, getPaneStatus: async () => ({ alive: true }), capturePane: vi.fn(async () => text),
    capturePaneWithHistory: async () => text, pipeOutput: async () => {}, killWindow: forbidden, sendSpecialKey: forbidden };
  const source = { initialize: async () => {}, poll: async () => ({ toolUses: [], toolResults: [], assistantTexts: [] }),
    close() {}, reset() {}, currentPath: () => null, following: () => true, turnStateKnown: () => true };
  const observation = Object.assign(new EventEmitter(), { start() {}, stop() {}, registerWindow: async () => {}, unregisterWindow() {},
    getObservationResetAt: () => Date.now(), isObservationBlind: () => false, isIdle: () => true, getLastOutputAt: () => undefined, hasOutputSince: () => false });
  const backend = createNativePaneBackend(provider, () => ({ sessionId, contextPercentage: null, statusLineItems: ["context-remaining"], resumes: disposition !== "fresh" }));
  const native = { backend, host: { executionHost: "remote", bind: forbidden, ensureSession: forbidden, getPanePid: forbidden }, observation,
    acquire: async () => ({ pane, source, disposition }), release: async () => {}, checkpointSession() {}, mcpProof: () => "unknown", current: () => valid,
    quotaReplayHistory: vi.fn(() => disposition === "fresh" ? null : { messages: [MESSAGE], current: () => valid }) };
  const daemon: any = new Daemon("native-quota", { ...structuredClone(DEFAULT_INSTANCE_CONFIG), working_directory: "C:\\runner-only",
    runtime: "windows", backend: provider, agent_mode: "mcp", log_level: "error" }, dir, true, backend, undefined, pino({ level: "silent" }) as never);
  daemon.setNativePaneLifecycle(native as never); cleanup.push(() => daemon.abortStartup());
  const quota: any[] = []; daemon.on("pty_error", (error: any) => { if (error.type === "quota") quota.push(error); });
  const scan = () => daemon.evaluateErrorPatterns(text, backend.getErrorPatterns!(), backend.getReadyPattern(), Date.now() + 60_000);
  return { daemon, native, pane, forbidden, quota, scan, setText: (value: string) => { text = value; }, revoke: () => { valid = false; } };
}
it.each(["resumed", "reattached"] as const)("native %s uses only the runner's old quota proof", async disposition => {
  const f = fixture(disposition); await f.daemon.start(); f.scan(); expect(f.quota).toEqual([]);
  expect(f.native.quotaReplayHistory).toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
  f.setText(ready() + "\n" + ready(MESSAGE.replace("8:59", "9:59"))); f.scan();
  expect(f.quota).toEqual([expect.objectContaining({ action: "pause" })]);
});
it("a fresh native launch has no historical quota exemption", async () => {
  const f = fixture("fresh"); await f.daemon.start(); f.scan(); expect(f.quota).toEqual([expect.objectContaining({ action: "pause" })]);
});
it("a changed runner proof cannot absorb the restored row", async () => {
  const f = fixture(); f.native.quotaReplayHistory.mockImplementation(() => ({ messages: [MESSAGE], current: () => false }));
  await f.daemon.start(); f.scan(); expect(f.quota).toEqual([expect.objectContaining({ action: "pause" })]);
});

it("an old runner with no quota metadata grants no startup exemption", async () => {
  const f = fixture(); f.native.quotaReplayHistory.mockReturnValue(null);
  await f.daemon.start(); f.scan(); expect(f.quota).toEqual([expect.objectContaining({ action: "pause" })]);
});
it.each(["spawnGeneration", "launchFenceEpoch", "launchAttempt"])("reattach capture cannot seed history after %s changes", async field => {
  const f = fixture("reattached"); let release!: (value: string) => void;
  f.pane.capturePane.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  const start = f.daemon.start(); await vi.waitFor(() => expect(f.pane.capturePane).toHaveBeenCalled());
  f.daemon[field]++; release(ready()); await start; f.scan();
  expect(f.quota).toEqual([expect.objectContaining({ action: "pause" })]); expect(f.native.quotaReplayHistory).not.toHaveBeenCalled();
});

it.each([true, false])("a guarded native system input absorbs prior quota only after acknowledged Enter (%s)", async acknowledged => {
  const f = fixture(); f.native.quotaReplayHistory.mockReturnValue(null); await f.daemon.start();
  f.daemon.tmux.pasteBuffer = vi.fn(async () => true);
  f.daemon.sendDeliveryEnter = vi.fn(async () => acknowledged); f.daemon.confirmSubmitted = vi.fn(async () => "submitted");
  vi.useFakeTimers(); const paste = f.daemon.submitSystemPaste("next", "fixture", { current: () => true, accept: () => true });
  await vi.advanceTimersByTimeAsync(1000); expect(await paste).toBe(acknowledged); f.scan();
  expect(f.quota).toEqual(acknowledged ? [] : [expect.objectContaining({ action: "pause" })]);
});

it("native history is consumed once, even if another startup scan sees the same words after history scrolled out", async () => {
  const f = fixture(); await f.daemon.start(); f.scan(); expect(f.quota).toEqual([]);
  f.setText("› Ask Codex to do anything\n  Context 100% left"); f.scan();
  f.setText(ready()); await f.daemon.dismissDialogsUntilReady(15, 0); f.scan();
  expect(f.quota).toEqual([expect.objectContaining({ action: "pause" })]);
});

it("Claude reattachment does not run a Codex history lookup or startup scan", async () => {
  const f = fixture("reattached", "claude-code");
  f.native.quotaReplayHistory.mockImplementation(() => { throw Error("No Codex history on Claude"); });
  const scan = vi.spyOn(f.daemon, "finishStartupScan").mockImplementation(() => { throw Error("No startup scan on reattachment"); });
  await f.daemon.start(); expect(scan).not.toHaveBeenCalled(); expect(f.native.quotaReplayHistory).not.toHaveBeenCalled();
});

it.each(["resumed", "reattached", "fresh"] as const)("guarded native %s input counts the real same-count replacement once", async disposition => {
  const f = fixture(disposition); await f.daemon.start();
  const before = readFileSync(new URL("./fixtures/codex-0165-same-count-before.pane.txt", import.meta.url), "utf8");
  const after = readFileSync(new URL("./fixtures/codex-0165-same-count-after.pane.txt", import.meta.url), "utf8");
  f.setText(before);
  f.daemon.tmux.pasteBuffer = vi.fn(async () => true);
  f.daemon.sendDeliveryEnter = vi.fn(async () => true);
  f.daemon.confirmSubmitted = vi.fn(async () => "submitted");
  vi.useFakeTimers();
  const input = f.daemon.submitSystemPaste("Q-NEW-LIMIT-d702cfa6", "same-count-native", { current: () => true, accept: () => true });
  await vi.advanceTimersByTimeAsync(1000); expect(await input).toBe(true);
  f.scan(); expect(f.quota).toEqual([]);
  f.setText(after); f.scan(); f.scan();
  expect(f.quota).toEqual([expect.objectContaining({ action: "pause" })]);
  expect(f.daemon.tmux.pasteBuffer).toHaveBeenCalledOnce();
  expect(f.daemon.sendDeliveryEnter).toHaveBeenCalledOnce();
});
