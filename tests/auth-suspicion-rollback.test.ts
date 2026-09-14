import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { KiroBackend } from "../src/backend/kiro.js";

/**
 * emitErrorPattern arms the auth gates BEFORE the pty_error reaches the
 * lifecycle, and the lifecycle's token-free probe runs afterwards. When the
 * probe says the credentials are fine, dropping the incident was not enough:
 * the daemon stayed suspicious of an auth failure that never existed.
 *
 * That state is not inert. authFailureUnresolved suppresses the stuck/hang
 * notification and holds MCP auto-restart — and a later REAL MCP death is then
 * reported with authSuspected, so it is treated as already-confirmed auth
 * trouble instead of being verified. One false positive could blind a daemon
 * until something else happened to wake it.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function daemon() {
  const dir = mkdtempSync(join(tmpdir(), "agend-auth-rollback-"));
  dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@1");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new Daemon("rollback-test", {
    working_directory: "/tmp",
    backend: "kiro-cli",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new KiroBackend(dir) as any, undefined, { child: () => logger } as any) as any;
}

const authPattern = (d: any) =>
  d.backend.getErrorPatterns().find((ep: any) => ep.type === "auth_error");

describe("withdrawing auth suspicion after a passing probe", () => {
  it("clears the flags the pattern match armed", () => {
    const d = daemon();
    const ep = authPattern(d);
    d.emitErrorPattern(ep, `${ep.type}:${ep.pattern.source}`, "You are not logged in", Date.now());

    // What emitErrorPattern armed, before any probe runs.
    expect(d.authFailureUnresolved).toBe(true);
    expect(d.errorWaitingForRecovery).toBe(true);
    expect(d.isErrorState).toBe(true);

    expect(d.clearSuspectedAuthFailure()).toBe(true);

    expect(d.authFailureUnresolved, "hang notices and MCP auto-restart depend on this").toBe(false);
    expect(d.errorWaitingForRecovery).toBe(false);
    expect(d.activeErrorPatternKey).toBe(null);
    expect(d.isErrorState).toBe(false);
  });

  it("also clears a startup login-screen report", () => {
    const d = daemon();
    // What the startup scan sets when it sees a sign-in screen.
    d.loginScreenReported = true;
    d.authFailureUnresolved = true;

    expect(d.clearSuspectedAuthFailure()).toBe(true);

    expect(d.loginScreenReported).toBe(false);
    expect(d.authFailureUnresolved).toBe(false);
  });

  // Only what the auth match armed comes back off. A different error that has
  // since armed the recovery gate is still live and must stay.
  it("leaves an unrelated error's recovery gate alone", () => {
    const d = daemon();
    const auth = authPattern(d);
    d.emitErrorPattern(auth, `${auth.type}:${auth.pattern.source}`, "You are not logged in", Date.now());
    // kiro's network pattern sets skipRecoveryWait (it is back at its prompt
    // between retries), so it never arms the gate — use one that does.
    const other = d.backend.getErrorPatterns().find((ep: any) => ep.type === "model_error");
    expect(other?.skipRecoveryWait, "this test needs a gate-arming pattern").toBeFalsy();
    d.emitErrorPattern(other, `${other.type}:${other.pattern.source}`, "model is not available", Date.now());

    d.clearSuspectedAuthFailure();

    expect(d.authFailureUnresolved, "the auth suspicion is still withdrawn").toBe(false);
    expect(d.errorWaitingForRecovery, "but the other error is still being waited out").toBe(true);
    expect(d.lastDetectedErrorType).toBe("model_error");
  });

  it("reports nothing to withdraw when no auth suspicion is held", () => {
    expect(daemon().clearSuspectedAuthFailure()).toBe(false);
  });
});
