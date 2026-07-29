import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { getAgendHome } from "../src/paths.js";

/**
 * Precedence tests for FleetManager.resolveInstanceModel — the single resolver
 * behind both `/model` and `/ctx`. These drive a REAL FleetManager (not a mirror
 * of the logic) so the classic-channel path and the cli-env cache read are
 * genuinely exercised.
 */
describe("resolveInstanceModel precedence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-model-resolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Clear only the cli-env files this suite wrote, so cases don't leak.
    const dir = cliEnvDir();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The cli-env cache dir under the TEST AgEnD home. Returns null unless
   * AGEND_HOME is explicitly set (vitest.config.ts injects a per-run temp one) —
   * never touch a developer's real ~/.agend, even though cli-env is derived data.
   */
  function cliEnvDir(): string | null {
    if (!process.env.AGEND_HOME) return null;
    return join(getAgendHome(), "cli-env");
  }

  /** Write the cli-env probe cache the resolver's last-resort branch reads. */
  function writeCliEnv(backend: string, env: Record<string, unknown>): void {
    const dir = cliEnvDir();
    if (!dir) throw new Error("AGEND_HOME must be set for these tests (vitest.config.ts injects it)");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${backend}.json`), JSON.stringify({ backend, probedAt: Date.now(), models: [], ...env }));
  }

  it("per-instance model wins over the fleet default", () => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: { model: "sonnet" }, instances: { worker: { model: "opus" } } } as any;
    expect(fm.resolveInstanceModel("worker")).toMatchObject({ model: "opus", source: "instance", display: "opus" });
  });

  it("falls back to defaults.model", () => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: { model: "sonnet" }, instances: { worker: {} } } as any;
    expect(fm.resolveInstanceModel("worker")).toMatchObject({ model: "sonnet", source: "fleet-default" });
  });

  it("ignores a whitespace-only per-instance model", () => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: { model: "sonnet" }, instances: { worker: { model: "   " } } } as any;
    expect(fm.resolveInstanceModel("worker")).toMatchObject({ model: "sonnet", source: "fleet-default" });
  });

  it("uses a ClassicBot channel model before the fleet default", () => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: { model: "fleet-default" }, instances: {} } as any;
    (fm as any).classicChannels = {
      getAll: () => [{ instanceName: "classic-worker", channelId: "channel-1", adapterId: "discord" }],
      getModel: () => "classic-model",
      getChannelIdByInstance: () => "channel-1",
      getBackendByInstance: () => "claude-code",
    };
    expect(fm.resolveInstanceModel("classic-worker")).toMatchObject({ model: "classic-model", source: "classic" });
  });

  it("resolves the CLI's own default from the probe cache and labels it", () => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: { backend: "kiro-cli" }, instances: { worker: {} } } as any;
    writeCliEnv("kiro-cli", { currentModel: "auto" });
    expect(fm.resolveInstanceModel("worker")).toMatchObject({
      model: "auto", source: "cli-default", display: "auto (default)",
    });
  });

  it("explains an unresolved default when the CLI reports none", () => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: { backend: "claude-code" }, instances: { worker: {} } } as any;
    writeCliEnv("claude-code", {}); // probed, but no currentModel
    const r = fm.resolveInstanceModel("worker");
    expect(r.source).toBe("unresolved");
    expect(r.display).toBe("default (this CLI does not report a default)");
  });

  it("explains an unresolved default when no probe has run", () => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: { backend: "claude-code" }, instances: { worker: {} } } as any;
    expect(fm.resolveInstanceModel("worker").display).toBe("default (not probed yet)");
  });

  it("modelDisplayForInstance returns the resolved display string", () => {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: { backend: "kiro-cli" }, instances: { worker: {} } } as any;
    writeCliEnv("kiro-cli", { currentModel: "auto" });
    expect(fm.modelDisplayForInstance("worker")).toBe("auto (default)");
  });
});
