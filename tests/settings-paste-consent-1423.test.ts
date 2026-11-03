import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ calls: [] as string[][], loads: [] as Array<(err: Error | null) => void>, failFirst: false }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => { throw new Error("no real CLI probes"); }),
  execFile: vi.fn((file: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    if (file !== "tmux") throw new Error("no real subprocesses");
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (err: Error | null, out: string, error: string) => void;
    io.calls.push(args);
    if (args.includes("load-buffer")) {
      io.loads.push(err => cb(err, "", ""));
      if (io.failFirst && io.loads.length === 1) queueMicrotask(() => cb(Object.assign(new Error("inert fd pressure"), { code: "EMFILE" }), "", ""));
    } else queueMicrotask(() => cb(null, "", ""));
    return { stdin: { on() {}, end() {} } };
  }),
}));
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { SettingsExecution } from "../src/settings-transaction.js";

const roots: string[] = [], caps: SettingsExecution[] = [];
afterEach(() => {
  caps.splice(0).forEach(cap => cap.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  io.calls.length = 0; io.loads.length = 0; io.failFirst = false; vi.restoreAllMocks(); vi.useRealTimers();
});
function harness() {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-test-consent-native-paste-")); roots.push(root); mkdirSync(join(root, "instance"));
  const logger: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } };
  const daemon: any = new Daemon("worker", { working_directory: root, backend: "kiro-cli", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } } as any,
    join(root, "instance"), false, undefined, undefined, logger);
  let alive = true;
  const cap = new SettingsExecution({ current: () => alive, snapshot: () => null }); caps.push(cap);
  daemon.tmux = new TmuxManager("inert-session", "@1"); daemon.backend = {};
  daemon.buildSnapshotPrompt = vi.fn(() => "approved context"); daemon.capturePaneEvidence = vi.fn(async () => null);
  daemon.confirmSubmitted = vi.fn(async () => "submitted"); daemon.waitForInputTransientToClear = vi.fn(async () => true);
  const event = vi.fn(); daemon.on("snapshot_injected", event);
  return { daemon, cap, event, revoke: () => { alive = false; } };
}
const count = (step: string) => io.calls.filter(args => args.includes(step)).length;
describe("#1423 true snapshot submission through the staged tmux helper", () => {
  it("revoke while load-buffer is held: no paste or Enter, and the owned loaded buffer is deleted", async () => {
    const h = harness(), injecting = h.daemon.injectSnapshotMessage(() => h.cap.assert()).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(1000); expect(io.loads).toHaveLength(1);
    h.revoke(); io.loads[0]!(null); await vi.advanceTimersByTimeAsync(1000);
    await injecting;
    expect(count("paste-buffer")).toBe(0); expect(count("send-keys")).toBe(0); expect(count("delete-buffer")).toBe(1); expect(h.event).not.toHaveBeenCalled();
  });
  it("revoke during EMFILE backoff: no next load-buffer attempt or pane write", async () => {
    const h = harness(); io.failFirst = true;
    const injecting = h.daemon.injectSnapshotMessage(() => h.cap.assert()).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(1001); expect(io.loads).toHaveLength(1);
    h.revoke(); await vi.advanceTimersByTimeAsync(1000);
    // Release any forbidden retry too, so a broken guard fails by assertion rather than a held-promise timeout.
    io.loads.slice(1).forEach(release => release(null)); await vi.advanceTimersByTimeAsync(1000);
    await injecting;
    expect(count("load-buffer")).toBe(1); expect(count("paste-buffer")).toBe(0); expect(count("send-keys")).toBe(0); expect(count("delete-buffer")).toBe(0); expect(h.event).not.toHaveBeenCalled();
  });
  it.each([true, false])("live consent and ordinary runtime (consent=%s) still load, paste and submit once", async consent => {
    const h = harness(); if (!consent) h.revoke();
    const injecting = h.daemon.injectSnapshotMessage(consent ? () => h.cap.assert() : undefined);
    await vi.advanceTimersByTimeAsync(1000); io.loads[0]!(null); await vi.advanceTimersByTimeAsync(1000); await injecting;
    expect(count("load-buffer")).toBe(1); expect(count("paste-buffer")).toBe(1); expect(count("send-keys")).toBe(1); expect(count("delete-buffer")).toBe(0); expect(h.event).toHaveBeenCalledOnce();
  });
});
