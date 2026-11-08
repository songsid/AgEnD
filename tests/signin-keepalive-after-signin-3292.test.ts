/**
 * #3292: when a sign-in ends, FleetManager has Keep sign-in alive look at that one account once (signin-keepalive-signed-in-3292.test.ts holds what
 * tick({ only }) then does), so the Accounts row does not keep the "needs signing in again" it recorded before the sign-in.
 * - keepAliveAfterSignIn(backend, profile): Claude Code and Codex only; asks for that profile (null: the default sign-in); never awaited and never allowed
 *   to fail (a rejection is logged at debug level, not left unhandled);
 * - recoverBackendInstances (what a finished sign-in calls, for a named profile or the default): does it;
 * - the dashboard sign-in's `done` event: does it for the default sign-in whoever is watching — also when its owning session is no longer current — and
 *   not on any other event.
 * Fixtures only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-ka-after-")); dirs.push(dir);
  const work = join(dir, "w"); mkdirSync(work);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, `defaults:\n  backend: claude-code\ninstances: {}\n`);
  const fm = new FleetManager(dir); fm.loadConfig(path);
  const tick = vi.fn(async (_opts?: unknown) => {});
  vi.spyOn(fm as any, "keepAliveService").mockReturnValue({ tick } as never);
  return { fm: fm as any, tick };
}

describe("keepAliveAfterSignIn", () => {
  it("asks for that account's check — Claude Code and Codex only, the default sign-in as null", () => {
    const { fm, tick } = fixture();
    fm.keepAliveAfterSignIn("claude-code", "work");
    fm.keepAliveAfterSignIn("codex", null);
    fm.keepAliveAfterSignIn("kiro-cli", null);
    fm.keepAliveAfterSignIn("grok", "x");
    expect(tick.mock.calls).toEqual([[{ only: { backend: "claude-code", profile: "work" } }], [{ only: { backend: "codex", profile: null } }]]);
  });
  it("never fails the sign-in's own follow-up: a rejected check is logged, not left unhandled", async () => {
    const { fm, tick } = fixture();
    const debug = vi.spyOn(fm.logger, "debug").mockImplementation(() => {});
    tick.mockRejectedValue(new Error("boom"));
    expect(() => fm.keepAliveAfterSignIn("claude-code", null)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));                                              // an unhandled rejection would fail this run
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ err: "boom", backend: "claude-code" }), "Keep-alive check after a sign-in failed");
  });
});

describe("the check can never fail the sign-in's own follow-up", () => {
  it("the service cannot even be built: the recovery of the account's agents still runs and answers", async () => {
    const { fm } = fixture();
    vi.spyOn(fm, "keepAliveService").mockImplementation(() => { throw new Error("no service"); });
    expect(() => fm.keepAliveAfterSignIn("claude-code", "work")).not.toThrow();
    await expect(fm.recoverBackendInstances("claude-code", undefined, "work")).resolves.toEqual({ woken: [], restarted: [], pending: [] });
  });
  it("and with no logger either (a bare object), it still says nothing and throws nothing", () => {
    const bare: any = Object.create(FleetManager.prototype);
    bare.keepAliveService = () => { throw new Error("no data dir"); };
    expect(() => bare.keepAliveAfterSignIn("codex", null)).not.toThrow();
  });
});

describe("a finished sign-in's recovery looks at that account's keep-alive", () => {
  it("a named profile and the default sign-in each ask for their own", async () => {
    const { fm, tick } = fixture();
    await fm.recoverBackendInstances("claude-code", undefined, "work");
    await fm.recoverBackendInstances("codex");
    await fm.recoverBackendInstances("kiro-cli");
    expect(tick.mock.calls).toEqual([[{ only: { backend: "claude-code", profile: "work" } }], [{ only: { backend: "codex", profile: null } }]]);
  });
});

describe("the dashboard sign-in's `done` event", () => {
  const OWNER = { handle: "abcdef0123456789", label: "Firefox on Linux" };   // a session record: the `starting` event names it in a notice
  function events() {
    const { fm, tick } = fixture();
    vi.spyOn(fm, "forgetSignInIdentities").mockImplementation(() => {});
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
    vi.spyOn(fm.backendAvailability, "refresh").mockResolvedValue(undefined as never);
    const recover = vi.spyOn(fm, "recoverBackendInstances").mockResolvedValue({ woken: [], restarted: [], pending: [] });
    const current = vi.spyOn(fm, "browserSignInOwnerCurrent").mockReturnValue(true);
    const changed = (event: Record<string, unknown>, launched = true) => fm.browserBackendSignIns.deps.changed(event, OWNER, launched);
    return { tick, recover, current, changed };
  }
  it("done: the default sign-in's check is asked for, once, at the event", () => {
    const e = events();
    e.changed({ backend: "claude-code", phase: "done" });
    expect(e.tick.mock.calls).toEqual([[{ only: { backend: "claude-code", profile: null } }]]);
    expect(e.recover).toHaveBeenCalledWith("claude-code", undefined, null);                    // the recovery is its own call (mocked here)
  });
  it("done, but its owning session is no longer current: the file still changed, so the check is still asked for (the recovery is not)", () => {
    const e = events();
    e.current.mockReturnValue(false);
    e.changed({ backend: "codex", phase: "done" });
    expect(e.tick.mock.calls).toEqual([[{ only: { backend: "codex", profile: null } }]]);
    expect(e.recover).not.toHaveBeenCalled();
  });
  it("no other phase, and no other CLI, asks for it", () => {
    const e = events();
    for (const phase of ["starting", "method", "code", "failed", "cancelled"]) e.changed({ backend: "claude-code", phase });
    e.changed({ backend: "kiro-cli", phase: "done" });
    expect(e.tick).not.toHaveBeenCalled();
  });
});
