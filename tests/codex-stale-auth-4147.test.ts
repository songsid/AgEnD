import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";
import { writePausedMarker, readPauseReason } from "../src/pause-marker.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

// Error text comes from #4147; surrounding conversation/chrome is synthetic. No account or live CLI is used.
const pane = readFileSync(new URL("./fixtures/codex-stale-auth-4147.pane.txt", import.meta.url), "utf8");
const dirs: string[] = [];
afterEach(() => { setAuthCheckRunnerForTests(null); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function backend() { return Object.assign(Object.create(CodexBackend.prototype), { binaryName: "codex", configuredStatusLineItems: ["context-remaining"], configuredStatusLinePattern: undefined }) as CodexBackend; }
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "stale-auth-4147-")); dirs.push(dir);
  const b = backend(), logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const d = new Daemon("worker", { working_directory: dir, backend: "codex", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent" } as any,
    dir, false, b, undefined, { child: () => logger } as any) as any;
  const notify = vi.fn(), login = vi.fn(), restart = vi.fn();
  const ctx = { dataDir: dir, fleetConfig: { instances: { worker: { backend: "codex", working_directory: dir } }, defaults: {} }, logger,
    eventLog: null, isPlannedRestart: () => false, notifyInstanceTopic: notify, offerBackendLogin: login,
    webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover: vi.fn(), restartSingleInstance: restart,
    getInstanceDir: () => dir } as any;
  const lc = new InstanceLifecycle(ctx);
  lc.daemons.set("worker", d); lc.attachIncidentHandlers("worker", d);
  const pause = vi.spyOn(lc, "pause").mockRejectedValue(new Error("busy"));
  vi.spyOn(d, "requestPauseWhenIdle").mockImplementation(() => {});
  d.takeNudgeBaselines("› Ask Codex to do anything\n  Context 80% left\n", b.getErrorPatterns());
  const scan = (screen = pane, time = Date.now()) => d.evaluateErrorPatterns(screen, b.getErrorPatterns(), b.getReadyPattern(), time, b.getBusyPattern());
  return { b, d, lc, scan, notify, login, restart, pause, ctx };
}
describe("#4147 running Codex sign-in cannot be refreshed", () => {
  it("recognizes the wrapped live error as a separate instance incident", () => {
    const ep = backend().getErrorPatterns().find(e => e.type === "stale_auth");
    expect(ep).toMatchObject({ type: "stale_auth", action: "pause" });
    expect(ep!.pattern.test(pane)).toBe(true);
    expect(ep!.pattern.test(pane.replace("Please\nsign", "Please sign"))).toBe(true);
    expect(ep!.pattern.test(pane.replace("■ ", ""))).toBe(false);
    expect(ep!.pattern.test(pane.replace("■ ", "> ■ "))).toBe(false);
    expect(ep!.pattern.test(pane.replace("\n\n› [Pasted", "\n```\n\n› [Pasted"))).toBe(false);
    expect(ep!.pattern.test(pane + "\n› New question\n• This is a quotation.\n› Ask Codex to do anything\n  Context 77% left\n")).toBe(false);
  });
  it("holds and notifies once even when the login-file probe would say valid, without offering Login", async () => {
    const runner = vi.fn(async () => ({ code: 0, output: "Logged in using ChatGPT" })); setAuthCheckRunnerForTests(runner);
    const h = harness(); h.scan();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
    expect(h.notify.mock.calls[0][1]).toContain("Restart");
    expect(h.pause).toHaveBeenCalledWith("worker", "stale_auth");
    expect(h.login).not.toHaveBeenCalled(); expect(h.restart).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(h.d.staleAuthIssue()).toMatchObject({ since: expect.any(Number) });
    expect(h.d.notAcceptingReason()).toContain("Restart");
    h.scan(pane + "\n", Date.now() + 600_000);
    expect(h.notify).toHaveBeenCalledOnce();
  });
  it("idle chrome, a valid-file withdrawal and wake of an active process do not clear its hold; a new launch does", async () => {
    const h = harness(), recovered = vi.fn(); h.d.on("pty_recovered", recovered); h.scan();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
    const issue = h.d.staleAuthIssue();
    h.scan("› Ask Codex to do anything\n  Context 78% left\n", Date.now() + 3_600_000);
    expect(h.d.clearSuspectedAuthFailure()).toBe(false);
    await h.d.wake();
    expect(h.d.staleAuthIssue()).toEqual(issue); expect(h.d.isErrorState).toBe(true);
    expect(h.d.authFailureUnresolved).toBe(true); expect(recovered).not.toHaveBeenCalled();
    h.d.beginSpawn();
    expect(h.d.staleAuthIssue()).toBeNull();
  });
});

it("a superseded daemon's stale-login event cannot pause its replacement", async () => {
  const h = harness();
  h.lc.daemons.set("worker", {} as any);
  h.scan();
  await Promise.resolve();
  expect(h.pause).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled();
});

it("refuses an already-scheduled delivery before any pane write while preserving durable retry", async () => {
  const h = harness(); h.scan();
  const verdict = { reached: false, paneWriteStarted: false, durableAttempt: true };
  const failed = vi.fn(); h.d.on("message_failed", failed);
  expect(h.d.refuseBlockedDelivery(verdict, { id: "fake-delivery" })).toBe(true);
  expect(verdict).toMatchObject({ reached: true, paneWriteStarted: false, phase: "pre-write", proof: "stale-auth" });
  expect(failed).not.toHaveBeenCalled();
  await expect(h.d.paneReadinessForDelivery("@fake")).resolves.toBe("dialog");
});

it("restored history stays quiet, but a fresh same-count error after acknowledged input is reported", async () => {
  const h = harness(); h.d.nudgeBaselines = null;
  h.d.takeNudgeBaselines(pane, h.b.getErrorPatterns());
  h.scan();
  expect(h.d.staleAuthIssue()).toBeNull(); expect(h.notify).not.toHaveBeenCalled();
  h.d.tmux = { capturePane: async () => pane, getWindowId: () => "@same" };
  const marker = "fresh-request-4147";
  const evidence = await h.d.capturePaneEvidence({ value: marker, unique: false });
  h.d.commitPreInputQuotaHistory(evidence);
  h.scan(pane.replace("Give a short greeting.", marker));
  await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
});
it.each(["missing", "before-marker", "superseded"])("a %s input proof cannot promote replayed history", async kind => {
  const h = harness(); h.d.nudgeBaselines = null; h.d.takeNudgeBaselines(pane, h.b.getErrorPatterns());
  h.d.tmux = { capturePane: async () => pane, getWindowId: () => "@same" };
  const marker = "fresh-request-4147";
  h.d.commitPreInputQuotaHistory(await h.d.capturePaneEvidence({ value: marker, unique: false }));
  if (kind === "superseded") h.d.launchFenceEpoch++;
  const screen = kind === "missing" ? pane : kind === "before-marker" ? pane.replace("› [Pasted", "› " + marker + "\n\n› [Pasted") : pane.replace("Give a short greeting.", marker);
  h.scan(screen);
  expect(h.d.staleAuthIssue()).toBeNull(); expect(h.notify).not.toHaveBeenCalled();
});

it("persists the restart-specific pause reason without losing the ordinary pause marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "stale-auth-marker-")); dirs.push(dir);
  writePausedMarker(dir, 12_000, "stale_auth");
  expect(readPauseReason(dir)).toBe("stale_auth");
  expect(readFileSync(join(dir, "paused"), "utf8")).toBe("12000");
});
it("the native-pane path also stays instance-local and never asks the local login probe", async () => {
  const runner = vi.fn(async () => ({ code: 0, output: "Logged in" })); setAuthCheckRunnerForTests(runner);
  const h = harness(); vi.spyOn(h.d, "usesNativePane").mockReturnValue(true); h.scan();
  await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
  expect(h.d.requestPauseWhenIdle).toHaveBeenCalledWith({ reason: "stale_auth" });
  expect(runner).not.toHaveBeenCalled(); expect(h.login).not.toHaveBeenCalled();
});

it("MCP death under the held process cannot relabel its account as signed out", async () => {
  const h = harness(); h.scan(); await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
  h.d.emit("mcp_died", { name: "worker", pid: 0, authSuspected: true });
  await Promise.resolve();
  expect(h.notify).toHaveBeenCalledOnce(); expect(h.login).not.toHaveBeenCalled();
});
it("a pending auth-file probe cannot publish a shared-login alarm after the process failure was recognized", async () => {
  let resolve!: (v: { code: number; output: string }) => void;
  const pending = new Promise<{ code: number; output: string }>(r => { resolve = r; });
  const runner = vi.fn(() => pending); setAuthCheckRunnerForTests(runner);
  const h = harness(); h.d.emit("mcp_died", { name: "worker", pid: 0, autoRestart: false });
  await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
  h.scan(); await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
  resolve({ code: 1, output: "Not logged in" });
  await vi.waitFor(() => expect(h.ctx.logger.info).toHaveBeenCalledWith(expect.any(Object), "MCP death report superseded during the auth probe — nothing sent"));
  expect(h.notify).toHaveBeenCalledOnce(); expect(h.login).not.toHaveBeenCalled();
});
