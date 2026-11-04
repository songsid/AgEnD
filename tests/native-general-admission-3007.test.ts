/** Exact coordinator/runner proof boundaries. No CLI, account, provider data or shell is touched. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NativePaneManager } from "../src/native-pane-manager.js";
import { WindowsAgents } from "../src/windows-agents.js";
import { nativeInstanceConfig } from "../src/native-instance-registry.js";
import { buildFleetInstructions, buildNativeFleetInstructions } from "../src/instructions.js";
import { GENERAL_ROLE_INSTRUCTIONS, GENERAL_SKILL_NAMES } from "../src/general-role.js";
import { loadGeneralKnowledge } from "../src/runtime-general-workspace.js";
import { generalWorkspaceUpgrade } from "../src/runtime-general-protocol.js";
const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function fixture(cli: "codex" | "claude-code" = "codex") {
  const root = mkdtempSync(join(tmpdir(), "native-general-")); roots.push(root); const machineId = randomUUID(), bindingId = randomUUID();
  const store = new WindowsAgents(root, { get: () => null, start() { throw Error("No exec"); } } as never);
  const agent = await store.create({ name: "General", cli, cwd: "C:\\owned\\general", machineId, sandbox: "read-only" }); store.bindInstance(agent.id, "general");
  const config = { ...nativeInstanceConfig(agent), native_adapter: "pane" as const, general_topic: true, native_general_binding: bindingId };
  let online = true, epoch = "one";
  const endpoint = { machineId, online: () => online, epoch: () => epoch, version: () => cli === "codex" ? "Codex 0.165.0" : "Claude Code 2.1.316", subscribe: () => () => {},
    call: vi.fn(async (request: any): Promise<any> => {
      if (request.action === "list") return { hostBootId: randomUUID(), capabilities: { openDisposition: true, generalWorkspace: true }, panes: [] };
      if (request.action === "general-workspace") return { version: 1, bindingId, instance: "general", cli, packHash: request.packHash, cwd: agent.cwd };
      throw Error("No process or other request in this fixture");
    }) };
  const instructions = buildNativeFleetInstructions({ instanceName: "general", workingDirectory: agent.cwd, workflow: false }, true);
  const manager = new NativePaneManager({ home: root, store, config: () => config, endpoint: async () => endpoint, admit() {}, instructions: () => instructions,
    menu: () => [{ name: "reply" }, { name: "create_instance" }], allowed: () => false, published: () => false, invoke: async () => ({ result: null }) });
  return { root, agent, store, config, manager, endpoint, offline: () => { online = false; }, changeEpoch: () => { epoch = "two"; } };
}
it("the worker instruction path stays byte-identical, while native General gets the host role and coordinator boundary", () => {
  const params = { instanceName: "general", workingDirectory: "C:\\owned", workflow: false as const };
  expect(buildNativeFleetInstructions(params, false)).toBe(buildFleetInstructions(params));
  const general = buildNativeFleetInstructions(params, true); expect(general).toContain(GENERAL_ROLE_INSTRUCTIONS);
  expect(general).toContain("Do NOT modify project files directly"); expect(general).toContain("Human confirmation stays with the person");
  expect(general).toContain("C:\\owned"); expect(general).not.toContain("/home/");
});
it("a new General launch carries an exact prepared role pack without reserving or starting a process", async () => {
  const f = await fixture(), native = await f.manager.prepare("general", f.config, () => {});
  const manifest = JSON.parse(readFileSync(join(f.root, "native-panes", f.agent.id, "active.json"), "utf8"));
  expect(manifest.launch.generalWorkspace).toEqual({ bindingId: f.config.native_general_binding, packHash: loadGeneralKnowledge("codex").hash });
  expect(manifest.launch.instructions).toContain("# Fleet Coordinator"); expect(manifest.launch.cwd).toBe(f.agent.cwd);
  expect(f.endpoint.call.mock.calls.map(([request]) => request.action)).toEqual(["list", "general-workspace"]);
  expect(f.store.get(f.agent.id).activeId).toBeUndefined(); await native.release("detach");
});
it.each(["old-host", "old-pack", "changed-lease", "changed-profile", "wrong-cwd"])("%s cannot become a General launch or reservation", async mode => {
  const f = await fixture(), original = f.endpoint.call.getMockImplementation()!;
  f.endpoint.call.mockImplementation(async request => {
    const response = await original(request);
    if (mode === "old-host" && request.action === "list") delete response.capabilities.generalWorkspace;
    if (request.action === "general-workspace") {
      if (mode === "old-pack") { delete response.cwd; response.packHash = "a".repeat(64); response.upgradeRequired = true; }
      if (mode === "changed-lease") f.changeEpoch();
      if (mode === "changed-profile") f.store.reservePane(f.agent.id, randomUUID());
      if (mode === "wrong-cwd") response.cwd = "C:\\other";
    }
    return response;
  });
  await expect(f.manager.prepare("general", f.config, () => {})).rejects.toThrow();
  expect(f.endpoint.call.mock.calls.some(([request]) => request.action === "open")).toBe(false);
  if (mode !== "changed-profile") expect(f.store.get(f.agent.id).activeId).toBeUndefined();
  if (mode === "old-host" || mode === "old-pack") expect(f.store.get(f.agent.id).paneRecovery?.kind).toBe("host-upgrade");
});
it("an old-pack refusal is an exact primitive identity proof, not a coerced or foreign error", () => {
  const request = { action: "general-workspace" as const, bindingId: randomUUID(), instance: "general", cli: "codex" as const, packHash: "a".repeat(64) };
  const proof = { version: 1, bindingId: request.bindingId, instance: request.instance, cli: request.cli, packHash: "b".repeat(64), upgradeRequired: true };
  expect(generalWorkspaceUpgrade(proof, request)).toBe(true);
  for (const raw of [{ ...proof, instance: "other" }, { ...proof, packHash: request.packHash }, { ...proof, packHash: [proof.packHash] }, { ...proof, upgradeRequired: "true" }, { ...proof, cli: ["codex"] }]) expect(() => generalWorkspaceUpgrade(raw, request)).toThrow();
});

it("a busy retained General reattaches without republishing its files, running startup keys or changing its menu", async () => {
  const f = await fixture("claude-code"), original = f.endpoint.call.getMockImplementation()!, boot = randomUUID();
  let pane: any, launches = 0;
  f.endpoint.call.mockImplementation(async request => {
    if (request.action === "list") return { hostBootId: boot, capabilities: { openDisposition: true, generalWorkspace: true }, panes: pane ? [pane] : [] };
    if (request.action === "open") {
      const reattached = !!pane;
      if (!pane) { launches++; const l = request.launch; pane = { hostBootId: boot, paneId: l.paneId, launchId: l.launchId, agentId: l.agentId, instance: l.instance,
        columns: l.columns, rows: l.rows, state: "running", seq: 2, outputAt: 1, commandSequence: 0, sessionId: l.launchId }; }
      return { ...pane, reattached };
    }
    if (request.action === "snapshot") return pane;
    return original(request);
  });
  const first = await f.manager.prepare("general", f.config, () => {}); await first.acquire(() => {}); const old = first.port.ownedSnapshot(); await first.release("detach");
  f.endpoint.call.mockClear();
  const next = await f.manager.prepare("general", f.config, () => {}), acquisition = await next.acquire(() => {});
  expect(acquisition.disposition).toBe("reattached"); expect(next.port.ownedSnapshot()).toEqual(old); expect(launches).toBe(1);
  expect(f.endpoint.call.mock.calls.some(([request]) => ["general-workspace", "input", "key"].includes(request.action))).toBe(false);
  await next.release("detach");
});

it("the real host publishes only its installed pack and re-verifies the General directory before any spawn", async () => {
  const { RuntimePaneHost } = await import("../src/runtime-pane-host.js"), { RuntimePaneStore } = await import("../src/runtime-pane-store.js");
  const root = mkdtempSync(join(tmpdir(), "host-general-")); roots.push(root);
  const spawn = vi.fn(async () => { throw Error("No process is allowed in this filesystem proof"); });
  const host = new RuntimePaneHost({ store: new RuntimePaneStore(root), bootId: randomUUID(), online: () => true, maxAgents: () => 4, spawn });
  const request = { action: "general-workspace" as const, bindingId: randomUUID(), instance: "general", cli: "codex" as const, packHash: loadGeneralKnowledge("codex").hash };
  const old = { ...request, packHash: "a".repeat(64) };
  expect(generalWorkspaceUpgrade(await host.request(old), old)).toBe(true);
  const prepared: any = await host.request(request); expect(prepared.packHash).toBe(request.packHash);
  expect((await host.request({ action: "list" }) as any).capabilities.generalWorkspace).toBe(true);
  // The transport cannot change the runner-derived cwd to an otherwise valid user-supplied Windows directory.
  await expect(host.request({ action: "open", operationId: randomUUID(), launch: { paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), instance: "general", cli: "codex",
    cwd: "C:\\not-the-published-workspace", sandbox: "read-only", columns: 80, rows: 24, generalWorkspace: { bindingId: request.bindingId, packHash: request.packHash } } })).rejects.toThrow("directory differs");
  expect(spawn).not.toHaveBeenCalled(); expect((await host.request({ action: "list" }) as any).panes).toEqual([]);
});


it("the actual host refuses repairing a running or unknown General cwd until its positive exit, without blocking another cwd", async () => {
  const { RuntimePaneHost } = await import("../src/runtime-pane-host.js"), { RuntimePaneStore } = await import("../src/runtime-pane-store.js");
  // A drive-spelled private relative directory on POSIX lets the real wire validator and filesystem both run.
  // On Windows use its real temporary directory; no drive-root or user profile is touched.
  const root = process.platform === "win32" ? mkdtempSync(join(tmpdir(), "general-live-host-")) : `C:\\agend-general-test-${randomUUID()}`; roots.push(root);
  const callbacks: Array<{ exit: (value: { exitCode: number }) => void; fail: () => void }> = [];
  const spawn = vi.fn(async () => {
    const callback = { exit: (_value: { exitCode: number }) => {}, fail: () => {} }; callbacks.push(callback);
    return { pid: 12345 + callbacks.length, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: () => callback.exit({ exitCode: 0 }),
      onData: () => ({ dispose() {} }), onExit: (fn: typeof callback.exit) => { callback.exit = fn; return { dispose() {} }; },
      onFailure: (fn: typeof callback.fail) => { callback.fail = fn; return { dispose() {} }; } };
  });
  const host = new RuntimePaneHost({ store: new RuntimePaneStore(root), bootId: randomUUID(), online: () => true, maxAgents: () => 4, spawn });
  try {
    const request = { action: "general-workspace" as const, bindingId: randomUUID(), instance: "general", cli: "codex" as const, packHash: loadGeneralKnowledge("codex").hash };
    const prepared: any = await host.request(request), launch = { paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), instance: "general", cli: "codex" as const,
      cwd: prepared.cwd, sandbox: "read-only" as const, columns: 80, rows: 24, generalWorkspace: { bindingId: request.bindingId, packHash: request.packHash } };
    await host.request({ action: "open", operationId: randomUUID(), launch });
    await host.request({ action: "open", operationId: randomUUID(), launch: { ...launch, paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), instance: "unrelated", cwd: "C:\\unrelated", generalWorkspace: undefined } });
    const file = join(prepared.cwd, "AGENTS.md"), owned = join(prepared.cwd, ".agend-general.json"), before = readFileSync(owned, "utf8"); rmSync(file);
    await expect(host.request(request)).rejects.toThrow("live or unconfirmed"); expect(existsSync(file)).toBe(false); expect(readFileSync(owned, "utf8")).toBe(before);
    callbacks[0].fail(); // Uncertain evidence must continue to hold, even though the process may already be gone.
    await expect(host.request(request)).rejects.toThrow("live or unconfirmed"); expect(existsSync(file)).toBe(false); expect(readFileSync(owned, "utf8")).toBe(before);
    callbacks[0].exit({ exitCode: 0 });
    expect((await host.request(request) as any).packHash).toBe(request.packHash); expect(existsSync(file)).toBe(true);
    expect((await host.request({ action: "list" }) as any).panes.find((p: any) => p.instance === "unrelated").state).toBe("running"); expect(spawn).toHaveBeenCalledTimes(2);
  } finally { await host.stop(); }
});

it("the fixed runner skill list stays equal to all bundled General-role frontmatter", async () => {
  const { load } = await import("js-yaml"), skills = join("src", "general-knowledge", "skills");
  const installed = readdirSync(skills, { withFileTypes: true }).filter(row => row.isDirectory()).filter(row => {
    const text = readFileSync(join(skills, row.name, "SKILL.md"), "utf8"), front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    const value = front ? load(front) as { roles?: string[] } : undefined; return value?.roles?.includes("general");
  }).map(row => row.name).sort();
  expect([...GENERAL_SKILL_NAMES].sort()).toEqual(installed);
});
