import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

afterEach(() => setAuthCheckRunnerForTests(null));

function lifecycle(backend = "codex", names: string[] = ["worker"], plannedRestart = false) {
  const notifyInstanceTopic = vi.fn();
  const offerBackendLogin = vi.fn(async () => {});
  const ctx = {
    fleetConfig: {
      instances: Object.fromEntries(names.map(n => [n, { backend }])),
      defaults: {},
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    eventLog: null,
    isPlannedRestart: () => plannedRestart,
    notifyInstanceTopic,
    offerBackendLogin,
    webhookEmit: vi.fn(),
    clearCancelButton: vi.fn(),
    checkModelFailover() {},
    restartSingleInstance: async () => {},
    getInstanceDir: (n: string) => `/nonexistent/${n}`,
  } as unknown as LifecycleContext;
  const lc = new InstanceLifecycle(ctx);
  const daemons = names.map(name => {
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
    lc.attachIncidentHandlers(name, daemon as any);
    return daemon;
  });
  return { lc, ctx, daemons, notifyInstanceTopic, offerBackendLogin };
}

const authError = (name: string) =>
  ({ name, type: "auth_error", action: "pause", message: "401 Unauthorized" });

describe("auth-error second opinion", () => {
  it("a passing auth check turns the pattern hit into a no-op (conversation text)", async () => {
    const runner = vi.fn(async () => ({ code: 0, output: "Logged in" }));
    setAuthCheckRunnerForTests(runner);
    const { daemons, notifyInstanceTopic } = lifecycle();
    daemons[0].emit("pty_error", authError("worker"));
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 20));
    expect(notifyInstanceTopic).not.toHaveBeenCalled();
    expect(daemons[0].requestPauseWhenIdle).not.toHaveBeenCalled();
  });

  it("a failing auth check pauses and tells the admin to /login", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "Not logged in" }));
    const { daemons, notifyInstanceTopic } = lifecycle();
    daemons[0].emit("pty_error", authError("worker"));
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));
    expect(String(notifyInstanceTopic.mock.calls[0][1])).toContain("/login codex");
    // pause() fails on the nonexistent dir → falls back to pause-when-idle.
    await vi.waitFor(() => expect(daemons[0].requestPauseWhenIdle).toHaveBeenCalled());
  });

  // The alert already names the remedy in words; the button saves the user
  // from retyping it somewhere else. It belongs WITH an alert, not instead of
  // one — and never after an alert nobody saw.
  it("offers a one-tap re-login beside a confirmed auth alert", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "Not logged in" }));
    const { daemons, notifyInstanceTopic, offerBackendLogin } = lifecycle();
    daemons[0].emit("pty_error", authError("worker"));
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(offerBackendLogin).toHaveBeenCalledWith("worker", "codex"));
  });

  it("offers no button when the auth check clears the instance", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: "Logged in" }));
    const { daemons, offerBackendLogin } = lifecycle();
    daemons[0].emit("pty_error", authError("worker"));
    await new Promise(r => setTimeout(r, 30));
    expect(offerBackendLogin, "a control with no alert next to it explains nothing").not.toHaveBeenCalled();
  });

  // A suppressed alert means nobody saw the explanation. A bare button under
  // no message is a control whose purpose the user has to guess.
  it("offers no button when the alert itself was suppressed", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "Not logged in" }));
    const { daemons, notifyInstanceTopic, offerBackendLogin } = lifecycle("codex", ["worker"], true);
    daemons[0].emit("pty_error", authError("worker"));
    await vi.waitFor(() => expect(daemons[0].requestPauseWhenIdle).toHaveBeenCalled());
    expect(notifyInstanceTopic, "planned restart suppresses the alert").not.toHaveBeenCalled();
    expect(offerBackendLogin).not.toHaveBeenCalled();
  });

  it("an uncertain check (timeout) pauses conservatively", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: null, output: "" }));
    const { daemons, notifyInstanceTopic } = lifecycle();
    daemons[0].emit("pty_error", authError("worker"));
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(daemons[0].requestPauseWhenIdle).toHaveBeenCalled());
  });

  it("uses OpenCode's standalone auth-list check before pausing", async () => {
    const runner = vi.fn(async () => ({ code: 0, output: "└  1 credentials" }));
    setAuthCheckRunnerForTests(runner);
    const { daemons, notifyInstanceTopic } = lifecycle("opencode");
    daemons[0].emit("pty_error", authError("worker"));

    await vi.waitFor(() => expect(runner).toHaveBeenCalledWith(
      ["opencode", "auth", "list"],
      expect.any(Number),
    ));
    await new Promise(r => setTimeout(r, 20));
    expect(notifyInstanceTopic).not.toHaveBeenCalled();
    expect(daemons[0].requestPauseWhenIdle).not.toHaveBeenCalled();
  });

  it("pauses OpenCode with a usable terminal-login hint when no credential is configured", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: "└  0 credentials" }));
    const { daemons, notifyInstanceTopic } = lifecycle("opencode");
    daemons[0].emit("pty_error", authError("worker"));

    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));
    expect(String(notifyInstanceTopic.mock.calls[0][1])).toContain("opencode auth login");
    await vi.waitFor(() => expect(daemons[0].requestPauseWhenIdle).toHaveBeenCalledTimes(1));
  });

  it("simultaneous same-tick alerts from one backend's instances join a single in-flight check", async () => {
    const runner = vi.fn(async () => ({ code: 0, output: "Logged in" }));
    setAuthCheckRunnerForTests(runner);
    const { daemons } = lifecycle("codex", ["w1", "w2", "w3"]);
    // The real expiry scenario: shared credentials die → every instance's
    // error monitor fires in the same tick, before any check has resolved.
    daemons[0].emit("pty_error", authError("w1"));
    daemons[1].emit("pty_error", authError("w2"));
    daemons[2].emit("pty_error", authError("w3"));
    await new Promise(r => setTimeout(r, 30));
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("non-auth errors never trigger the check", async () => {
    const runner = vi.fn(async () => ({ code: 0, output: "" }));
    setAuthCheckRunnerForTests(runner);
    const { daemons } = lifecycle();
    daemons[0].emit("pty_error", { name: "worker", type: "rate_limit", action: "notify", message: "429" });
    await new Promise(r => setTimeout(r, 20));
    expect(runner).not.toHaveBeenCalled();
  });
});
