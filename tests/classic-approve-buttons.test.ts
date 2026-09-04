import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * ClassicBot access requests reached the General topic as plain text telling an
 * admin which file to edit by hand. These add Yes/No buttons.
 *
 * Two affirmative buttons when the trigger names a user: allowing a group to
 * talk and granting that person ClassicBot admin (start/stop/model on classic
 * channels — not fleet admin) have different blast radii, and bundling them
 * would force anyone wanting only the cheap one to accept the expensive one.
 */
const dirs: string[] = [];
function makeFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-classicapprove-"));
  dirs.push(dir);
  const notifyAlert = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "g1", threadId: "t1" });
  const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
  const adapter = { id: "telegram", type: "telegram", notifyAlert, sendText: vi.fn().mockResolvedValue(undefined), editMessageRemoveButtons } as any;
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = {
    defaults: {}, channel: { group_id: "g1" },
    instances: { general: { general_topic: true, topic_id: "t1" } },
  };
  fm.adapters.set(adapter.id, adapter);
  fm.adapter = adapter;
  fm.worlds.set("telegram", { id: "telegram", adapter, groupId: "g1" });
  fm.isFleetAdmin = vi.fn(() => true);
  const writes: Array<[string, string]> = [];
  fm.classicChannels = {
    allowGuild: vi.fn((id: string) => { writes.push(["allowed_guilds", id]); return "added"; }),
    allowGroup: vi.fn((id: string) => { writes.push(["allowed_groups", id]); return "added"; }),
    addAdminUser: vi.fn((id: string) => { writes.push(["admin_users", id]); return "added"; }),
  };
  const notified: Array<[string, string]> = [];
  fm.notifyInstanceTopic = vi.fn((n: string, txt: string) => { notified.push([n, txt]); });
  return { fm, adapter, notifyAlert, editMessageRemoveButtons, notified, writes };
}
const pick = (notifyAlert: any, action: string) =>
  notifyAlert.mock.calls[0][1].choices.find((c: any) => c.id.endsWith(`:${action}`));
const cb = (id: string, over: Record<string, unknown> = {}) =>
  ({ callbackData: id, chatId: "g1", threadId: "t1", messageId: "m1", userId: "admin", ...over }) as any;

describe("ClassicBot approval buttons", () => {
  it("offers only allow/ignore when no user is known (bot added to a server)", async () => {
    const { fm, notifyAlert } = makeFleet();
    await fm.promptClassicApproval({ generalName: "general", message: "bot added", groupId: "guild-9", scope: "guild" });

    const actions = notifyAlert.mock.calls[0][1].choices.map((c: any) => c.id.split(":").pop());
    // Nobody has run /start yet, so there is no one to promote.
    expect(actions).toEqual(["allow", "ignore"]);
  });

  it("offers a separate allow+admin button when a user asked", async () => {
    const { fm, notifyAlert } = makeFleet();
    await fm.promptClassicApproval({ generalName: "general", message: "/start", groupId: "grp-1", scope: "group", userId: "u-7" });

    const actions = notifyAlert.mock.calls[0][1].choices.map((c: any) => c.id.split(":").pop());
    expect(actions).toEqual(["allow", "allow-admin", "ignore"]);
  });

  it("ignore changes no config and says so", async () => {
    const { fm, notifyAlert, editMessageRemoveButtons, notified } = makeFleet();
    await fm.promptClassicApproval({ generalName: "general", message: "/start", groupId: "grp-1", scope: "group", userId: "u-7" });
    notified.length = 0;

    expect(await fm.handleClassicApproval(cb(pick(notifyAlert, "ignore").id), "telegram", null)).toBe(true);

    expect(notified).toHaveLength(0);                        // no approval task
    expect(editMessageRemoveButtons).toHaveBeenCalled();     // buttons retired
    expect(String(editMessageRemoveButtons.mock.calls.at(-1)![2])).toMatch(/Ignored|忽略/);
  });

  it("allow grants the group only — never the admin promotion", async () => {
    const { fm, notifyAlert, notified, writes } = makeFleet();
    await fm.promptClassicApproval({ generalName: "general", message: "/start", groupId: "grp-1", scope: "group", userId: "u-7" });
    notified.length = 0;

    await fm.handleClassicApproval(cb(pick(notifyAlert, "allow").id), "telegram", null);

    expect(writes).toEqual([["allowed_groups", "grp-1"]]);   // group, not guild
    expect(writes.some(([f]) => f === "admin_users")).toBe(false); // cheap stays cheap
    expect(notified).toHaveLength(1);
  });

  it("allow-admin grants both, and names the user", async () => {
    const { fm, notifyAlert, notified, writes } = makeFleet();
    await fm.promptClassicApproval({ generalName: "general", message: "/start", groupId: "grp-1", scope: "group", userId: "u-7" });
    notified.length = 0;

    await fm.handleClassicApproval(cb(pick(notifyAlert, "allow-admin").id), "telegram", null);

    expect(writes).toEqual([["allowed_groups", "grp-1"], ["admin_users", "u-7"]]);
  });

  it("always demands a quoted string for the id", async () => {
    // A Discord snowflake exceeds 2^53; as a bare YAML integer it loses
    // precision and silently stops matching.
    const { fm, notifyAlert, notified, writes } = makeFleet();
    await fm.promptClassicApproval({ generalName: "general", message: "x", groupId: "1496407196106494055", scope: "guild" });
    notified.length = 0;
    await fm.handleClassicApproval(cb(pick(notifyAlert, "allow").id), "telegram", null);

    // The mutator stores String(id); the assertion pins the id survives intact.
    expect(writes).toEqual([["allowed_guilds", "1496407196106494055"]]);
  });

  it("answers in a Telegram General topic (#682 canonical binding)", async () => {
    // Telegram represents General as topic "1" on input but omits
    // message_thread_id on the wire and in callback queries.
    const { fm, notifyAlert, notified, writes } = makeFleet();
    fm.fleetConfig.instances.general.topic_id = "1";
    notifyAlert.mockResolvedValue({ messageId: "m1", chatId: "g1", threadId: undefined });

    await fm.promptClassicApproval({ generalName: "general", message: "x", groupId: "grp-1", scope: "guild" });
    notified.length = 0;

    const handled = await fm.handleClassicApproval(
      cb(pick(notifyAlert, "allow").id, { threadId: undefined }), "telegram", null,
    );

    expect(handled).toBe(true);
    expect(notified).toHaveLength(1);
  });

  it("refuses a non-admin click without changing anything", async () => {
    const { fm, notifyAlert, notified, writes } = makeFleet();
    await fm.promptClassicApproval({ generalName: "general", message: "x", groupId: "grp-1", scope: "guild" });
    fm.isFleetAdmin = vi.fn(() => false);
    notified.length = 0;

    await fm.handleClassicApproval(cb(pick(notifyAlert, "allow").id, { userId: "intruder" }), "telegram", null);

    expect(notified).toHaveLength(0);
  });

  it("falls back to a plain notification when the buttons cannot be addressed", async () => {
    // Losing the request entirely because the topic could not be resolved would
    // be worse than losing the buttons.
    const { fm, notified } = makeFleet();
    fm.getGroupIdForInstance = vi.fn(() => "");

    await fm.promptClassicApproval({ generalName: "general", message: "bot added", groupId: "grp-1", scope: "guild" });

    expect(notified).toHaveLength(1);
    expect(notified[0][1]).toBe("bot added");
  });
});

describe("ClassicChannelManager access mutators", () => {
  async function makeManager(yaml: string) {
    const dir = mkdtempSync(join(tmpdir(), "agend-classicmut-"));
    dirs.push(dir);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "classicBot.yaml"), yaml);
    const { ClassicChannelManager } = await import("../src/classic-channel-manager.js");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const m = new ClassicChannelManager(dir, logger) as any;
    return { m, dir };
  }
  const read = async (dir: string) => {
    const { readFileSync } = await import("node:fs");
    const yaml = await import("js-yaml");
    return yaml.load(readFileSync(join(dir, "classicBot.yaml"), "utf-8")) as any;
  };

  it("stores a Discord snowflake as a quoted string, not a YAML integer", async () => {
    // 1496407196106494055 > 2^53: as a bare integer it loses precision, and the
    // strict includes() in isGuildAllowed then stops matching it.
    const { m, dir } = await makeManager('defaults:\n  allowed_guilds: ["111"]\n');
    expect(m.allowGuild("1496407196106494055")).toBe("added");

    const raw = await read(dir);
    expect(raw.defaults.allowed_guilds).toContain("1496407196106494055");
    for (const v of raw.defaults.allowed_guilds) expect(typeof v).toBe("string");
    expect(m.isGuildAllowed("1496407196106494055")).toBe(true);   // in-memory, no reload
  });

  it("refuses to turn an allow-all list into an allow-list of one", async () => {
    // Empty allowed_guilds means allow-all. Writing the first entry would lock
    // out every guild that works today — the opposite of "allow this one".
    const { m, dir } = await makeManager('defaults:\n  admin_users: ["1"]\n');
    expect(m.allowGuild("new-guild")).toBe("already-open");

    const raw = await read(dir);
    expect(raw?.defaults?.allowed_guilds ?? []).toHaveLength(0);
    expect(m.isGuildAllowed("some-other-guild")).toBe(true);      // still allowed
  });

  it("normalises ids already in the file to strings", async () => {
    // A hand-edited config can hold an UNQUOTED snowflake, which YAML parses as
    // a number that has already lost precision. Writing must not preserve that
    // shape: isGuildAllowed compares with a strict includes(), so a numeric
    // entry silently never matches the string id a callback carries.
    const { m, dir } = await makeManager("defaults:\n  allowed_guilds: [111, 222]\n");
    expect(m.allowGuild("333")).toBe("added");

    const raw = await read(dir);
    expect(raw.defaults.allowed_guilds).toEqual(["111", "222", "333"]);
    for (const v of raw.defaults.allowed_guilds) expect(typeof v).toBe("string");
  });

  it("is idempotent", async () => {
    const { m } = await makeManager('defaults:\n  allowed_guilds: ["g1"]\n');
    expect(m.allowGuild("g1")).toBe("already");
    expect(m.allowGuild("g2")).toBe("added");
    expect(m.allowGuild("g2")).toBe("already");
  });

  it("admin_users has no allow-all semantics — the first admin is a real add", async () => {
    // Empty admin_users means NOBODY is admin (secure default), so unlike the
    // guild lists the first write must go through.
    const { m, dir } = await makeManager('defaults: {}\n');
    expect(m.addAdminUser("u1")).toBe("added");
    expect((await read(dir)).defaults.admin_users).toEqual(["u1"]);
    expect(m.isAdmin("u1")).toBe(true);
  });

  it("writes guilds and groups to their own lists", async () => {
    // Telegram groups are gated by allowed_groups; writing allowed_guilds would
    // change the file without unblocking anything.
    const { m, dir } = await makeManager('defaults:\n  allowed_guilds: ["g1"]\n  allowed_groups: ["-100"]\n');
    m.allowGroup("-200");
    const raw = await read(dir);
    expect(raw.defaults.allowed_groups).toContain("-200");
    expect(raw.defaults.allowed_guilds).toEqual(["g1"]);          // untouched
  });

  it("leaves the rest of classicBot.yaml alone", async () => {
    const { m, dir } = await makeManager(
      'defaults:\n  allowed_guilds: ["g1"]\n  backend: codex\n  custom_key: keep-me\n'
      + 'channels:\n  "c1":\n    channelId: "c1"\n    instanceName: classic-x\n    name: x\n',
    );
    m.allowGuild("g2");

    const raw = await read(dir);
    expect(raw.defaults.backend).toBe("codex");
    expect(raw.defaults.custom_key).toBe("keep-me");              // unknown key survives
    expect(raw.channels["c1"].instanceName).toBe("classic-x");
    expect(raw.defaults.allowed_guilds).toEqual(["g1", "g2"]);
  });
});
