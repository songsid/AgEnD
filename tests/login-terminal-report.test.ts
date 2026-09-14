import { describe, expect, it, vi } from "vitest";
import { announcePostLoginRecovery, POST_LOGIN_RECOVERY_DEADLINE_MS } from "../src/login-controller.js";
import { runBeforeDeadline } from "../src/deadline.js";
import { t } from "../src/locale.js";

/**
 * A user re-logged in successfully and then saw nothing at all — no "login
 * worked", no progress, no result — concluded the login flow had hung, and
 * restarted the instances by hand. The login had in fact succeeded: the
 * success message was only BUILT after `await recoverBackendInstances(...)`
 * returned, and that was an unbounded sequential loop over every instance of
 * the backend. One slow restart therefore suppressed the news of a login that
 * had already worked.
 */
describe("post-login recovery always reports an outcome", () => {
  it("reports what came back", async () => {
    const sent: string[] = [];
    await announcePostLoginRecovery(
      "kiro-cli",
      async () => ({ woken: ["a"], restarted: ["b"], pending: [] }),
      async text => { sent.push(text); },
    );
    expect(sent).toEqual([t("login.recovered", "kiro-cli", "a", "b")]);
  });

  it("names the instances still restarting instead of going silent", async () => {
    const sent: string[] = [];
    await announcePostLoginRecovery(
      "kiro-cli",
      async () => ({ woken: [], restarted: ["b"], pending: ["slow-1", "slow-2"] }),
      async text => { sent.push(text); },
      90_000,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("slow-1, slow-2");
    // It must not read as a failure: they are still coming back on their own.
    expect(sent[0]).toBe(t("login.recover_pending", "kiro-cli", "90", "slow-1, slow-2"));
  });

  // The report is the last thing standing between the user and silence, so it
  // has to survive the step it is reporting on.
  it("still reports when recovery itself throws", async () => {
    const sent: string[] = [];
    await announcePostLoginRecovery(
      "kiro-cli",
      async () => { throw new Error("fleet busy"); },
      async text => { sent.push(text); },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(t("login.recover_failed", "kiro-cli", "fleet busy"));
  });

  it("uses a finite default deadline", () => {
    expect(POST_LOGIN_RECOVERY_DEADLINE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(POST_LOGIN_RECOVERY_DEADLINE_MS)).toBe(true);
  });
});

describe("runBeforeDeadline", () => {
  it("returns the value when the work finishes in time", async () => {
    const r = await runBeforeDeadline(async () => "done", Date.now() + 1_000);
    expect(r).toEqual({ status: "fulfilled", value: "done" });
  });

  it("gives up waiting on work that overruns, without cancelling it", async () => {
    let finished = false;
    const r = await runBeforeDeadline(
      () => new Promise<void>(resolve => setTimeout(() => { finished = true; resolve(); }, 50)),
      Date.now() + 5,
    );
    expect(r).toEqual({ status: "timeout" });
    // The work is still running — that is the contract: stop waiting, not stop working.
    expect(finished).toBe(false);
    await new Promise(r2 => setTimeout(r2, 80));
    expect(finished).toBe(true);
  });

  // Node clamps a setTimeout delay above 2^31-1 to 1ms, so a deadline far in
  // the future would fire at once and report everything as timed out.
  it("does not time out immediately when the deadline is very far away", async () => {
    const r = await runBeforeDeadline(
      () => new Promise<string>(resolve => setTimeout(() => resolve("done"), 10)),
      Date.now() + Number.MAX_SAFE_INTEGER,
    );
    expect(r).toEqual({ status: "fulfilled", value: "done" });
  });

  it("reports a rejection instead of throwing, and leaves no unhandled rejection", async () => {
    const r = await runBeforeDeadline(async () => { throw new Error("nope"); }, Date.now() + 1_000);
    expect(r.status).toBe("rejected");
  });

  it("does not surface a late rejection from abandoned work as unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const r = await runBeforeDeadline(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 20)),
        Date.now() + 5,
      );
      expect(r).toEqual({ status: "timeout" });
      await new Promise(res => setTimeout(res, 60));
      expect(unhandled, "an abandoned promise must still be observed").not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
