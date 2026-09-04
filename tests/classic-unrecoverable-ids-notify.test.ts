import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * An id YAML already truncated can never match, and until now the only record
 * was a line in daemon.log. For an operator who does not read daemon.log that
 * is still silence — the exact failure this line of work set out to remove.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeManager(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-unrec-"));
  dirs.push(dir);
  writeFileSync(join(dir, "classicBot.yaml"), yaml);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
  return { m: new ClassicChannelManager(dir, logger) as any, dir, logger };
}

describe("getUnrecoverableIds", () => {
  it("reports a truncated id with the field it came from", () => {
    const { m } = makeManager('defaults:\n  allowed_guilds: [1496407196106494055]\n');
    expect(m.getUnrecoverableIds()).toEqual([
      { field: "allowed_guilds", value: 1496407196106494000 },
    ]);
  });

  it("stays empty for ids that are fine", () => {
    // Quoted ids, and unquoted ones small enough to survive YAML exactly.
    const { m } = makeManager('defaults:\n  allowed_guilds: ["g1", 111]\n  allowed_groups: [-1001234567890]\n');
    expect(m.getUnrecoverableIds()).toEqual([]);
  });

  it("scans all four lists", () => {
    const { m } = makeManager(
      'defaults:\n  allowed_guilds: [1496407196106494055]\n  admin_users: [1496407196106494066]\n',
    );
    expect(m.getUnrecoverableIds().map((e: any) => e.field).sort())
      .toEqual(["admin_users", "allowed_guilds"]);
  });

  it("clears once the operator fixes the file", () => {
    // Recomputed per load, so a corrected config stops reporting rather than
    // nagging until restart.
    const { m, dir } = makeManager('defaults:\n  allowed_guilds: [1496407196106494055]\n');
    expect(m.getUnrecoverableIds()).toHaveLength(1);

    writeFileSync(join(dir, "classicBot.yaml"), 'defaults:\n  allowed_guilds: ["1496407196106494055"]\n');
    m.reloadFromDisk();
    expect(m.getUnrecoverableIds()).toEqual([]);
  });
});

describe("surfacing to the operator", () => {
  function makeFleet(bad: Array<{ field: string; value: number }>) {
    const dir = mkdtempSync(join(tmpdir(), "agend-unrecfm-"));
    dirs.push(dir);
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = { defaults: {}, channel: { group_id: "g1" }, instances: {} };
    fm.classicChannels = { getUnrecoverableIds: () => bad };
    const notices: string[] = [];
    fm.notifyFleetError = vi.fn((t: string) => { notices.push(t); });
    return { fm, notices };
  }

  it("notifies once, naming the field and value", () => {
    const { fm, notices } = makeFleet([{ field: "allowed_guilds", value: 1496407196106494000 }]);
    fm.reportClassicUnrecoverableIds();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("allowed_guilds");
    expect(notices[0]).toContain("1496407196106494000");
  });

  it("tells the operator NOT to copy the id from the file", () => {
    // save() re-dumps the truncated number, so quoting what is on disk would
    // enshrine the wrong id and look like a fix.
    const { fm, notices } = makeFleet([{ field: "allowed_guilds", value: 1496407196106494000 }]);
    fm.reportClassicUnrecoverableIds();
    expect(notices[0]).toMatch(/do not copy|不要從檔案複製/i);
  });

  it("says nothing when the config is clean", () => {
    const { fm, notices } = makeFleet([]);
    fm.reportClassicUnrecoverableIds();
    expect(notices).toHaveLength(0);
  });

  it("leans on notifyFleetError's throttle rather than its own state", () => {
    // The 30s reload poll calls this repeatedly; suppression is notifyFleetError's
    // job (10 min, keyed by text), so this must not add a second mechanism that
    // could permanently swallow a still-broken config.
    const { fm, notices } = makeFleet([{ field: "allowed_guilds", value: 1496407196106494000 }]);
    fm.reportClassicUnrecoverableIds();
    fm.reportClassicUnrecoverableIds();
    expect(notices).toHaveLength(2);   // both reach notifyFleetError, which throttles
  });
});
