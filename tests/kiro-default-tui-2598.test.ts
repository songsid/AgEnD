/**
 * #2598 (4): kiro's default engine is the TUI — for NEW instances only. kiro 3.0 drops classic, so a new kiro instance
 * starts on the TUI; but an existing instance that relied on the old default (no kiro_ui in fleet.yaml) keeps classic,
 * because its engine ledger shows classic launches. Moving it is migrate_kiro_instance's job, with its history; an
 * upgrade flipping it would start it on an empty conversation, unnoticed (B2). ClassicBot channels stay on classic
 * until their own move is decided (D8).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLASSIC_CHANNEL_KIRO_UI, defaultKiroUi, recordKiroLaunch } from "../src/backend/kiro-engine-ledger.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import { kiroEngineCandidates, kiroEngineStatus } from "../src/kiro-engine-status.js";
import { planKiroMigration } from "../src/kiro-migrate.js";
import { t } from "../src/locale.js";
import type { FleetConfig } from "../src/types.js";

let home: string;
const savedHome = process.env.AGEND_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kiro-dtui-")); process.env.AGEND_HOME = home; });
afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});
const ledger = () => join(home, "kiro-engine-ledger.json");
const launched = (instance: string, ui: "legacy" | "tui") => recordKiroLaunch({
  instance, workingDirectory: "/w", credentialProfile: null, kiroVersion: "2.30.0", ui,
  flags: ui === "legacy" ? ["--legacy-ui", "--agent-engine=v1"] : ["--tui", "--agent-engine=v2"],
}, ledger());

describe("defaultKiroUi: the TUI for a new instance, classic for one already launched on classic", () => {
  it("no launch on record → tui", () => expect(defaultKiroUi("fresh", home)).toBe("tui"));
  it("last launched on classic → legacy (an upgrade never moves its conversation)", () => {
    launched("old", "legacy");
    expect(defaultKiroUi("old", home)).toBe("legacy");
    expect(defaultKiroUi("fresh", home), "another instance's record is not this one's").toBe("tui");
  });
  it("last launched on the TUI → tui", () => {
    launched("old", "legacy");
    launched("old", "tui");
    expect(defaultKiroUi("old", home)).toBe("tui");
  });
  it("a damaged ledger reads as no record (→ tui); a name like __proto__ is no record either", () => {
    writeFileSync(ledger(), "{oops");
    expect(defaultKiroUi("old", home)).toBe("tui");
    expect(defaultKiroUi("__proto__", home)).toBe("tui");
  });
  it("the built-in instance defaults no longer carry kiro_ui", () => {
    expect(DEFAULT_INSTANCE_CONFIG).not.toHaveProperty("kiro_ui");
  });
});

describe("where the default is applied", () => {
  it("the daemon resolves an unset kiro_ui per instance when it hands the backend its config", () => {
    const src = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
    expect(src).toContain("kiroUi: this.config.kiro_ui ?? defaultKiroUi(this.name),");
  });

  it("a ClassicBot channel is launched on classic unless the fleet default names one", () => {
    const src = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    expect(src).toContain("kiro_ui: this.fleetConfig?.defaults?.kiro_ui ?? CLASSIC_CHANNEL_KIRO_UI,");
    expect(CLASSIC_CHANNEL_KIRO_UI).toBe("legacy");
  });

  it("kiro_engine_status: unset fleet instances by their record, ClassicBot channels classic", () => {
    launched("old", "legacy");
    const fleet = { defaults: { backend: "kiro-cli" }, instances: { old: {}, fresh: {}, pinned: { kiro_ui: "legacy" } } } as unknown as FleetConfig;
    const classic = { getAll: () => [{ instanceName: "chan", backend: "kiro-cli" }] };
    const by = Object.fromEntries(kiroEngineStatus(kiroEngineCandidates(fleet, classic), { agendHome: home, snapshot: () => null })
      .instances.map(i => [i.name, i.kiro_ui]));
    expect(by).toEqual({ old: "legacy", fresh: "tui", pinned: "legacy", chan: "legacy" });
  });

  it("migrate_kiro_instance: an unset instance with classic launches can be moved; a new one is already TUI", () => {
    launched("old", "legacy");
    const fleet = { defaults: {}, instances: { old: { backend: "kiro-cli", working_directory: home }, fresh: { backend: "kiro-cli", working_directory: home } } } as unknown as FleetConfig;
    const deps = { agendHome: home, fleetConfig: () => fleet, saveFleetConfig() {}, status: () => "stopped", restart: async () => {} };
    expect(planKiroMigration(deps, "old", true)).toMatchObject({ ok: true });
    expect(planKiroMigration(deps, "fresh", true)).toEqual({ ok: false, error: t("kiro_migrate.not_legacy", "fresh", "tui") });
  });
});

describe("create_instance writes a new kiro instance's engine explicitly", () => {
  async function create(backend: string, defaults = "") {
    const dataDir = mkdtempSync(join(home, "data-"));
    const projectDir = mkdtempSync(join(home, "proj-"));
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, `${defaults}instances: {}\n`);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { CreateInstanceArgs } = await import("../src/outbound-schemas.js");
    const fm = new FleetManager(dataDir);
    fm.loadConfig(configPath);
    vi.spyOn(fm, "createForumTopic").mockResolvedValue("902");
    vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
    let error: string | undefined;
    await fm.lifecycle.handleCreate(CreateInstanceArgs.parse({ directory: projectDir, topic_name: "k", ...(backend ? { backend } : {}) }), (_v, m) => { error = m; });
    expect(error).toBeUndefined();
    return (yaml.load(readFileSync(configPath, "utf-8")) as { instances: Record<string, { kiro_ui?: string }> }).instances["k-t902"]!;
  }

  it("kiro-cli → kiro_ui: tui in fleet.yaml, so a predecessor's classic record under the same name cannot apply", async () => {
    launched("k-t902", "legacy");
    expect((await create("kiro-cli")).kiro_ui).toBe("tui");
  });
  it("kiro-cli by the fleet default backend → tui too", async () => {
    expect((await create("", "defaults:\n  backend: kiro-cli\n")).kiro_ui).toBe("tui");
  });
  it("a fleet default kiro_ui wins: inherited (persistence leaves out what equals the default), never overwritten with tui", async () => {
    expect(await create("kiro-cli", "defaults:\n  kiro_ui: legacy\n")).not.toHaveProperty("kiro_ui");
  });
  it("another backend gets no kiro_ui", async () => {
    expect(await create("codex")).not.toHaveProperty("kiro_ui");
  });
});
