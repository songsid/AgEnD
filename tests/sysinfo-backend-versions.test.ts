import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probeCLIEnv = vi.fn();
vi.mock("../src/backend/factory.js", () => ({
  createBackend: () => ({ probeCLIEnv }),
}));

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

async function makeCommands(): Promise<TopicCommands> {
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
  return new TopicCommands(fleet);
}

describe("/sysinfo backend CLI cache", () => {
  it("renders all six fresh cached versions without starting probes", async () => {
    seedAll();
    const commands = await makeCommands();

    const telegram = await commands.getSysInfoTextAsync();
    const discord = await commands.getSysInfoTextAsync({ platform: "discord" });

    expect(telegram).toContain("**Backend CLIs**");
    for (const backend of BACKEND_IDS) {
      const row = `- ${BACKEND_LABELS[backend]}: ${backend}-cli 1.2.3`;
      expect(telegram).toContain(row);
      expect(discord).toContain(row);
    }
    expect(discord).not.toContain("|--------|");
    await nextImmediate();
    expect(probeCLIEnv).not.toHaveBeenCalled();
  });

  it("serves the stale cached version and refreshes it in the background", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    seedAll(backend => backend === "codex" ? 2 * HOUR : 5 * 60 * 1000);
    probeCLIEnv.mockImplementation(() => new Promise(() => { /* deliberately slow probe */ }));
    const commands = await makeCommands();

    const text = await commands.getSysInfoTextAsync();

    expect(text).toContain("- Codex: codex-cli 1.2.3");
    expect(probeCLIEnv).not.toHaveBeenCalled();
    await nextImmediate();
    expect(probeCLIEnv).toHaveBeenCalledOnce();
    expect(probeCLIEnv).toHaveBeenCalledWith(expect.objectContaining({ instanceName: "probe-codex" }));
  }, 1_000);

  it("shows probing for a cache miss and returns before the background probe finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (const backend of BACKEND_IDS.filter(id => id !== "muse")) seed(backend, 5 * 60 * 1000, `${backend}-cli 1.2.3`);
    probeCLIEnv.mockImplementation(() => new Promise(() => { /* deliberately slow probe */ }));
    const commands = await makeCommands();

    const text = await commands.getSysInfoTextAsync();

    expect(text).toContain("- Muse Code: probing…");
    expect(probeCLIEnv).not.toHaveBeenCalled();
    await nextImmediate();
    expect(probeCLIEnv).toHaveBeenCalledOnce();
    expect(probeCLIEnv).toHaveBeenCalledWith(expect.objectContaining({ instanceName: "probe-muse" }));
  }, 1_000);

  it("localizes unknown cache entries instead of dropping backend rows", async () => {
    setLocale("zh-TW");
    for (const backend of BACKEND_IDS) seed(backend, 5 * 60 * 1000, `${backend}-cli 1.2.3`);
    seed("codex", 5 * 60 * 1000);
    const commands = await makeCommands();

    const text = await commands.getSysInfoTextAsync();

    expect(text).toContain("**Backend CLI 版本**");
    expect(text).toContain("Codex: 未知／未安裝");
    expect(probeCLIEnv).not.toHaveBeenCalled();
  });
});
