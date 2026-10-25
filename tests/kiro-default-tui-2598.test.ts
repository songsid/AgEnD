/**
 * #2598 (4): a NEW kiro instance runs kiro's TUI engine (kiro 3.0 drops classic) — written explicitly into fleet.yaml
 * by every path that creates one. An existing entry that sets no kiro_ui stays classic, exactly as before: its engine
 * is never guessed (a missing or damaged launch ledger proves nothing about whether it is new — #2621 review), and
 * moving its conversation is migrate_kiro_instance's job. ClassicBot channels and any fleet default kiro_ui keep
 * deciding for themselves.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoGeneralInstanceConfig, DEFAULT_INSTANCE_CONFIG, getEffectiveInstanceDefaults, loadFleetConfig, newInstanceKiroUi } from "../src/config.js";
import { kiroEngineCandidates, kiroEngineStatus } from "../src/kiro-engine-status.js";
import { draftWebOnly } from "../src/quickstart-api.js";
import { newQuickstartFleet } from "../src/quickstart.js";
import { buildFleetConfig, type WizardAnswers } from "../src/setup-wizard.js";
import type { FleetConfig } from "../src/types.js";

let home: string;
const savedHome = process.env.AGEND_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kiro-dtui-")); process.env.AGEND_HOME = home; });
afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("newInstanceKiroUi: what a newly created instance is written with", () => {
  it("kiro, by its own backend or the fleet default → tui", () => {
    expect(newInstanceKiroUi("kiro-cli", {})).toBe("tui");
    expect(newInstanceKiroUi(undefined, { backend: "kiro-cli" })).toBe("tui");
  });
  it("a fleet default kiro_ui decides instead (the instance inherits it); other backends get nothing", () => {
    expect(newInstanceKiroUi("kiro-cli", { kiro_ui: "legacy" })).toBeUndefined();
    expect(newInstanceKiroUi("codex", {})).toBeUndefined();
    expect(newInstanceKiroUi(undefined, {})).toBeUndefined();
    expect(newInstanceKiroUi(undefined, undefined)).toBeUndefined();
  });
});

describe("an existing entry without kiro_ui stays classic — whatever the launch ledger says (#2621 review)", () => {
  const fleetYaml = "defaults:\n  backend: kiro-cli\ninstances:\n  old:\n    working_directory: /tmp/old\n";
  for (const [label, ledger] of [["missing", null], ["damaged", "{not json"], ["empty", "{}"]] as const) {
    it(`ledger ${label}: loaded as legacy, and kiro_engine_status says legacy`, () => {
      if (ledger !== null) writeFileSync(join(home, "kiro-engine-ledger.json"), ledger);
      const path = join(home, "fleet.yaml");
      writeFileSync(path, fleetYaml);
      const fleet = loadFleetConfig(path);
      expect(fleet.instances.old.kiro_ui).toBe("legacy");
      const status = kiroEngineStatus(kiroEngineCandidates(fleet), { agendHome: home, snapshot: () => null });
      expect(status.instances.map(i => [i.name, i.kiro_ui])).toEqual([["old", "legacy"]]);
    });
  }
  it("the built-in default is still classic", () => expect(DEFAULT_INSTANCE_CONFIG.kiro_ui).toBe("legacy"));
});

describe("every creation path writes a new kiro instance's engine", () => {
  async function create(backend: string, defaults = "", seed = "instances: {}\n") {
    const dataDir = mkdtempSync(join(home, "data-"));
    const projectDir = mkdtempSync(join(home, "proj-"));
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, `${defaults}${seed}`);
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
    return (yaml.load(readFileSync(configPath, "utf-8")) as { instances: Record<string, { kiro_ui?: string }> }).instances;
  }

  it("create_instance, kiro-cli → kiro_ui: tui in fleet.yaml", async () => {
    expect((await create("kiro-cli"))["k-t902"]!.kiro_ui).toBe("tui");
  });
  it("create_instance by the fleet default backend → tui; the existing unset entry beside it is left alone", async () => {
    const instances = await create("", "defaults:\n  backend: kiro-cli\n", "instances:\n  old:\n    working_directory: /tmp/old\n");
    expect(instances["k-t902"]!.kiro_ui).toBe("tui");
    expect(instances.old).not.toHaveProperty("kiro_ui");
  });
  it("create_instance under a fleet default kiro_ui: inherited (left out of the entry), never overwritten with tui", async () => {
    expect((await create("kiro-cli", "defaults:\n  kiro_ui: legacy\n"))["k-t902"]).not.toHaveProperty("kiro_ui");
  });
  it("create_instance, another backend: no kiro_ui", async () => {
    expect((await create("codex"))["k-t902"]).not.toHaveProperty("kiro_ui");
  });

  it("the web wizard's new agent → tui; an agent that already exists keeps its entry", () => {
    const cfg = { defaults: {}, instances: { old: { working_directory: "/o", backend: "kiro-cli" } } } as unknown as FleetConfig;
    expect(draftWebOnly(cfg, { instance_name: "new", backend: "kiro-cli", working_directory: "/n" }).instances.new).toMatchObject({ kiro_ui: "tui" });
    expect(draftWebOnly(cfg, { instance_name: "old", backend: "kiro-cli", working_directory: "/o" }).instances.old).not.toHaveProperty("kiro_ui");
    expect(draftWebOnly(cfg, { instance_name: "new", backend: "codex", working_directory: "/n" }).instances.new).not.toHaveProperty("kiro_ui");
  });

  it("a new fleet (agend setup / agend quickstart) on kiro → defaults.kiro_ui: tui; on another backend nothing", () => {
    const answers = (backend: string): WizardAnswers => ({ channelType: "telegram", backend, botTokenEnv: "T", groupId: -100, channelMode: "topic",
      accessMode: "locked", allowedUsers: [], projectRoots: [], instances: [], costGuard: { enabled: false }, dailySummary: { enabled: false } }) as unknown as WizardAnswers;
    expect((buildFleetConfig(answers("kiro-cli")).defaults as Record<string, unknown>).kiro_ui).toBe("tui");
    expect(buildFleetConfig(answers("codex")).defaults).not.toHaveProperty("kiro_ui");
    expect(newQuickstartFleet([], [], "kiro-cli").defaults.kiro_ui).toBe("tui");
    expect(newQuickstartFleet([], [], "codex").defaults).not.toHaveProperty("kiro_ui");
  });

  it("the General the fleet creates for a connection runs the fleet's engine (runtime values, #2621 review)", () => {
    const ui = (defaults: Record<string, unknown>) => autoGeneralInstanceConfig(defaults as never, "/g", "tg").kiro_ui;
    // A new kiro fleet from agend setup / quickstart: its General is TUI, not the built-in legacy.
    expect(ui(newQuickstartFleet([], [], "kiro-cli").defaults)).toBe("tui");
    expect(ui({ backend: "kiro-cli" })).toBe("tui");
    expect(ui({ backend: "kiro-cli", kiro_ui: "legacy" })).toBe("legacy");
    expect(ui({ backend: "codex" }), "not kiro: the built-in value, as before").toBe(DEFAULT_INSTANCE_CONFIG.kiro_ui);
    expect(autoGeneralInstanceConfig({}, "/g", "tg")).toMatchObject({ working_directory: "/g", general_topic: true, channel_id: "tg" });
    const fm = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    expect(fm).toContain("fleet.instances[name] = autoGeneralInstanceConfig(fleet.defaults, generalDir, need.adapterId);");
  });

  it("create_instance in a new kiro fleet (defaults.kiro_ui: tui): the instance loads as tui", async () => {
    const instances = await create("", "defaults:\n  backend: kiro-cli\n  kiro_ui: tui\n");
    expect(instances["k-t902"]).not.toHaveProperty("kiro_ui"); // inherited, not written over
    expect(getEffectiveInstanceDefaults({ backend: "kiro-cli", kiro_ui: "tui" } as never).kiro_ui).toBe("tui");
  });

  it("a topic bound to a new directory uses the same rule (source pin; its entry carries no built-in defaults)", () => {
    const tc = readFileSync(new URL("../src/topic-commands.ts", import.meta.url), "utf8");
    expect(tc).toContain("if (newKiroUi) this.ctx.fleetConfig.instances[instanceName].kiro_ui = newKiroUi;");
  });
});
