/**
 * The accounts the host knows are forgotten when ANY dashboard sign-in ends, through the real path: the real LoginController's onDone -> the sink's
 * `ended` -> the registry -> the fleet's own hooks (the same `loginEnded` and `changed` FleetManager gives its registry). Only the terminal and its
 * listener are fakes (as in web-backend-login-2233.test.ts). Fixtures only (example.com).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { LoginController } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";
import { WebBackendLogins, type WebBackendLoginDeps } from "../src/web-backend-login.js";
import type { WebTerminalEvents, WebTerminalResult, WebTerminalSpec } from "../src/web-terminal.js";

const TOKEN = "ABCDEFGHJKMNPQRSTVWX";
class FakeSession extends EventEmitter {
  state: "created" | "running" | "finished" = "created";
  token: string | null = TOKEN;
  constructor(readonly spec: WebTerminalSpec, readonly events: WebTerminalEvents) { super(); }
  async start(): Promise<void> { this.state = "running"; }
  peekAccessToken(): string | null { return this.token; }
  async cancel(detail = "cancelled"): Promise<void> { await this.finish({ ok: false, reason: "cancel", detail }); }
  async finish(result: WebTerminalResult): Promise<void> {
    if (this.state === "finished") return;
    this.state = "finished"; this.token = null; this.emit("finished", result); await this.events.onDone(result);   // -> LoginController onDone -> chat.web.ended -> the sink
  }
}
class FakeHttp {
  static gate: Promise<void> | null = null;
  private readonly held = FakeHttp.gate;
  constructor(readonly session: FakeSession, readonly opts: { hostname?: string }) { FakeHttp.gate = null; }
  async listen() { if (this.held) await this.held; return { port: 40001, url: `http://${this.opts.hostname ?? "localhost"}:40001/t/${"ab".repeat(16)}/` }; }
  async close() {}
  setExternalHost() {}
  readonly readinessMarker = "ready";
}
const hold = (): { gate: Promise<void>; release: () => void } => { let release!: () => void; const gate = new Promise<void>(r => { release = r; }); return { gate, release }; };

const dirs: string[] = [], registries: WebBackendLogins[] = [];
afterEach(() => { vi.restoreAllMocks(); setAuthCheckRunnerForTests(null); FakeHttp.gate = null; for (const r of registries.splice(0)) r.dispose(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const status = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "alice.fixture@example.com", subscriptionType: "team" });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-login-end-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = { defaults: {}, instances: {} };
  vi.spyOn(fm, "backendAvailabilityRows").mockReturnValue([{ backend: "claude-code", state: "usable" }]);
  setAuthCheckRunnerForTests(async () => ({ code: 0, output: status }));
  const fleetDeps = (fm.webBackendLogins as { deps: WebBackendLoginDeps }).deps;      // the hooks FleetManager itself gives its registry
  fm.webBackendLogins.dispose();
  const lock = new LoginWindowLock(), terminals: FakeSession[] = [];
  let wall = 1_000_000;
  const controller = new LoginController({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "localhost" }) as never,
    isFleetAdmin: () => { throw new Error("a dashboard requester is never judged as a chat user"); },
    eventLog: () => ({ insert: () => {} }),
    recoverBackendInstances: async () => ({ woken: [], restarted: [], pending: [] as string[] }),
    postButtons: async () => { throw new Error("a dashboard requester gets no chat buttons"); },
    claimWindow: backend => lock.tryClaim("web", backend), releaseWindow: c => { lock.release(c); }, isClaimCurrent: c => lock.isCurrent(c),
    windowBusyMessage: () => lock.busyMessage(), checkAuth: async () => "invalid",
    createSession: (spec, ev) => { const s = new FakeSession(spec, ev); terminals.push(s); return s as never; },
    createHttp: (s, _l, o) => new FakeHttp(s as unknown as FakeSession, o) as never,
    now: () => wall,
  });
  const phases: Array<string | undefined> = [], ended = vi.fn();
  const logins = new WebBackendLogins({
    isLocalAdmin: () => true,
    start: (backend, chat, opts) => controller.start(backend, chat, opts),
    accessToken: sink => controller.webAccessToken(sink), isActiveFor: sink => controller.isActiveFor(sink), cancelFor: sink => controller.cancelFor(sink),
    cancel: () => controller.isActive() ? controller.cancel() : Promise.resolve("no session"),
    notice: () => {}, now: () => wall,
    changed: phase => { phases.push(phase); fleetDeps.changed?.(phase); },        // recorded, then the fleet's own: tells the pages to read again
    loginEnded: () => { ended(); fleetDeps.loginEnded?.(); },                      // recorded, then the fleet's own: forgets the accounts
  });
  registries.push(logins);
  const who = (handle: string) => ({ handle, label: handle });
  const begin = async (handle: string) => { const asked = await logins.check(who(handle), "claude-code"); if (!("confirm" in asked)) throw new Error("no confirm"); return logins.begin(who(handle), asked.confirm.id, false); };
  /** The accounts the host has read, from the real refresh path (the auth runner above answers). */
  const learn = async () => { fm.refreshSignInIdentities(); await vi.waitFor(() => expect(fm.signInIdentityReads.size).toBe(0)); expect(fm.signInIdentities.size).toBeGreaterThan(0); };
  return { fm, logins, controller, terminals, phases, ended, begin, learn, lock, view: (handle: string) => logins.view(handle) };
}

describe("every dashboard sign-in that ends forgets the accounts, through the real controller", () => {
  it("a CANCELLED sign-in (the real cancel: controller -> session -> onDone -> the sink)", async () => {
    const f = await fixture(); await f.begin("a"); await f.learn();
    expect(f.terminals[0]!.state).toBe("running"); const generation = f.fm.signInIdentityGeneration;
    await f.logins.cancel();
    expect(f.terminals[0]!.state).toBe("finished"); expect(f.ended).toHaveBeenCalledTimes(1);
    expect(f.fm.signInIdentities.size).toBe(0); expect(f.fm.signInIdentityGeneration).toBeGreaterThan(generation);
    expect(f.phases).toEqual(["running", "ended"]); expect(f.view("a")).toMatchObject({ phase: "ended", ok: false });
  });
  it("a FAILED sign-in (the terminal ends with an error)", async () => {
    const f = await fixture(); await f.begin("a"); await f.learn();
    await f.terminals[0]!.finish({ ok: false, reason: "error", detail: "the CLI exited with an error" });
    expect(f.ended).toHaveBeenCalledTimes(1); expect(f.fm.signInIdentities.size).toBe(0);
    expect(f.view("a")).toMatchObject({ phase: "ended", ok: false });
  });
  it("a SUCCESSFUL sign-in, a timed-out one and one the CLI exited too (every end, not only the unhappy ones)", async () => {
    for (const result of [{ ok: true, reason: "exit", detail: "success reported" }, { ok: false, reason: "ttl", detail: "expired" }, { ok: false, reason: "exit", exitCode: 1, detail: "exit 1" }] as WebTerminalResult[]) {
      const f = await fixture(); await f.begin("a"); await f.learn();
      await f.terminals[0]!.finish(result); expect(f.fm.signInIdentities.size, result.reason).toBe(0); expect(f.ended).toHaveBeenCalledTimes(1);
    }
  });
  it("a REPLACED sign-in: A is held while starting and cancelled, B takes over; A's end forgets the accounts but never tells the pages the current sign-in ended", async () => {
    const f = await fixture(), held = hold();
    FakeHttp.gate = held.gate;
    const startingA = f.begin("a"); await vi.waitFor(() => expect(f.terminals).toHaveLength(1));
    await f.learn();                                          // what was read before A ended: the old account
    await f.logins.cancel();                                  // A ends while it was never published as the current one
    expect(f.terminals[0]!.state).toBe("finished");
    expect(f.ended, "A's end reached the registry's hook").toHaveBeenCalledTimes(1);
    expect(f.fm.signInIdentities.size, "and forgot the accounts (this was the gap)").toBe(0);
    expect(f.phases, "no page was told that the current sign-in ended").not.toContain("ended");
    const startedB = await f.begin("b");
    expect(startedB).toMatchObject({ login: { mine: true, phase: "running" } });
    await f.learn();                                          // B's accounts, read while B runs
    held.release(); await startingA;                          // A's late start finishes: it must not replace B
    expect(f.view("b"), "B is still what is shown, still running").toMatchObject({ mine: true, phase: "running", accessCode: TOKEN });
    expect(f.phases.filter(phase => phase === "ended"), "still no 'ended' for the current sign-in").toHaveLength(0);
    expect(f.fm.signInIdentities.size, "B's accounts were not forgotten by A's late finish").toBeGreaterThan(0);
    await f.terminals[1]!.finish({ ok: true, reason: "exit", detail: "success reported" });
    expect(f.phases.filter(phase => phase === "ended")).toHaveLength(1); expect(f.fm.signInIdentities.size).toBe(0);
  });
  it("a refused start (nothing ran) forgets nothing and says nothing ended", async () => {
    const f = await fixture(); await f.begin("a"); await f.learn();
    const second = await f.logins.check({ handle: "b", label: "b" }, "claude-code");              // the window is busy: the controller refuses
    expect("confirm" in second).toBe(false); expect(f.ended).not.toHaveBeenCalled(); expect(f.fm.signInIdentities.size).toBeGreaterThan(0);
  });
  it("a read that began before the sign-in ended never writes its old account back", async () => {
    const f = await fixture(); await f.begin("a");
    const gates: Array<() => void> = [];
    setAuthCheckRunnerForTests(async () => { await new Promise<void>(done => gates.push(done)); return { code: 0, output: status }; });
    f.fm.refreshSignInIdentities(); await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
    await f.terminals[0]!.finish({ ok: true, reason: "exit", detail: "success reported" });       // the real end, while the read is still in flight
    gates.splice(0).forEach(open => open()); await vi.waitFor(() => expect(f.fm.signInIdentityReads.size).toBe(0));
    expect(f.fm.signInIdentities.size).toBe(0);
  });
});
