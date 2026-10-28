import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigHistory, ConfigSyntaxError, checkConfigSyntax, configIssueText, type ConfigFile } from "../src/config-history.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { deriveNeedsYou, itemsForWorld, renderLiveMessage } from "../src/needs-you.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => { setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function rig(file: ConfigFile = "fleet.yaml") {
  const home = mkdtempSync(join(tmpdir(), "agend-config-2829-")); dirs.push(home);
  const path = join(home, file), changed = vi.fn(), warn = vi.fn();
  const history = new ConfigHistory(home, changed, warn);
  const good = file === "fleet.yaml" ? "defaults: {}\ninstances: {}\n" : "defaults: {}\nchannels: {}\n";
  const bad = "defaults:\n  display_name: first\n  display_name: secret-notice-must-not-leak\n";
  writeFileSync(path, good);
  const accept = () => history.accepted(file, path, history.read(file, path));
  const rows = () => { const db = new Database(history.dbPath); try { return db.prepare("SELECT * FROM config_versions ORDER BY id").all() as any[]; } finally { db.close(); } };
  return { home, path, history, changed, warn, good, bad, accept, rows, file };
}
const logger: any = { info() {}, warn() {}, error() {}, debug() {} };

describe("valid source history", () => {
  it.each(["fleet.yaml", "classicBot.yaml"] as const)("keeps five changed copies of %s, not duplicate reads", file => {
    const r = rig(file); r.accept(); r.accept(); expect(r.rows()).toHaveLength(1);
    for (let n = 1; n <= 6; n++) { writeFileSync(r.path, `# version ${n}\n` + r.good); r.accept(); }
    expect(r.rows()).toHaveLength(5); expect(r.rows()[0].content).toContain("version 2");
    writeFileSync(r.path, r.good); r.accept(); expect(r.rows().at(-1).content).toBe(r.good); // A -> B -> A
    expect(statSync(r.history.dbPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(r.home).filter(n => n.startsWith("config-history.db-"))).toEqual([]);
  });
  it("keeps independent file/path histories, never borrows another source's copy", () => {
    const r = rig(); r.accept();
    const classic = join(r.home, "classicBot.yaml"); writeFileSync(classic, r.bad);
    expect(() => r.history.read("classicBot.yaml", classic, true)).toThrow("No usable stored valid copy");
    const other = join(r.home, "other.yaml"); writeFileSync(other, r.bad);
    expect(() => r.history.read("fleet.yaml", other, true)).toThrow("No usable stored valid copy");
    expect(r.rows()).toHaveLength(1);
  });
  it("does not archive syntax errors or parseable schema errors", () => {
    const r = rig(); r.accept(); writeFileSync(r.path, r.bad);
    expect(() => r.history.read(r.file, r.path)).toThrow(ConfigSyntaxError);
    writeFileSync(r.path, "instances: []\n"); r.accept();
    expect(r.rows()).toHaveLength(1);
    expect(r.history.read(r.file, r.path, true).source).toBe("instances: []\n"); // no schema fallback
  });
  it("healthy configuration does not depend on a writable history database", () => {
    const r = rig(); writeFileSync(r.history.dbPath, "not sqlite");
    expect(r.accept).not.toThrow(); expect(r.warn).toHaveBeenCalledOnce();
    writeFileSync(r.path, r.bad);
    expect(() => r.history.read(r.file, r.path, true)).toThrow("history DB unreadable");
  });
});

describe("safe parser diagnostics", () => {
  for (const file of ["fleet.yaml", "classicBot.yaml"] as const) {
    it.each([
      ["alias", "defaults:\n  model: *PRIVATE_CONFIG_SECRET\n", "Invalid YAML alias"],
      ["tag", "defaults:\n  model: !PRIVATE_CONFIG_SECRET value\n", "Invalid YAML tag"],
      ["directive", "%TAG !PRIVATE_CONFIG_SECRET!\n---\ndefaults: {}\n", "Invalid YAML directive"],
      ["escape", 'defaults:\n  model: "\\qPRIVATE_CONFIG_SECRET"\n', "Invalid YAML escape sequence"],
    ])(`${file}: source-derived %s is absent from live, fallback and startup messages`, (_kind, source, category) => {
      const r = rig(file); r.accept(); writeFileSync(r.path, source);
      r.history.check();
      const live = r.history.currentIssues()[0]!;
      expect(live).toMatchObject({ file, mode: "edit", reason: category });
      expect(live.line).toBeGreaterThan(0); expect(live.column).toBeGreaterThan(0);
      const fallback = new ConfigHistory(r.home); expect(fallback.read(file, r.path, true).fallback).toBe(true);
      for (const locale of ["en", "zh-TW"] as const) {
        setLocale(locale);
        for (const issue of [live, fallback.currentIssues()[0]!]) {
          const detail = configIssueText(issue, t);
          expect(detail).toContain(category); expect(detail).not.toContain("PRIVATE_CONFIG_SECRET");
        }
        const emptyHome = mkdtempSync(join(tmpdir(), "agend-config-empty-2829-")); dirs.push(emptyHome);
        try { new ConfigHistory(emptyHome).read(file, r.path, true); throw Error("expected startup refusal"); }
        catch (error) {
          expect(String(error)).toContain(category); expect(String(error)).not.toContain("PRIVATE_CONFIG_SECRET");
        }
      }
      expect(() => r.history.read(file, r.path)).toThrow(ConfigSyntaxError); // live reload remains strict
      expect(r.rows()).toHaveLength(1); // invalid source never enters history
    });
  }
});

describe("parse-only startup recovery and passive warnings", () => {
  it.each(["fleet.yaml", "classicBot.yaml"] as const)("warns once, then recovers %s without changing it", file => {
    const r = rig(file); r.accept(); r.history.check(); writeFileSync(r.path, r.bad);
    r.history.check(); const issue = r.history.currentIssues()[0]!;
    expect(issue).toMatchObject({ mode: "edit", file, line: 3, column: 3 });
    expect(issue.time).toBeTruthy(); expect(JSON.stringify(issue)).not.toContain("secret-notice");
    const calls = r.changed.mock.calls.length; r.history.check(); r.history.check();
    expect(r.changed).toHaveBeenCalledTimes(calls);
    expect(() => r.history.read(file, r.path)).toThrow(ConfigSyntaxError); // live reload never falls back
    const reboot = new ConfigHistory(r.home);
    const chosen = reboot.read(file, r.path, true);
    expect(chosen).toMatchObject({ source: r.good, fallback: true });
    reboot.accepted(file, r.path, chosen);
    expect(reboot.currentIssues()[0]).toMatchObject({ mode: "fallback", file });
    expect(r.rows()).toHaveLength(1); expect(readFileSync(r.path, "utf8")).toBe(r.bad);
    writeFileSync(r.path, r.good); reboot.check(); // repaired but not loaded yet
    expect(reboot.currentIssues()).toHaveLength(1);
    reboot.accepted(file, r.path, reboot.read(file, r.path));
    expect(reboot.currentIssues()).toEqual([]); expect(reboot.isFallback(r.path)).toBe(false);
  });
  it("A clears on parse repair; repeated bad edits keep one occurrence", () => {
    const r = rig(); r.accept(); r.history.check(); writeFileSync(r.path, r.bad); r.history.check();
    const first = r.history.currentIssues()[0]!;
    writeFileSync(r.path, "\n" + r.bad); r.history.check();
    expect(r.history.currentIssues()).toHaveLength(1); expect(r.history.currentIssues()[0]!.since).toBe(first.since);
    writeFileSync(r.path, r.good); r.history.check(); expect(r.history.currentIssues()).toEqual([]);
  });
  it.each(["absent", "corrupt", "checksum", "schema", "symlink", "private"])("no unsafe fallback with %s history", mode => {
    const r = rig();
    if (mode !== "absent") r.accept();
    if (mode === "corrupt") writeFileSync(r.history.dbPath, "broken sqlite");
    if (mode === "checksum" || mode === "schema") {
      const db = new Database(r.history.dbPath);
      if (mode === "checksum") db.prepare("UPDATE config_versions SET content='changed'").run();
      else db.prepare("UPDATE config_versions SET content=?,hash=?").run("instances: []\n", requireHash("instances: []\n"));
      db.close();
    }
    if (mode === "symlink") { rmSync(r.history.dbPath); symlinkSync("missing", r.history.dbPath); }
    if (mode === "private") chmodSync(r.history.dbPath, 0o644);
    writeFileSync(r.path, r.bad);
    expect(() => r.history.read(r.file, r.path, true)).toThrow(/Cannot start: fleet.yaml, line 3, column 3/);
    expect(readFileSync(r.path, "utf8")).toBe(r.bad);
  });
  it("missing files and alias safety errors never select a backup", () => {
    const r = rig(); r.accept(); rmSync(r.path);
    expect(() => r.history.read(r.file, r.path, true)).toThrow(/ENOENT/);
    writeFileSync(r.path, "defaults: &loop\n  loop: *loop\n");
    expect(() => r.history.read(r.file, r.path, true)).toThrow(/recursive alias/);
    expect(r.history.currentIssues()).toEqual([]);
  });
  it("retains exact safe parser location, without a source excerpt", () => {
    expect(() => checkConfigSyntax("defaults:\n  model: [\n", "fleet.yaml")).toThrow(ConfigSyntaxError);
    const r = rig(); writeFileSync(r.path, r.bad);
    try { r.history.read(r.file, r.path); } catch (e) { expect(String(e)).not.toContain("secret-notice"); }
    expect(r.history.currentIssues()[0]!.time).toBeUndefined();
  });
});

import { createHash } from "node:crypto";
const requireHash = (s: string) => createHash("sha256").update(s).digest("hex");

describe("Classic and Needs-you integration", () => {
  it("Classic cold parse failure is explicit; a good copy preserves rooms without repair writes", () => {
    const r = rig("classicBot.yaml");
    writeFileSync(r.path, "channels:\n  '-123':\n    name: example\n    backend: mock\n");
    const first = new ClassicChannelManager(r.home, logger, r.history);
    expect(first.getAll()).toHaveLength(1); writeFileSync(r.path, r.bad);
    const recovered = new ClassicChannelManager(r.home, logger, new ConfigHistory(r.home));
    recovered.configureAdapters([{ id: "tg", type: "telegram" }]);
    expect(recovered.getAll()).toHaveLength(1); expect(readFileSync(r.path, "utf8")).toBe(r.bad);
    rmSync(r.history.dbPath);
    expect(() => new ClassicChannelManager(r.home, logger)).toThrow("Cannot start: classicBot.yaml");
  });
  it("derives one fleet-wide item with full body and routes only to its owner", () => {
    const r = rig(); r.accept(); writeFileSync(r.path, r.bad); expect(() => r.history.read(r.file, r.path)).toThrow();
    const issue = r.history.currentIssues()[0]!;
    const items = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], ownerOf: () => undefined,
      configIssues: [{ ...issue, detail: configIssueText(issue, t), owner: "primary" }] });
    expect(items).toHaveLength(1); expect(items[0]!.reason).toBe("config_invalid");
    expect(itemsForWorld(items, "primary")).toHaveLength(1); expect(itemsForWorld(items, "other")).toEqual([]);
    const rendered = renderLiveMessage([{ item: items[0]!, title: t("needs.reason.config_invalid") + ": " + items[0]!.detail }], Date.now(), t);
    expect(rendered.text).toContain("The next restart would use"); expect(rendered.ackable).toEqual([]);
    expect(configIssueText(issue, t)).toContain("the file has not been changed by AgEnD");
    setLocale("zh-TW"); expect(configIssueText(issue, t)).toContain("下次重新啟動會改用");
  });
});

import { FleetManager } from "../src/fleet-manager.js";
describe("Fleet loader and reload integration", () => {
  it("carries the stored raw/effective view, refuses writes, and never posts a second reload alert", async () => {
    const r = rig(); writeFileSync(r.path, "defaults:\n  locale: en\nfleet_label: original\ninstances: {}\n");
    const first = new FleetManager(r.home); first.loadConfig(r.path);
    writeFileSync(r.path, r.bad);
    const recovered: any = new FleetManager(r.home);
    recovered.logger = logger;
    expect(recovered.loadConfig(r.path, { startup: true }).fleet_label).toBe("original");
    expect(recovered.getRawFleetConfig().fleet_label).toBe("original");
    const officeMigration = vi.spyOn(recovered, "migrateOfficeStorage");
    const noticeMigration = vi.spyOn(recovered, "migrateNoticeDeliveryStorage");
    recovered.slimFleetConfigAtStartup();
    expect(officeMigration).not.toHaveBeenCalled(); expect(noticeMigration).not.toHaveBeenCalled();
    expect(() => recovered.saveFleetConfig()).toThrow();
    expect(readFileSync(r.path, "utf8")).toBe(r.bad);
    const notify = vi.spyOn(recovered, "notifyFleetError");
    recovered.startupComplete = true;
    recovered.scheduleReconcile();
    await recovered.reconcileInFlight;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(notify).not.toHaveBeenCalled();
    expect(recovered.getConfigHistory().currentIssues()).toHaveLength(1);
    expect(recovered.fleetConfig.fleet_label).toBe("original");
  });
  it("notices a newly-created invalid optional Classic file", () => {
    const r = rig("classicBot.yaml"); rmSync(r.path);
    new ClassicChannelManager(r.home, logger, r.history);
    r.history.check(); writeFileSync(r.path, r.bad); r.history.check();
    expect(r.history.currentIssues()).toMatchObject([{ file: "classicBot.yaml", mode: "edit" }]);
  });
  it("never records a rejected bulk-removal reload", async () => {
    const r = rig(); writeFileSync(r.path, `instances:\n  alpha:\n    working_directory: ${r.home}\n`);
    const fm: any = new FleetManager(r.home); fm.logger = logger; fm.loadConfig(r.path);
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    writeFileSync(r.path, r.good);
    expect((await fm.reconcileInstances()).rejected).toBeTruthy();
    expect(r.rows()).toHaveLength(1); expect(fm.fleetConfig.instances.alpha).toBeDefined();
  });
});

import { startFleetOrExit } from "../src/fleet-process-handlers.js";
import { ConfigStartupError } from "../src/config-history.js";
it("exits a deliberate no-history cold refusal; other rejection policy stays unchanged", async () => {
  const manager = { startAll: vi.fn(async () => { throw new ConfigStartupError("Cannot start: fleet.yaml"); }), stopAll: vi.fn(async () => {}) };
  const runtime = { exit: vi.fn() as any }, output = { error: vi.fn() };
  await startFleetOrExit(manager, "/private/fleet.yaml", runtime, output);
  expect(output.error).toHaveBeenCalledWith("Cannot start: fleet.yaml");
  expect(manager.stopAll).toHaveBeenCalledOnce(); expect(runtime.exit).toHaveBeenCalledWith(1);
  manager.startAll.mockImplementation(async () => { throw Error("unrelated"); });
  await expect(startFleetOrExit(manager, "/private/fleet.yaml", runtime, output)).rejects.toThrow("unrelated");
  expect(runtime.exit).toHaveBeenCalledTimes(1);
});

it("localizes the full configuration body in the web renderer", async () => {
  // @ts-expect-error browser JavaScript is exercised through Vite; it has no declaration file.
  const { configDetail } = await import("../src/ui/shared/app-needs.js");
  // @ts-expect-error browser JavaScript is exercised through Vite; it has no declaration file.
  const { setLang } = await import("../src/ui/shared/app-i18n.js");
  const item = { configIssue: { file: "fleet.yaml", line: 3, column: 2, reason: "Map keys must be unique", time: "2026-10-28T12:00:00Z", mode: "fallback" } };
  setLang("en", { store: false }); expect(configDetail(item)).toContain("fleet.yaml, line 3, column 2");
  setLang("zh-TW", { store: false }); expect(configDetail(item)).toContain("fleet.yaml 第 3 行、第 2 欄");
  expect(configDetail(item)).toContain("2026-10-28T12:00:00Z");
  setLang("en", { store: false });
});

it("binds a loaded source to the read-time canonical path, not a retargeted symlink", () => {
  const r = rig(), link = join(r.home, "active.yaml"), other = join(r.home, "new.yaml");
  symlinkSync(r.path, link); const selected = r.history.read("fleet.yaml", link);
  writeFileSync(other, r.bad); rmSync(link); symlinkSync(other, link);
  r.history.accepted("fleet.yaml", link, selected);
  expect(r.rows()[0].path).toBe(r.path);
  expect(() => r.history.read("fleet.yaml", link, true)).toThrow("No usable stored valid copy");
});

it("bounds cleanup before a deliberate startup-failure exit", async () => {
  vi.useFakeTimers();
  try {
    const runtime = { exit: vi.fn() as any };
    const done = startFleetOrExit({ startAll: async () => { throw new ConfigStartupError("Cannot start"); }, stopAll: () => new Promise(() => {}) },
      "/private/fleet.yaml", runtime, { error() {} });
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(runtime.exit).toHaveBeenCalledWith(1);
  } finally { vi.useRealTimers(); }
});
