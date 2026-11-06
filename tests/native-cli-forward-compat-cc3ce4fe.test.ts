/**
 * Decision cc3ce4fe (user 2026-11-06): Windows native CLIs are forward-compatible like Linux. An unaudited version runs
 * and is labelled "Not yet verified"; only a known-broken version (the denylist) or an unreadable version line is refused.
 * Nothing else is relaxed: the same readiness, identity and delivery fences decide, so a newer CLI whose screen AgEnD
 * does not recognise stops before any input, and an unaudited store layout never proves "never saved" on its own.
 * Actual FleetManager + lifecycle + daemon + manager + runtime host; only the CLI/transport boundary is inert.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FleetManager } from "../src/fleet-manager.js";
import { windowsAgentsFor } from "../src/windows-agents.js";
import { nativeInstanceConfig } from "../src/native-instance-registry.js";
import { setConfiguredRuntimeSwitches } from "../src/runtime-switches.js";
import { RuntimePaneHost } from "../src/runtime-pane-host.js";
import { RuntimePaneStore } from "../src/runtime-pane-store.js";
import { NATIVE_CLI_AUDITED, nativeCliVersionState, withNativePaneVerification } from "../src/runtime-pane-native.js";

describe("the version rule", () => {
  it("audited → verified; any other readable version → unverified; a denylisted one → denied with its reason; anything unreadable → invalid", () => {
    expect(nativeCliVersionState("codex", "codex-cli 0.165.0")).toEqual({ state: "verified", version: "0.165.0" });
    expect(nativeCliVersionState("claude-code", "2.1.316 (Claude Code)")).toEqual({ state: "verified", version: "2.1.316" });
    for (const line of ["codex-cli 0.167.0", "codex-cli 1.0.0", "codex-cli 0.165.1-beta.2", "codex-cli 0.165.0+build"]) expect(nativeCliVersionState("codex", line).state).toBe("unverified");
    const denied = { codex: { "0.170.0": "its composer never paints" }, "claude-code": {} };
    expect(nativeCliVersionState("codex", "codex-cli 0.170.0", denied)).toEqual({ state: "denied", version: "0.170.0", reason: "its composer never paints" });
    for (const line of [null, undefined, "", "unknown", "codex-cli 0.165", "0.165.0 0.166.0", "codex-cli 1.2.1.316", "v0.165.0.1", "x".repeat(4097) + " 0.165.0"])
      expect(nativeCliVersionState("codex", line as string).state).toBe("invalid");
    expect(nativeCliVersionState("kiro-cli", "1.0.0").state).toBe("invalid");
    // Own keys only: an inherited name is never a denylisted version.
    expect(nativeCliVersionState("codex", "codex-cli 0.165.0", { codex: Object.create({ "0.165.0": "inherited" }), "claude-code": {} }).state).toBe("verified");
  });
  it("the audited set holds exactly the releases that passed an audit", () => {
    expect(NATIVE_CLI_AUDITED).toEqual({ codex: ["0.165.0", "0.166.0"], "claude-code": ["2.1.316", "2.1.318"] });
  });
  it("labelling an inventory copies it, labels only the two pane CLIs and replaces any label it carried", () => {
    const inventory = { clis: [{ id: "codex", version: "codex-cli 0.199.0", paneVerification: "verified" as const }, { id: "claude-code", version: "2.1.316" }, { id: "grok", version: "1.0.0", paneVerification: "verified" as const }] };
    const labelled = withNativePaneVerification(inventory);
    expect(labelled.clis.map(row => row.paneVerification)).toEqual(["unverified", "verified", undefined]);
    expect(inventory.clis[0]!.paneVerification).toBe("verified");
  });
});

const clean: Array<() => unknown> = [];
afterEach(async () => { for (const f of clean.splice(0).reverse()) await f(); setConfiguredRuntimeSwitches({}); vi.restoreAllMocks(); });
const CODEX_IDLE = "› Ask Codex to do anything\r\n\r\n  Context 100% left\r\n";
/** A future layout AgEnD has never seen: no composer, no status row, no recognised dialog. */
const UNKNOWN = "\x1b[2J\x1b[H◆ Codex Next  ·  what should we build?\r\n  ▸ \r\n";
async function fixture(provider: "codex" | "claude-code", version: string, screen?: string) {
  const root = mkdtempSync(join(tmpdir(), "agend-native-forward-")); clean.push(() => rmSync(root, { recursive: true, force: true })); setConfiguredRuntimeSwitches({ remote_runtime: true });
  const fleet: any = new FleetManager(root), machineId = randomUUID();
  const store = windowsAgentsFor(fleet, { start: () => { throw Error("No per-turn exec"); }, get: () => null, prepareWorkspace: async () => "C:\\scratch" } as never);
  const agent = await store.create({ name: "Native", cwd: "C:\\scratch", cli: provider, sandbox: "read-only", machineId }); store.bindInstance(agent.id, "native");
  const config = { ...nativeInstanceConfig(agent), native_adapter: "pane", log_level: "silent" }; fleet.fleetConfig = { defaults: {}, runtimes: { remote_runtime: true }, instances: { native: config } };
  let actual = randomUUID(), output = (_text: string) => {}, exit = (_value: any) => {}, proof: "saved" | "absent" = "saved";
  const known = provider === "codex" ? CODEX_IDLE : "─".repeat(40) + "\r\n❯ \r\n" + "─".repeat(40) + "\r\n";
  const cli = { pid: 12345, write: vi.fn((text: string) => {
      if (provider !== "codex" || screen) return;
      if (text === "/status") output("\x1b[2J\x1b[H› /status\r\n\r\n  Context 100% left\r\n");
      if (text === "\r") output(`\x1b[2J\x1b[HSession: ${actual}\r\n${CODEX_IDLE}`);
    }), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(() => exit({ exitCode: 0 })),
    onData: (fn: (data: string) => void) => { output = fn; queueMicrotask(() => fn(screen ?? known)); return { dispose() {} }; },
    onExit: (fn: typeof exit) => { exit = fn; return { dispose() {} }; } };
  const spawn = vi.fn(async (launch: any) => { actual = launch.sessionId ?? randomUUID(); return cli; });
  const host = new RuntimePaneHost({ sessionProof: async () => proof, store: new RuntimePaneStore(join(root, "runner")), bootId: randomUUID(), online: () => true, maxAgents: () => 4, spawn,
    mcpConnection: (value, tools) => ({ endpoint: "http://127.0.0.1:1/agent", token: "a".repeat(64), owner: value, tools }),
    transcript: () => ({ read: async cursor => { if (!cursor) throw Error("Fixture requires a transcript cursor"); return { state: "pending" as const, cursor, data: "", lines: [], complete: false, gap: false }; }, close: async () => {} }) });
  clean.push(() => host.stop());
  const hub = { machine: () => ({ status: "online", platform: "win32", inventory: { clis: [{ id: provider, runnable: true, version }] } }), callPane: vi.fn((_id: string, request: any) => host.request(request)),
    subscribe: () => () => {}, paneTransportEpoch: () => "private-epoch", task: () => null, tasks: () => [], hasActiveTask: () => false };
  fleet.runtimeHub = hub;
  if (fleet.memoryPressure) vi.spyOn(fleet.memoryPressure, "start").mockImplementation(() => {});
  vi.spyOn(fleet, "syncRoleSkills").mockImplementation(() => { throw Error("No Linux skills in Windows cwd"); });
  const models = vi.spyOn(fleet, "resolveInstanceModel").mockImplementation(() => { throw Error("No Linux model state for native start"); });
  clean.push(async () => { for (const daemon of fleet.daemons.values()) await daemon.abortStartup(); for (const channel of fleet.instanceIpcClients.values()) await channel.close(); fleet.memoryPressure?.stop(); });
  // The web status resolves presentation models itself; the start path above must not.
  const status = () => (models.mockRestore(), fleet.getUiStatus() as { instances: Array<Record<string, unknown>> }).instances.find(row => row.name === "native")!;
  return { fleet, config, store, agent, spawn, cli, status, setProof: (value: typeof proof) => { proof = value; } };
}

describe("a newer, unaudited CLI with an unchanged screen runs and is labelled", () => {
  it.each([["codex", "codex-cli 0.167.0"], ["claude-code", "2.1.399 (Claude Code)"]] as const)("%s %s starts, takes ordinary delivery and shows Not yet verified", async (provider, version) => {
    const f = await fixture(provider, version);
    await f.fleet.startInstance("native", f.config, true);
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.fleet.getInstanceStatus("native")).toBe("running");
    expect(f.status()).toMatchObject({ native_cli_version: version.split(" ")[provider === "codex" ? 1 : 0], native_cli_verification: "unverified" });
    const daemon = f.fleet.daemons.get("native"), push = vi.spyOn(daemon, "pushChannelMessage").mockImplementation(() => {});
    await expect(f.fleet.deliverToInstance("native", { type: "fleet_inbound", content: "normal message", meta: { message_id: "unique" } })).resolves.toBe(true);
    await Promise.resolve(); expect(push).toHaveBeenCalledWith("normal message", expect.objectContaining({ message_id: "unique" }), undefined, expect.any(Number));
    await f.fleet.stopInstance("native");
  });
  it("an audited version is labelled verified", async () => {
    const f = await fixture("codex", "codex-cli 0.165.0"); await f.fleet.startInstance("native", f.config, true);
    expect(f.status()).toMatchObject({ native_cli_version: "0.165.0", native_cli_verification: "verified" }); await f.fleet.stopInstance("native");
  });
});

describe("an unaudited CLI whose screen AgEnD does not recognise keeps failing closed", () => {
  it("Codex 0.167.0 with an unknown layout: no input of any kind, start is never released, and it ends held, not running", async () => {
    const f = await fixture("codex", "codex-cli 0.167.0", UNKNOWN);
    let settled: unknown = "pending"; const start = f.fleet.startInstance("native", f.config, true).then(() => { settled = "started"; }, (error: Error) => { settled = error; });
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(settled).toBe("pending"); expect(f.cli.write).not.toHaveBeenCalled();
    // Let the existing identity deadline pass (the clock only; no timer is shortened in production).
    const now = performance.now.bind(performance); let skew = 0; vi.spyOn(performance, "now").mockImplementation(() => now() + skew); skew = 121_000;
    await start;
    expect(settled).toBeInstanceOf(Error); expect(String((settled as Error).message)).toMatch(/needs attention/);
    expect(f.cli.write).not.toHaveBeenCalled(); expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.fleet.getInstanceStatus("native")).not.toBe("running");
  });
  it("Claude 2.1.399 with an unknown layout: the daemon never releases startup and writes nothing", async () => {
    const f = await fixture("claude-code", "2.1.399 (Claude Code)", "\x1b[2J\x1b[H✻ Claude Next — a brand new screen\r\n");
    let settled = false; const start = f.fleet.startInstance("native", f.config, true).then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(settled).toBe(false); expect(f.cli.write).not.toHaveBeenCalled();
    void start;
  });
});

describe("an unaudited store layout never proves 'never saved' by itself", () => {
  it.each([["2.1.316 (Claude Code)", "automatic fresh"], ["2.1.399 (Claude Code)", "held for the administrator"]] as const)("Claude %s with a runner-proved absence: %s", async (version, outcome) => {
    const f = await fixture("claude-code", version); await f.fleet.startInstance("native", f.config, true); await f.fleet.stopInstance("native");
    f.setProof("absent"); const notice = vi.spyOn(f.fleet, "notifyInstanceTopic").mockResolvedValue(undefined);
    if (outcome === "automatic fresh") {
      await f.fleet.startInstance("native", f.config, true); expect(f.spawn).toHaveBeenCalledTimes(2); expect(notice).toHaveBeenCalledOnce(); await f.fleet.stopInstance("native");
    } else {
      await expect(f.fleet.startInstance("native", f.config, true)).rejects.toThrow("saved conversation could not be checked");
      expect(f.spawn).toHaveBeenCalledOnce(); expect(notice).not.toHaveBeenCalled(); expect(f.store.get(f.agent.id).paneRecovery?.kind).toBe("session-unconfirmed");
    }
  });
});
