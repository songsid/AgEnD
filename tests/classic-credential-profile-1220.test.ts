/**
 * #1220: a ClassicBot channel can run on a second subscription, the way a
 * fleet.yaml instance does, through `backend_options.<backend>.credential_profile`.
 * Before, classicBot.yaml dropped backend_options on read, and the fleet bound
 * every classic channel to the shared login whatever it was launched with.
 *
 * Nothing here starts a CLI or a fleet: AGEND_HOME is a scratch directory, and
 * startInstance / stopInstance / the unattended Classic start are replaced.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { mergeBackendOptions, readClassicBindings } from "../src/classic-bindings.js";
import { FleetManager } from "../src/fleet-manager.js";
import { kiroEngineCandidates } from "../src/kiro-engine-status.js";
import { fetchAllUsage, providersForConfig, setUsageProvidersForTests, withClassicBindings } from "../src/usage/providers.js";

let dir: string;
const previousHome = process.env.AGEND_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agend-1220-"));
  process.env.AGEND_HOME = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.AGEND_HOME;
  else process.env.AGEND_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "875544568890785823#discord";
function writeClassic(channel: Record<string, unknown>, defaults: Record<string, unknown> = {}): string {
  const path = join(dir, "classicBot.yaml");
  writeFileSync(path, yaml.dump({
    defaults,
    channels: {
      [KEY]: { channelId: "875544568890785823", adapterId: "discord", instanceName: "classic-codex-bot", name: "codex-bot", ...channel },
    },
  }));
  return path;
}
function logger() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as any;
  return log;
}
function manager(log = logger()) {
  const classic = new ClassicChannelManager(dir, log);
  classic.configureAdapters([{ id: "discord", type: "discord" }]);
  return classic;
}
const PERSONAL = { codex: { credential_profile: "personal" } };

describe("classicBot.yaml keeps a channel's backend_options", () => {
  it("reads the profile, resolves it for the channel's backend, and writes it back on save", () => {
    writeClassic({ backend: "codex", backend_options: PERSONAL });
    const classic = manager();
    expect(classic.getBackendOptionsByInstance("classic-codex-bot")).toEqual(PERSONAL);
    expect(classic.getCredentialProfileByInstance("classic-codex-bot", undefined)).toEqual({ state: "profile", name: "personal" });

    // A save (any other edit) must not drop it again.
    classic.toggleCollab("875544568890785823", "discord");
    const saved = yaml.load(readFileSync(join(dir, "classicBot.yaml"), "utf8")) as any;
    expect(saved.channels[KEY].backend_options).toEqual(PERSONAL);
  });

  it("follows the channel's backend: a profile set for another backend does not apply", () => {
    writeClassic({ backend: "claude-code", backend_options: PERSONAL });
    expect(manager().getCredentialProfileByInstance("classic-codex-bot", undefined)).toEqual({ state: "shared" });
  });

  it("falls back to the fleet defaults' profile, as a fleet instance does; the channel's own wins", () => {
    writeClassic({ backend: "codex" });
    const defaults = { backend_options: { codex: { credential_profile: "team" } } };
    expect(manager().getCredentialProfileByInstance("classic-codex-bot", defaults)).toEqual({ state: "profile", name: "team" });
    writeClassic({ backend: "codex", backend_options: PERSONAL });
    expect(manager().getCredentialProfileByInstance("classic-codex-bot", defaults)).toEqual({ state: "profile", name: "personal" });
    // An explicit "" is the shared login over an inherited profile — as the launch merge reads it (r1 review).
    writeClassic({ backend: "codex", backend_options: { codex: { credential_profile: "" } } });
    expect(manager().getCredentialProfileByInstance("classic-codex-bot", defaults)).toEqual({ state: "shared" });
  });

  it("no backend_options: the shared login, exactly as before", () => {
    writeClassic({ backend: "codex" });
    const classic = manager();
    expect(classic.getBackendOptionsByInstance("classic-codex-bot")).toBeUndefined();
    expect(classic.getCredentialProfileByInstance("classic-codex-bot", undefined)).toEqual({ state: "shared" });
    const saved = yaml.load(readFileSync(join(dir, "classicBot.yaml"), "utf8")) as any;
    expect(saved.channels[KEY]).not.toHaveProperty("backend_options");
  });
});

describe("classicBot.yaml warns like the fleet.yaml validator", () => {
  const warnings = (log: ReturnType<typeof logger>) => JSON.stringify(log.warn.mock.calls);

  it("a profile on a backend with no credential home (only codex and kiro-cli have one) will be ignored", () => {
    writeClassic({ backend: "claude-code", backend_options: { "claude-code": { credential_profile: "personal" } } });
    const log = logger();
    manager(log);
    expect(warnings(log)).toContain("claude-code has no credential home yet");
    for (const supported of ["codex", "kiro-cli"]) {
      writeClassic({ backend: supported, backend_options: { [supported]: { credential_profile: "personal" } } });
      const quiet = logger();
      manager(quiet);
      expect(warnings(quiet), supported).not.toContain("no credential home");
    }
  });

  it.each([["../escape", "credential_profile must match"], [42, "credential_profile must be a string"], [true, "credential_profile must be a string"]])(
    "an invalid profile (%j) is kept, reported, and resolves as INVALID — never the shared login or the default", (raw, reason) => {
      writeClassic({ backend: "codex", backend_options: { codex: { credential_profile: raw } } });
      const log = logger();
      const classic = manager(log);
      expect(warnings(log)).toContain(reason);
      expect(warnings(log)).toContain("will not start until it is fixed");
      expect(classic.getBackendOptionsByInstance("classic-codex-bot")).toEqual({ codex: { credential_profile: raw } });
      const defaults = { backend_options: { codex: { credential_profile: "team" } } };
      expect(classic.getCredentialProfileByInstance("classic-codex-bot", defaults)).toEqual(expect.objectContaining({ state: "invalid" }));
    });

  it("a backend_options that is not a mapping, or an unknown backend namespace, is reported", () => {
    writeClassic({ backend: "codex", backend_options: ["codex"] });
    const log = logger();
    expect(manager(log).getBackendOptionsByInstance("classic-codex-bot")).toBeUndefined();
    expect(warnings(log)).toContain("must be a mapping");
    writeClassic({ backend: "codex", backend_options: { nosuchcli: { credential_profile: "x" } } });
    const log2 = logger();
    manager(log2);
    expect(warnings(log2)).toContain("unknown backend namespace");
  });
});

describe("the fleet binds the classic channel to its profile", () => {
  function fleet(defaults: Record<string, unknown> = {}) {
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults, instances: {} } as any;
    fm.classicChannels = manager();
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    return fm;
  }

  it("get_usage's active rows: the profile row, not the shared one", () => {
    writeClassic({ backend: "codex", backend_options: PERSONAL });
    expect([...fleet().getActiveUsageProviderIds()]).toEqual(["codex:personal"]);
  });

  it("without a profile the classic channel stays on the shared row", () => {
    writeClassic({ backend: "codex" });
    expect([...fleet().getActiveUsageProviderIds()]).toEqual(["codex"]);
  });

  it("a fleet-default profile is the one its launch inherits, so the binding says so too", () => {
    writeClassic({ backend: "kiro-cli" });
    expect([...fleet({ backend_options: { "kiro-cli": { credential_profile: "team" } } }).getActiveUsageProviderIds()])
      .toEqual(["kiro:team"]);
  });

  it("the launch carries the channel's profile over the fleet defaults', per backend", async () => {
    writeClassic({ backend: "codex", backend_options: PERSONAL });
    const fm = fleet({ backend_options: { codex: { credential_profile: "team", provider: "openai" }, "kiro-cli": { credential_profile: "k" } } });
    const start = vi.spyOn(fm, "startInstance").mockResolvedValue(undefined);
    await (fm as any).startClassicInstance("classic-codex-bot", "codex");
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![1].backend_options).toEqual({
      codex: { credential_profile: "personal", provider: "openai" },
      "kiro-cli": { credential_profile: "k" },
    });
  });

  it("a channel without backend_options launches exactly as before", async () => {
    writeClassic({ backend: "codex" });
    const defaults = { backend_options: { codex: { provider: "openai" } } };
    const fm = fleet(defaults);
    const start = vi.spyOn(fm, "startInstance").mockResolvedValue(undefined);
    await (fm as any).startClassicInstance("classic-codex-bot", "codex");
    expect(start.mock.calls[0]![1].backend_options).toBe(defaults.backend_options);
  });

  it("kiro_engine_status reports the channel's profile", () => {
    writeClassic({ backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "second" } } });
    const candidates = kiroEngineCandidates({ defaults: {}, instances: {} } as any, manager());
    expect(candidates).toEqual([expect.objectContaining({ name: "classic-codex-bot", classic: true, credentialProfile: "second" })]);
  });
});

/** A running classic daemon whose config is what startClassicInstance launched it with. */
function runningDaemon(fm: FleetManager, channel: Record<string, unknown>, defaults: Record<string, any> = {}) {
  const launched = {
    backend: channel.backend as string,
    backend_options: mergeBackendOptions(defaults.backend_options, channel.backend_options as any),
  };
  fm.lifecycle.daemons.set("classic-codex-bot", { applyConfigUpdate: vi.fn(), getConfigSnapshot: () => launched } as any);
  mkdirSync(fm.getInstanceDir("classic-codex-bot"), { recursive: true });   // a running instance has one
}

describe("a profile edited in classicBot.yaml takes effect through a restart (the 30s poll)", () => {
  async function reload(from: Record<string, unknown>, to: Record<string, unknown>, defaults: Record<string, any> = {}) {
    const path = writeClassic(from);
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults, instances: {} } as any;
    fm.classicChannels = manager();
    runningDaemon(fm, from, defaults);
    const stop = vi.spyOn(fm, "stopInstance").mockResolvedValue(undefined);
    const start = vi.spyOn(fm as any, "startClassicInstanceUnattended").mockResolvedValue(true);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0 as any; }) as any);
    writeClassic(to);
    const future = new Date(Date.now() + 5_000);
    utimesSync(path, future, future);
    await (fm as any).reloadClassicConfigFromDisk();
    const fresh = existsSync(join(fm.getInstanceDir("classic-codex-bot"), "crash-state.json"));
    return { stop, start, fresh };
  }

  it("codex: restarted, and its conversation resumes (codex keeps history outside the login)", async () => {
    const { stop, start, fresh } = await reload({ backend: "codex" }, { backend: "codex", backend_options: PERSONAL });
    expect(stop).toHaveBeenCalledWith("classic-codex-bot");
    expect(start).toHaveBeenCalledOnce();
    expect(fresh).toBe(false);
  });

  it("kiro: restarted fresh — the other subscription holds other conversations", async () => {
    const { stop, start, fresh } = await reload(
      { backend: "kiro-cli" },
      { backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "second" } } },
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(fresh).toBe(true);
  });

  it("a backend change that also changes the login keeps the backend change's own restart (no fresh marker)", async () => {
    const { stop, start, fresh } = await reload(
      { backend: "codex", backend_options: PERSONAL },
      { backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "second" } } },
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(fresh).toBe(false);
  });

  it("an unrelated edit does not restart it", async () => {
    const { stop, start } = await reload(
      { backend: "codex", backend_options: PERSONAL },
      { backend: "codex", backend_options: PERSONAL, description: "renamed" },
    );
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("shared → invalid is a change, not \"null equals null\": the agent is stopped (r1 review)", async () => {
    const { stop } = await reload({ backend: "codex" }, { backend: "codex", backend_options: { codex: { credential_profile: "../escape" } } });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("inherited default → invalid override is a change too", async () => {
    const defaults = { backend_options: { codex: { credential_profile: "team" } } };
    const { stop } = await reload({ backend: "codex" }, { backend: "codex", backend_options: { codex: { credential_profile: 42 } } }, defaults);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("inherited default → explicit \"\" moves the agent to the shared login: restarted (r1 review)", async () => {
    const defaults = { backend_options: { codex: { credential_profile: "team" } } };
    const { stop, start } = await reload({ backend: "codex" }, { backend: "codex", backend_options: { codex: { credential_profile: "" } } }, defaults);
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });
});

describe("SIGHUP / reconcile applies a profile change too (r1 review)", () => {
  async function sighup(opts: { classicFrom: Record<string, unknown>; classicTo?: Record<string, unknown>; fleetFrom?: string; fleetTo?: string }) {
    const configPath = join(dir, "fleet.yaml");
    const fleetYaml = (profile?: string) => profile
      ? `defaults:\n  backend_options:\n    ${opts.classicFrom.backend}:\n      credential_profile: ${profile}\ninstances: {}\n`
      : "instances: {}\n";
    writeFileSync(configPath, fleetYaml(opts.fleetFrom));
    const classicPath = writeClassic(opts.classicFrom);
    const fm = new FleetManager(dir);
    fm.loadConfig(configPath);
    fm.classicChannels = manager();
    runningDaemon(fm, opts.classicFrom, fm.fleetConfig!.defaults as any);
    const stop = vi.spyOn(fm, "stopInstance").mockResolvedValue(undefined);
    const start = vi.spyOn(fm as any, "startClassicInstanceUnattended").mockResolvedValue(true);
    if (opts.classicTo) {
      writeClassic(opts.classicTo);
      const future = new Date(Date.now() + 5_000);
      utimesSync(classicPath, future, future);
    }
    writeFileSync(configPath, fleetYaml(opts.fleetTo));
    await (fm as any).reconcileInstances();
    // The SIGHUP consumed the classicBot.yaml change; the poller must not find another one.
    await (fm as any).reloadClassicConfigFromDisk();
    const fresh = existsSync(join(fm.getInstanceDir("classic-codex-bot"), "crash-state.json"));
    return { stop, start, fresh };
  }

  it("a classicBot.yaml profile-only edit (codex): restarted once, resumes", async () => {
    const { stop, start, fresh } = await sighup({ classicFrom: { backend: "codex" }, classicTo: { backend: "codex", backend_options: PERSONAL } });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(fresh).toBe(false);
  });

  it("a classicBot.yaml profile-only edit (kiro): restarted once, fresh", async () => {
    const { stop, start, fresh } = await sighup({
      classicFrom: { backend: "kiro-cli" },
      classicTo: { backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "second" } } },
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(fresh).toBe(true);
  });

  it("an inherited fleet-default profile change (kiro): restarted fresh; (codex): resumes", async () => {
    const kiro = await sighup({ classicFrom: { backend: "kiro-cli" }, fleetFrom: "team", fleetTo: "other" });
    expect(kiro.stop).toHaveBeenCalledOnce();
    expect(kiro.fresh).toBe(true);
    rmSync(join(dir, "instances"), { recursive: true, force: true });
    const codex = await sighup({ classicFrom: { backend: "codex" }, fleetFrom: "team", fleetTo: "other" });
    expect(codex.stop).toHaveBeenCalledOnce();
    expect(codex.fresh).toBe(false);
  });

  it("a fleet reload that leaves the login as it is does not restart", async () => {
    const { stop } = await sighup({ classicFrom: { backend: "codex", backend_options: PERSONAL }, fleetFrom: "team", fleetTo: "other" });
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("an invalid profile never launches on another login (r1 review)", () => {
  it.each([["../escape"], [42]])("cold start with %j: refused, nothing launched", async raw => {
    writeClassic({ backend: "codex", backend_options: { codex: { credential_profile: raw } } });
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults: { backend_options: { codex: { credential_profile: "team" } } }, instances: {} } as any;
    fm.classicChannels = manager();
    const start = vi.spyOn(fm, "startInstance").mockResolvedValue(undefined);
    await expect((fm as any).startClassicInstance("classic-codex-bot", "codex")).rejects.toThrow(/invalid credential_profile/);
    expect(start).not.toHaveBeenCalled();
  });

  it("explicit \"\" over a default: launch, binding and status all say the shared login", async () => {
    writeClassic({ backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "" } } });
    const defaults = { backend_options: { "kiro-cli": { credential_profile: "team" } } };
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults, instances: {} } as any;
    fm.classicChannels = manager();
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    const start = vi.spyOn(fm, "startInstance").mockResolvedValue(undefined);
    await (fm as any).startClassicInstance("classic-codex-bot", "kiro-cli");
    expect(start.mock.calls[0]![1].backend_options).toEqual({ "kiro-cli": { credential_profile: "" } });
    expect([...fm.getActiveUsageProviderIds()]).toEqual(["kiro"]);
    expect(kiroEngineCandidates({ defaults, instances: {} } as any, fm.classicChannels))
      .toEqual([expect.objectContaining({ credentialProfile: null })]);
  });

  it("a running instance's binding is the login it was launched on, until it is restarted", () => {
    writeClassic({ backend: "codex", backend_options: PERSONAL });
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults: {}, instances: {} } as any;
    fm.classicChannels = manager();
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    runningDaemon(fm, { backend: "codex" });
    expect([...fm.getActiveUsageProviderIds()]).toEqual(["codex"]);
  });
});

describe("usage rows include the subscriptions classic channels run on", () => {
  const base = [
    { id: "codex", name: "Codex", fetch: vi.fn(async () => ({ status: "ok" as const, metrics: [] })) },
    { id: "kiro", name: "Kiro", fetch: vi.fn(async () => ({ status: "ok" as const, metrics: [] })) },
  ];

  it("a classic channel on a profile adds that profile's row", () => {
    writeClassic({ backend: "codex", backend_options: PERSONAL });
    const config = withClassicBindings({ defaults: {}, instances: {} } as any, readClassicBindings(dir));
    expect(providersForConfig(config, base).map(p => `${p.id}=${p.name}`))
      .toEqual(["codex=Codex (default)", "codex:personal=Codex (personal)", "kiro=Kiro"]);
  });

  it("a classic kiro channel on the shared login keeps the shared row beside a profiled fleet instance", () => {
    writeClassic({ backend: "kiro-cli" });
    const fleetOnly = { defaults: {}, instances: { a: { backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "work" } } } } } as any;
    expect(providersForConfig(fleetOnly, base).map(p => p.id)).toEqual(["codex", "kiro:work"]);
    expect(providersForConfig(withClassicBindings(fleetOnly, readClassicBindings(dir)), base).map(p => p.id))
      .toEqual(["codex", "kiro", "kiro:work"]);
  });

  it("the classic default backend and the fleet default backend both apply", () => {
    writeClassic({ backend_options: { "kiro-cli": { credential_profile: "second" } } }, { backend: "kiro-cli" });
    const bindings = readClassicBindings(dir);
    expect(bindings).toEqual([{ key: KEY, backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "second" } } }]);
    writeClassic({ backend_options: PERSONAL });
    const viaFleet = withClassicBindings({ defaults: { backend: "codex" }, instances: {} } as any, readClassicBindings(dir));
    expect(providersForConfig(viaFleet, base).map(p => p.id)).toContain("codex:personal");
  });

  it.each([
    ["42", { credential_profile: 42 }, []],
    ["true", { credential_profile: true }, []],
    ["null (shared, like \"\" — the launch merge lays it over the default)", { credential_profile: null }, ["codex"]],
    ["\"\" (shared, over the default)", { credential_profile: "" }, ["codex"]],
    ["unset (inherits the default)", {}, ["codex:team"]],
  ])("manager, reader and rows agree for %s with a default of team (r1 review)", (_name, codex, rows) => {
    writeClassic({ backend: "codex", backend_options: { codex } });
    const defaults = { backend_options: { codex: { credential_profile: "team" } } };
    const managed = manager().getCredentialProfileByInstance("classic-codex-bot", defaults);
    const config = withClassicBindings({ defaults, instances: {} } as any, readClassicBindings(dir));
    const classicRows = providersForConfig(config, base).map(p => p.id).filter(id => id.startsWith("codex"));
    const bound = config.instances[`classic:${KEY}`] as { classicProfile?: string | null } | undefined;
    if (managed.state === "invalid") {
      expect(bound, "an invalid channel binds no subscription").toBeUndefined();
      expect(classicRows).not.toContain("codex:42");
    } else {
      expect(bound?.classicProfile ?? null).toBe(managed.state === "profile" ? managed.name : null);
      for (const row of rows) expect(classicRows).toContain(row);
    }
  });

  it("the usage snapshot itself reads classicBot.yaml beside fleet.yaml", async () => {
    writeFileSync(join(dir, "fleet.yaml"), "instances: {}\n");
    writeClassic({ backend: "codex", backend_options: PERSONAL });
    setUsageProvidersForTests([{
      id: "codex", name: "Codex",
      fetch: async (home?: string) => ({ status: "ok", plan: home ?? "shared", metrics: [] }),
    }] as never);
    try {
      const payload = await fetchAllUsage();
      expect(payload.providers.map(p => p.id)).toEqual(["codex", "codex:personal"]);
      expect(payload.providers[1]!.plan).toContain(join("credential-profiles", "codex", "personal"));
    } finally {
      setUsageProvidersForTests(null);
    }
  });

  it("no classicBot.yaml, or an unreadable one, is no classic channels", () => {
    expect(readClassicBindings(dir)).toEqual([]);
    writeFileSync(join(dir, "classicBot.yaml"), "channels: [: not yaml");
    expect(readClassicBindings(dir)).toEqual([]);
  });
});
