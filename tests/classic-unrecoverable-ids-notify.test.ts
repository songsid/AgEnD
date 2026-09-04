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
    // An adapter must exist: with none, the report is correctly deferred rather
    // than burning notifyFleetError's throttle key on an undeliverable message
    // (see "the report must survive having no adapter yet" below).
    const adapter = { id: "telegram", type: "telegram", sendText: vi.fn().mockResolvedValue(undefined) } as any;
    fm.adapter = adapter;
    fm.adapters.set("telegram", adapter);
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

/**
 * Found by fable in review: the initial report ran at ClassicChannelManager
 * construction, ~300 lines of startAll() before any adapter existed. It was
 * dropped silently by notifyInstanceTopic's `if (!adapter) return`, AND
 * notifyFleetError had already claimed its throttle key on the way out — so the
 * most common case (a bad id present at boot) told the operator nothing for ten
 * minutes, with the only re-trigger being a file mtime change.
 *
 * These drive the REAL notifyFleetError. The original tests stubbed it, which
 * is exactly why they could not see this.
 */
describe("the report must survive having no adapter yet", () => {
  function makeFleet(bad: Array<{ field: string; value: number }>) {
    const dir = mkdtempSync(join(tmpdir(), "agend-unrecboot-"));
    dirs.push(dir);
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = {
      defaults: {}, channel: { group_id: "g1" },
      instances: { general: { general_topic: true, topic_id: "t1" } },
    };
    fm.classicChannels = { getUnrecoverableIds: () => bad };
    return fm;
  }
  const BAD = [{ field: "allowed_guilds", value: 1496407196106494000 }];

  it("does not spend the throttle key when there is nowhere to deliver", () => {
    const fm = makeFleet(BAD);
    fm.adapter = null;                       // startAll() before startSharedAdapter

    fm.reportClassicUnrecoverableIds();

    // The key must stay unspent, or the real report ten seconds later is eaten.
    expect(fm.fleetErrorNotices.size).toBe(0);
  });

  it("still reports once an adapter is up", () => {
    const fm = makeFleet(BAD);
    fm.adapter = null;
    fm.reportClassicUnrecoverableIds();       // deferred, key unspent

    const sendText = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "telegram", type: "telegram", sendText } as any;
    fm.adapter = adapter;
    fm.adapters.set("telegram", adapter);

    fm.reportClassicUnrecoverableIds();

    expect(sendText).toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).toContain("allowed_guilds");
  });

  it("reaches the operator on the boot path, not just on a file edit", async () => {
    // The scenario that mattered: bad id already in the file at startup. The
    // call site must sit after the adapter exists, so this asserts delivery
    // through the real notifyFleetError rather than a stub.
    const fm = makeFleet(BAD);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "telegram", type: "telegram", sendText } as any;
    fm.adapter = adapter;
    fm.adapters.set("telegram", adapter);

    fm.reportClassicUnrecoverableIds();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(fm.fleetErrorNotices.size).toBe(1);   // now the key is legitimately spent
  });
});

/**
 * The call-site ordering is the actual fix, and calling the method directly
 * cannot see it. This pins the invariant structurally: the boot-time report
 * must sit AFTER the shared adapter is started, because before that there is
 * nowhere to deliver and notifyFleetError would burn its throttle key.
 *
 * A source-shape assertion is blunt, but the alternative is a full startAll()
 * e2e, and the failure it guards (silent at boot, silent for ten minutes after)
 * is precisely the bug this PR exists to remove.
 */
describe("startAll orders the boot report after the adapter", () => {
  it("does not report before the shared adapter is started", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf-8");

    const adapterStart = src.indexOf("await this.startSharedAdapter(fleet);");
    expect(adapterStart).toBeGreaterThan(-1);

    // Narrow to the construction block itself. The reload poll is registered in
    // this same stretch and legitimately reports — but from a timer that fires
    // long after startup, so a plain source-order check cannot tell them apart.
    const ctor = src.indexOf("this.classicChannels = new ClassicChannelManager(");
    expect(ctor).toBeGreaterThan(-1);
    const constructionBlock = src.slice(ctor, ctor + 800);
    expect(constructionBlock).toContain("configureAdapters(classicAdapters)");
    expect(constructionBlock).not.toContain("this.reportClassicUnrecoverableIds();");

    // ...and one must follow it, or a bad id present at boot is never surfaced.
    expect(src.slice(adapterStart)).toContain("this.reportClassicUnrecoverableIds();");
  });
});
