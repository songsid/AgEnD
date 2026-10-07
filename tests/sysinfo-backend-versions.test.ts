import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:worker_threads", async () => ({ Worker: (await import("./helpers/probe-worker.js")).FakeProbeWorker }));
vi.mock("../src/logger.js", async () => ({
  createLogger: (await import("./helpers/probe-worker.js")).fakeProbeLogger,
  rotateLogIfNeeded: vi.fn(),
}));
import { FakeProbeWorker } from "./helpers/probe-worker.js";

const probeCLIEnv = vi.fn();
const refreshModelCatalog = vi.fn();
vi.mock("../src/backend/factory.js", () => ({
  createBackend: () => { throw new Error("backend constructor on fleet thread"); },
  createBackendAsync: () => { throw new Error("backend constructor on fleet thread"); },
}));
let workers: FakeProbeWorker[];

import { TopicCommands } from "../src/topic-commands.js";
import { getLocale, setLocale } from "../src/locale.js";

const BACKEND_IDS = ["claude-code", "codex", "kiro-cli", "grok", "antigravity", "muse"];
const BACKEND_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "kiro-cli": "Kiro CLI",
  grok: "Grok",
  antigravity: "Antigravity (agy)",
  muse: "Muse Code",
};
const HOUR = 60 * 60 * 1000;
const originalAgendHome = process.env.AGEND_HOME;
const originalLocale = getLocale();
let home: string;
let dataDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-sysinfo-cli-env-"));
  process.env.AGEND_HOME = home;
  dataDir = mkdtempSync(join(tmpdir(), "agend-sysinfo-data-"));
  probeCLIEnv.mockReset();
  refreshModelCatalog.mockReset().mockResolvedValue(undefined);
  FakeProbeWorker.reset();
  workers = FakeProbeWorker.workers;
});

afterEach(() => {
  if (originalAgendHome === undefined) delete process.env.AGEND_HOME;
  else process.env.AGEND_HOME = originalAgendHome;
  setLocale(originalLocale);
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  vi.clearAllTimers();
  vi.useRealTimers();
});

function nextImmediate(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function seed(backend: string, ageMs: number, version?: string): void {
  const cacheDir = join(home, "cli-env");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${backend}.json`), JSON.stringify({
    backend,
    ...(version ? { version } : {}),
    models: [],
    probedAt: Date.now() - ageMs,
  }));
}

function seedAll(ageFor: (backend: string) => number = () => 5 * 60 * 1000): void {
  for (const backend of BACKEND_IDS) seed(backend, ageFor(backend), `${backend}-cli 1.2.3`);
}

function seedWithoutMuse(): void {
  for (const backend of BACKEND_IDS.filter(id => id !== "muse")) {
    seed(backend, 5 * 60 * 1000, `${backend}-cli 1.2.3`);
  }
}

async function makeCommands(): Promise<{ commands: TopicCommands; fleet: any }> {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fleet = new FleetManager(dataDir) as any;
  fleet.fleetConfig = { defaults: {}, instances: {} };
  fleet.getSysInfo = () => ({
    uptime_seconds: 0,
    memory_mb: { rss: 1, heapUsed: 1, heapTotal: 2 },
    instances: [],
    fleet_cost_cents: 0,
    fleet_cost_limit_cents: 0,
    running_count: 0,
    paused_count: 0,
    fleet_mem_mb: null,
    system_mem_gb: { used: 1, total: 2 },
  });
  return { commands: new TopicCommands(fleet), fleet };
}

async function finishFlights(fleet: any): Promise<void> {
  await Promise.all([...fleet.pendingCliEnvProbes.values(), ...fleet.pendingVendorCliEnvProbes.values()]);
}

describe("/sysinfo backend CLI cache", () => {
  it("renders all six fresh cached versions without starting probes", async () => {
    seedAll();
    const { commands } = await makeCommands();
    const telegramSend = vi.fn().mockResolvedValue(undefined);
    const discordSend = vi.fn().mockResolvedValue(undefined);

    await commands.sendSysInfo(telegramSend);
    await commands.sendSysInfo(discordSend, { platform: "discord" });

    const telegram = telegramSend.mock.calls[0][0];
    const discord = discordSend.mock.calls[0][0];
    expect(telegram).toContain("**Backend CLIs**");
    for (const backend of BACKEND_IDS) {
      const row = `- ${BACKEND_LABELS[backend]}: ${backend}-cli 1.2.3`;
      expect(telegram).toContain(row);
      expect(discord).toContain(row);
    }
    expect(discord).not.toContain("|--------|");
    expect(workers).toHaveLength(0);
    expect(probeCLIEnv).not.toHaveBeenCalled();
  });

  it.each(["telegram", "discord"] as const)("does not start refresh while the %s send is pending", async platform => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    seedWithoutMuse();
    const { commands } = await makeCommands();
    let releaseSend!: () => void;
    const send = vi.fn((_text: string) => new Promise<void>(resolve => { releaseSend = resolve; }));

    const response = commands.sendSysInfo(send, { platform });
    await nextImmediate();

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toContain("- Muse Code: probing…");
    expect(workers).toHaveLength(0);
    expect(probeCLIEnv).not.toHaveBeenCalled();

    releaseSend();
    await response;

    expect(workers).toHaveLength(1);
    expect(workers[0].options.workerData.backend).toBe("muse");
    expect(probeCLIEnv).not.toHaveBeenCalled();
  });

  it("serves stale cached versions and runs refresh outside the fleet event loop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    seedAll(backend => backend === "codex" ? 2 * HOUR : 5 * 60 * 1000);
    const { commands } = await makeCommands();
    const send = vi.fn().mockResolvedValue(undefined);

    await commands.sendSysInfo(send);

    expect(send.mock.calls[0][0]).toContain("- Codex: codex-cli 1.2.3");
    expect(workers).toHaveLength(1);
    expect(workers[0].options.workerData.config.instanceName).toBe("probe-codex");
    expect(probeCLIEnv).not.toHaveBeenCalled();
  });

  it("queues all six missing probes behind a two-worker limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { commands } = await makeCommands();

    await commands.sendSysInfo(async () => {});

    expect(workers.map(worker => worker.input.backend)).toEqual(BACKEND_IDS.slice(0, 2));
    for (let index = 0; index < BACKEND_IDS.length; index++) {
      workers[index]!.reply({ version: "1.2.3", models: [] });
      await nextImmediate();
    }
    expect(workers.map(worker => worker.input.backend)).toEqual(BACKEND_IDS);
    expect(probeCLIEnv).not.toHaveBeenCalled();
  });

  it("updates a cache miss after a successful background probe for the next sysinfo", async () => {
    seedWithoutMuse();
    const { commands, fleet } = await makeCommands();
    const firstSend = vi.fn().mockResolvedValue(undefined);
    await commands.sendSysInfo(firstSend);
    expect(firstSend.mock.calls[0][0]).toContain("- Muse Code: probing…");

    workers[0].emit("message", { ok: true, result: { version: "Muse Code 1.3.0", models: [] } });
    await finishFlights(fleet);

    const saved = JSON.parse(readFileSync(join(home, "cli-env", "muse.json"), "utf-8"));
    expect(saved.version).toBe("Muse Code 1.3.0");
    const secondSend = vi.fn().mockResolvedValue(undefined);
    await commands.sendSysInfo(secondSend);
    expect(secondSend.mock.calls[0][0]).toContain("- Muse Code: Muse Code 1.3.0");
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it.each([false, true])("joins an existing backend probe (vendor refresh=%s)", async refreshVendorCatalog => {
    seedAll(backend => backend === "codex" ? 2 * HOUR : 5 * 60 * 1000);
    const { commands, fleet } = await makeCommands();
    const flight = fleet.probeBackendBounded("codex", { refreshVendorCatalog });
    await nextImmediate();
    expect(workers).toHaveLength(1);

    await commands.sendSysInfo(async () => {});

    expect(workers).toHaveLength(1);
    workers[0]!.reply({ version: "codex-cli 0.159.0", models: [] });
    await flight;
    await finishFlights(fleet);
    expect(await commands.getSysInfoTextAsync()).toContain("- Codex: codex-cli 0.159.0");
  });

  it("terminates a timed-out worker and ignores a late result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    seedWithoutMuse();
    const { commands, fleet } = await makeCommands();
    const { CLI_ENV_PROBE_DEADLINE_MS } = await import("../src/fleet-manager.js");
    await commands.sendSysInfo(async () => {});

    await vi.advanceTimersByTimeAsync(CLI_ENV_PROBE_DEADLINE_MS + 1);
    await finishFlights(fleet);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(fleet.pendingCliEnvProbes.size).toBe(0);

    workers[0].emit("message", { ok: true, result: { version: "late", models: [] } });
    expect(existsSync(join(home, "cli-env", "muse.json"))).toBe(false);
  });

  it("localizes unknown cache entries instead of dropping backend rows", async () => {
    setLocale("zh-TW");
    seedAll();
    seed("codex", 5 * 60 * 1000);
    const { commands } = await makeCommands();

    const text = await commands.getSysInfoTextAsync();

    expect(text).toContain("**Backend CLI 版本**");
    expect(text).toContain("Codex: 未知／未安裝");
    expect(workers).toHaveLength(0);
    expect(probeCLIEnv).not.toHaveBeenCalled();
  });
});
