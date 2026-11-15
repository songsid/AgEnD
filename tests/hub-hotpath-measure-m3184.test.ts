/** Controlled Fleet boot + actual stdio MCP and local delivery IPC; real paired TLS/WSS Hub states, no vendor/adapter calls. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { hubRig } from "./helpers/hub-rig.js";
import { resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ children: [] as string[], notify: [] as string[], warns: [] as string[], errors: [] as string[] }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const guarded = (run: (...args: any[]) => any) => (...args: any[]) => {
    const vendor = String(args[0]), argv = args[1];
    if (vendor === "openssl" || vendor.endsWith("/openssl") || vendor === process.execPath && Array.isArray(argv) && argv.some((a: unknown) => typeof a === "string" && a.endsWith("/src/channel/mcp-server.ts"))) return run(...args);
    calls.children.push(vendor); throw Error("vendor/process child forbidden in hot-path tests");
  };
  return { ...real, spawn: guarded(real.spawn), spawnSync: guarded(real.spawnSync), exec: guarded(real.exec), execSync: guarded(real.execSync), execFile: guarded(real.execFile), execFileSync: guarded(real.execFileSync), fork: guarded(real.fork) };
});
vi.mock("../src/logger.js", async original => {
  const silent: any = { info() {}, debug() {}, warn(_o: unknown, m?: string) { if (m) calls.warns.push(m); }, error(o: any, m?: string) { calls.errors.push(`${m ?? ""}: ${o?.err?.message ?? ""}`); }, child: () => silent };
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
vi.mock("../src/sd-notify.js", () => ({ sdNotify: (s: string) => { calls.notify.push(s); }, sdNotifyBlocking: vi.fn(), setSdNotifyWarn: vi.fn(), startSdWatchdog: () => setInterval(() => {}, 10_000) }));
vi.mock("../src/tmux-exec-helper.js", () => ({ tmuxExecHelper: { reopen() {}, start() {}, maintain() {}, async stop() {} } }));
// The fleet's tmux server boundary (M-2457 §6): inert too. The real module stays; its probes and its record never run.
vi.mock("../src/tmux-server.js", async original => ({
  ...await original<typeof import("../src/tmux-server.js")>(),
  reconcileServer: async () => null,
  recordServer: async () => ({ socket: "agend-test", binary: "", version: "", sha256: "0".repeat(64), serverPid: 1, serverStart: 1 }),
  readServerRecord: () => null,
  sha256File: () => "0".repeat(64),
}));
// startInstance now awaits resolveBackendBinary before lifecycle.start (#3029). The probe is a child; this suite forbids those.
vi.mock("../src/binary-probe.js", async original => {
  const real = await original<typeof import("../src/binary-probe.js")>();
  const inert = { answer: Promise.resolve<string | null>(null), kill() {}, exited: Promise.resolve() };
  return { ...real, spawnProbeCommand: () => inert, spawnWhich: () => inert, binaryProbe: new real.BinaryProbe(() => inert) };
});

vi.mock("../src/tmux-binary.js", async original => ({ ...await original<typeof import("../src/tmux-binary.js")>(), resolveTmux: () => ({ binary: "/inert/tmux", version: "3.8.0", source: "override" }), tmuxBinary: () => "/inert/tmux" }));
const { FleetManager } = await import("../src/fleet-manager.js");
const { TmuxManager } = await import("../src/tmux-manager.js");
const { TmuxControlClient } = await import("../src/tmux-control.js");
const { ClassicChannelManager } = await import("../src/classic-channel-manager.js");
const { setUsageFetcherForTests } = await import("../src/usage/usage-api.js");

const fleets: Array<{ fm: any; dir: string; boot: Promise<void> }> = [];
const resources: Array<() => Promise<void>> = [];
const rows: Array<Record<string, unknown>> = [];
afterAll(() => { const out = process.env.AGEND_M3184_EVIDENCE_DIR; if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "timings.json"), JSON.stringify({ boundary: "startAll to two synthetic MCP agents tools-ready; no vendor model startup", node: process.version, rows }, null, 2)); } });
const savedWait = FleetManager.ADAPTER_STARTUP_WAIT_MS;
const savedSignals = new Map(["SIGUSR1", "SIGUSR2"].map(s => [s, process.listeners(s as NodeJS.Signals)] as const));
afterEach(async () => {
  for (const f of fleets.splice(0)) {
    await f.boot.catch(() => {});
    await f.fm.stopAll();
    f.fm.memoryPressure.stop(); f.fm.spawnGate.shutdown(); f.fm.stormWindow.shutdown();
    rmSync(f.dir, { recursive: true, force: true });
  }
  for (const close of resources.splice(0).reverse()) await close();
  FleetManager.ADAPTER_STARTUP_WAIT_MS = savedWait;
  setUsageFetcherForTests(null);
  for (const [signal, previous] of savedSignals) {
    for (const l of process.listeners(signal as NodeJS.Signals)) if (!previous.includes(l)) process.removeListener(signal, l);
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  calls.notify.length = 0; calls.warns.length = 0; calls.errors.length = 0;
  expect(calls.children.splice(0)).toEqual([]);
});

/** Real Fleet boot ordering with inert adapters and a real MCP-ready synthetic agent boundary. */
function boot(dir: string, mode: Mode, state: Scenario) {
  const main = async () => {};
  vi.stubEnv("AGEND_HOME", dir); vi.stubEnv("HOME", dir);
  vi.stubEnv("MAIN_TOKEN", "t1"); vi.stubEnv("SECOND_TOKEN", "t2");
  const general = join(dir, "workspaces/general"), worker = join(dir, "workspaces/worker");
  mkdirSync(general, { recursive: true }); mkdirSync(worker, { recursive: true });
  const config = join(dir, "fleet.yaml");
  writeFileSync(config, `defaults:
  locale: en
  startup:
    concurrency: 2
    stagger_delay_ms: 0
hub_member:
  enabled: ${mode !== "none"}
web:
  preview: false
channels:
  - id: main
    type: discord
    mode: topic
    bot_token_env: MAIN_TOKEN
    group_id: "111111111111111111"
  - id: second
    type: discord
    mode: topic
    bot_token_env: SECOND_TOKEN
    group_id: "111111111111111111"
instances:
  general:
    working_directory: ${general}
    general_topic: true
    channel_id: main
    topic_id: "222222222222222222"
  worker:
    working_directory: ${worker}
    topic_id: "333333333333333333"
`);
  const fm: any = new FleetManager(dir);
  const clients = new Map<string, { server: IpcServer; tools: string[]; listMs: number; bytes: number; client?: Client; next?: { text: string; finish: () => void } }>();
  vi.spyOn(fm, "startCliEnvProbeWorker").mockReturnValue({ promise: Promise.resolve(null), stopped: Promise.resolve(), terminate() {} });
  vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
  vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([]);
  vi.spyOn(TmuxControlClient.prototype, "start").mockImplementation(() => {});
  vi.spyOn(TmuxControlClient.prototype, "stop").mockImplementation(() => {});
  vi.spyOn(fm.memoryPressure, "start").mockImplementation(() => {});
  vi.spyOn(fm.lifecycle, "primeAuthVerification").mockImplementation(() => {});
  for (const name of ["startAvailabilityRefresh", "ensureGeneralInstructions", "syncRoleSkills", "startSearchIndex",
    "startDiscordUsagePresence", "requestDiscordUsagePresenceRefresh", "startStatuslineWatcher", "resolveTopicIcons",
    "refreshAllGuestRooms", "startNeedsYou", "announceToolPermissionsChange", "sendFleetStartCompletionFallback",
    "notifyAdapterFailure", "scheduleAdapterRetry"]) {
    vi.spyOn(fm, name).mockImplementation(() => undefined);
  }
  vi.spyOn(fm, "startSingleAdapter").mockImplementation(() => main());
  vi.spyOn(fm, "startAdditionalAdapter").mockResolvedValue(undefined);
  vi.spyOn(fm, "resolveKnowledgeWorkDir").mockImplementation((...args: unknown[]) => args[0]);
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
  vi.spyOn(fm, "startHealthServer").mockImplementation(async () => { (FleetManager.prototype as any).startHealthServer.call(fm, 0); });
  vi.spyOn(fm.topicCommands, "autoCreateTopics").mockResolvedValue(undefined);
  vi.spyOn(fm.topicArchiver, "startPoller").mockImplementation(() => {});
  vi.spyOn(fm.lifecycle, "start").mockImplementation(async (...args: unknown[]) => {
    const name = String(args[0]), instance = fm.getInstanceDir(name); mkdirSync(instance, { recursive: true });
    const server = new IpcServer(join(instance, "channel.sock")); await server.listen();
    const record = { server, tools: [] as string[], listMs: 0, bytes: 0, client: undefined as Client | undefined, next: undefined as undefined | { text: string; finish: () => void } };
    clients.set(name, record); resources.push(() => server.close());
    server.on("message", (message: any, peer: any) => {
      if (message.type === "tool_call" && message.tool === "hub_room_status") {
        state.statusCalls++; if (mode !== "down") server.send(peer, { requestId: message.requestId, result: { available: mode === "up" } });
      }
      const next = record.next;
      if (next && message.type === "fleet_inbound" && next.text === message.content) { record.next = undefined; next.finish(); }
    });
    const client = new Client({ name: "synthetic-agent", version: "1" }); record.client = client; resources.push(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", resolve("src/channel/mcp-server.ts")], env: { ...process.env as Record<string, string>, AGEND_HOME: dir, AGEND_SOCKET_PATH: join(instance, "channel.sock"), AGEND_INSTANCE_NAME: name, AGEND_TOOL_SET: "worker", AGEND_DASHBOARD_OFF: "" }, stderr: "pipe" }), { timeout: 2000 });
    const start = performance.now(), catalog = await client.listTools({}, { timeout: 1500 });
    record.listMs = performance.now() - start; record.tools = catalog.tools.map(tool => tool.name); record.bytes = Buffer.byteLength(JSON.stringify(catalog));
    expect(record.tools).toContain("hub_room_list");
    fm.daemons.set(name, { getProcessStatus: () => "running", getInteractionSnapshot: () => null, roomConversationGeneration: () => null });
  });
  vi.spyOn(fm.lifecycle, "stop").mockImplementation(async (...args: unknown[]) => { fm.daemons.delete(args[0]); });
  vi.spyOn(ClassicChannelManager.prototype, "getAll").mockReturnValue([]);
  const classicStarts: string[] = [];
  vi.spyOn(fm, "startClassicInstanceUnattended").mockImplementation(async (...args: unknown[]) => {
    classicStarts.push((args[0] as { instanceName: string }).instanceName); return true;
  });
  setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [] }));
  const booted = fm.startAll(config) as Promise<void>;
  fleets.push({ fm, dir, boot: booted });
  return { fm, booted, clients };
}


type Mode = "none" | "up" | "down";
interface Scenario { statusCalls: number }
async function scenario(mode: Mode) {
 const rig = await hubRig({ parentDir: tmpdir() }); await rig.pair();
 // The low-level pair fixture creates the real profile; Fleet selection is a separate local API state.
 writeFileSync(join(rig.memberHome, "hub-member/state.json"), JSON.stringify({ hubId: rig.identity.hubId }), { mode: 0o600 });
 const held = new Set<import("node:stream").Duplex>();
 if (mode === "down") {
  const listener = (rig.server as any).server;
  listener.removeAllListeners("upgrade");
  listener.on("upgrade", (_request: unknown, socket: import("node:stream").Duplex) => { held.add(socket); socket.once("close", () => held.delete(socket)); });
 }
 rig.setReceive(async (frame, link) => frame.type === "reconcile" ? { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: link.linkEpoch, payload: { receipts: [], nextReceiptSequence: 0, more: false } } : undefined);
 const state: Scenario = { statusCalls: 0 };
 resources.push(async () => { for (const socket of held) socket.destroy(); await rig.close(); });
 return { rig, state, heldSockets: () => held.size };
}
describe("Hub state never gates ordinary Fleet hot paths", () => {
 it.each(["none", "up", "down"] as const)("%s: synthetic agent readiness, static tools and ordinary delivery", async mode => {
  const { rig, state, heldSockets } = await scenario(mode), start = performance.now();
  const f = boot(rig.memberHome, mode, state); await f.booted;
  const startupMs = performance.now() - start;
  expect([...f.clients.keys()].sort(), JSON.stringify({ errors: calls.errors, warnings: calls.warns })).toEqual(["general", "worker"]); expect(f.fm.startupComplete).toBe(true); expect(calls.notify).toContain("READY=1");
  expect(state.statusCalls).toBe(0); expect(startupMs).toBeLessThan(4000);
  const hubStateAtReady = f.fm.hubMemberLink ?? "off";
  if (mode === "up") await vi.waitFor(() => expect(f.fm.hubMemberLink, JSON.stringify(calls.errors)).toBe("online"), { timeout: 6000 });
  if (mode === "down") await vi.waitFor(() => expect(heldSockets()).toBeGreaterThan(0), { timeout: 2000 });
  if (mode === "none") expect(rig.received).toHaveLength(0);
  const deliveryMs: number[] = [], steadyToolListMs: number[] = [];
  for (const [name, client] of f.clients) {
   for (let n = 0; n < 3; n++) { const begin = performance.now(); await client.client!.listTools({}, { timeout: 1500 }); steadyToolListMs.push(performance.now() - begin); }
   await (FleetManager.prototype as any).connectIpcToInstance.call(f.fm, name);
   for (let n = 0; n < 3; n++) {
    const text = `owned-latency-${name}-${n}`, begin = performance.now(); let finish!: () => void;
    const arrived = new Promise<void>(resolve => { finish = resolve; }); client.next = { text, finish };
    expect(await f.fm.deliverToInstance(name, { type: "fleet_inbound", content: text }, { waitForIdle: false })).toBe(true);
    await arrived; deliveryMs.push(performance.now() - begin);
   }
  }
  expect(Math.max(...deliveryMs)).toBeLessThan(1000);
  rows.push({ mode, startupMs, agentsReady: f.clients.size, toolListMs: [...f.clients.values()].map(c => c.listMs), catalogTools: [...f.clients.values()].map(c => c.tools.length), catalogBytes: [...f.clients.values()].map(c => c.bytes), deliveryIpcMs: deliveryMs, hubStateAtReady, measuredHubState: mode === "none" ? "disabled" : f.fm.hubMemberLink ?? "offline", steadyToolListMs, hubStatusLookups: state.statusCalls });
 }, 30000);
});
