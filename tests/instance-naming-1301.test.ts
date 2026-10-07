/**
 * #1301: short unique names for new instances + display labels that never
 * show a 19-digit id.
 *
 * - New instances get `<base>-t<last 6 topic digits>`, lengthened on
 *   collision; existing (long) names are never renamed or migrated.
 * - User-facing labels prefer display_name, else shorten a long -t<digits>
 *   suffix to its last 6; agent-facing names ([from:…], logs, lookups) keep
 *   the real name.
 * - Orphan detection (`/-t\d+$/`) recognises both forms (no change).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { CreateInstanceArgs } from "../src/outbound-schemas.js";
import { TopicCommands } from "../src/topic-commands.js";
import { assignDisplayLabels, displayInstanceName, uniqueInstanceName } from "../src/topic-commands.js";
import { isOrphanInstanceWindowName } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const dirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LONG_ID = "1503381916525793300"; // 19 digits, pre-2.1.12 form
const last6 = LONG_ID.slice(-6);

describe("uniqueInstanceName (#1301)", () => {
  it("keeps short topic ids whole (old behavior preserved)", () => {
    expect(uniqueInstanceName("blog", "901", () => false)).toBe("blog-t901");
  });

  it("uses the last 6 digits of a long topic id", () => {
    expect(uniqueInstanceName("blog", LONG_ID, () => false)).toBe(`blog-t${last6}`);
  });

  it("lengthens the suffix on collision, up to the full id", () => {
    const taken = new Set([`blog-t${last6}`, `blog-t${LONG_ID.slice(-7)}`]);
    expect(uniqueInstanceName("blog", LONG_ID, (n) => taken.has(n)))
      .toBe(`blog-t${LONG_ID.slice(-8)}`);
    const takenAll = new Set<string>();
    for (let n = 6; n <= LONG_ID.length; n++) takenAll.add(`blog-t${LONG_ID.slice(-n)}`);
    takenAll.delete(`blog-t${LONG_ID}`); // full form free → lengthen all the way
    expect(uniqueInstanceName("blog", LONG_ID, (n) => takenAll.has(n))).toBe(`blog-t${LONG_ID}`);
  });

  it("reuses the full form when the same topic was created before (retry path)", () => {
    expect(uniqueInstanceName("blog", LONG_ID, (n) => n === `blog-t${LONG_ID}`))
      .toBe(`blog-t${LONG_ID}`);
    // Same, with an explicit same-topic proof.
    expect(uniqueInstanceName("blog", LONG_ID, (n) => n === `blog-t${LONG_ID}`, () => true))
      .toBe(`blog-t${LONG_ID}`);
  });

  it("refuses when the full form is owned by another topic (#1305 P1/r3)", () => {
    // Discord topic …125123456 owns blog-t123456; Telegram topic 123456 arrives.
    const taken = new Set(["blog-t123456"]);
    const sameTopic = (n: string) => n === "blog-t1503381916525123456";
    expect(() => uniqueInstanceName("blog", "123456", (n) => taken.has(n), sameTopic))
      .toThrow(/already used by a different topic.*different topic_name/);
    // Control: a genuine same-topic retry still reuses the full form.
    expect(uniqueInstanceName("blog", "1503381916525123456",
      (n) => n === "blog-t1503381916525123456",
      (n) => n === "blog-t1503381916525123456"))
      .toBe("blog-t1503381916525123456");
  });

  it("reuses a taken short form owned by the same topic instead of duplicating (#1305 P2-2)", () => {
    // An earlier partial attempt left blog-t793300 for this same topic; the
    // full form is still free. Rebind must reuse it, not allocate another.
    const idB = "9999999999999793300";
    const taken = new Set(["blog-t793300"]);
    const sameTopic = (n: string) => n === "blog-t793300";
    expect(uniqueInstanceName("blog", idB, (n) => taken.has(n), sameTopic))
      .toBe("blog-t793300");
    // Control: owned by a different topic → lengthen past it.
    expect(uniqueInstanceName("blog", idB, (n) => taken.has(n), () => false))
      .toBe("blog-t9793300");
  });

  it("treats an unproven full-form collision as a different topic (#1305 P1)", () => {
    // The full form is taken but nothing proves it is this topic (dir-only,
    // no config entry): it must not be reused — fall back to the short form.
    const taken = new Set([`blog-t${LONG_ID}`]);
    expect(uniqueInstanceName("blog", LONG_ID, (n) => taken.has(n), () => false))
      .toBe(`blog-t${last6}`);
  });

  it("sanitizes the base", () => {
    expect(uniqueInstanceName("My Blog!", "901", () => false)).toBe("my-blog-t901");
  });
});

describe("displayInstanceName (#1301)", () => {
  it("prefers display_name, falls through on blank", () => {
    expect(displayInstanceName(`blog-t${LONG_ID}`, "My Blog")).toBe("My Blog");
    expect(displayInstanceName(`blog-t${LONG_ID}`, "  ")).toBe(`blog-t${last6}`);
    expect(displayInstanceName(`blog-t${LONG_ID}`, null)).toBe(`blog-t${last6}`);
  });

  it("shortens a long suffix to its last 6 digits, keeping the -t shape", () => {
    expect(displayInstanceName(`blog-t${LONG_ID}`)).toBe(`blog-t${last6}`);
  });

  it("shows short suffixes, bare names and classic names whole", () => {
    expect(displayInstanceName(`blog-t${last6}`)).toBe(`blog-t${last6}`);
    expect(displayInstanceName("blog-t901")).toBe("blog-t901");
    expect(displayInstanceName("blog")).toBe("blog");
    expect(displayInstanceName("classic-lounge-1234")).toBe("classic-lounge-1234");
  });

  it("orphan detection recognises both the short and the long form", () => {
    expect(/-t\d+$/.test(`blog-t${last6}`)).toBe(true);
    expect(/-t\d+$/.test(`blog-t${LONG_ID}`)).toBe(true);
  });

  it("keeps allocator-lengthened suffixes whole so same-tail names stay distinct (#1305 P2)", () => {
    // Prism's pair: 1503381916525793300 vs 9999999999999793300.
    const idA = "1503381916525793300";
    const idB = "9999999999999793300";
    const nameA = uniqueInstanceName("blog", idA, () => false);
    expect(nameA).toBe("blog-t793300");
    const nameB = uniqueInstanceName("blog", idB, (n) => n === nameA);
    expect(nameB).toBe("blog-t9793300");
    expect(displayInstanceName(nameA)).toBe("blog-t793300");
    expect(displayInstanceName(nameB)).toBe("blog-t9793300");
    expect(displayInstanceName(nameA)).not.toBe(displayInstanceName(nameB));
  });
});

function makeFleet(): { fm: FleetManager; configPath: string } {
  const dataDir = makeTempDir("agend-1301-");
  const configPath = join(dataDir, "fleet.yaml");
  writeFileSync(configPath, "instances: {}\n");
  const fm = new FleetManager(dataDir);
  fm.loadConfig(configPath);
  return { fm, configPath };
}

function readInstances(configPath: string): Record<string, { topic_id: unknown }> {
  return (yaml.load(readFileSync(configPath, "utf-8")) as {
    instances: Record<string, { topic_id: unknown }>;
  }).instances;
}

describe("create_instance naming (#1301)", () => {
  async function create(fm: FleetManager, topicId: string, topicName: string, directory: string) {
    vi.spyOn(fm, "createForumTopic").mockResolvedValue(topicId);
    vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
    const args = CreateInstanceArgs.parse({ directory, topic_name: topicName });
    let result: unknown;
    await fm.lifecycle.handleCreate(args, (value) => { result = value; });
    return result as { success: boolean; name: string; topic_id: string };
  }

  it("gives a new instance a short name but keeps the full topic_id", async () => {
    const { fm, configPath } = makeFleet();
    const projectDir = makeTempDir("agend-1301-project-");
    const result = await create(fm, LONG_ID, "blog", projectDir);
    expect(result).toMatchObject({ success: true, name: `blog-t${last6}`, topic_id: LONG_ID });
    const saved = readInstances(configPath);
    expect(Object.keys(saved)).toEqual([`blog-t${last6}`]);
    expect(saved[`blog-t${last6}`].topic_id).toBe(LONG_ID);
  });

  it("lengthens the suffix when the short name collides", async () => {
    const { fm, configPath } = makeFleet();
    const projectDir = makeTempDir("agend-1301-project-");
    // A different topic whose tail collides on 6 digits.
    const otherId = `9999999999999${last6}`;
    const first = await create(fm, otherId, "blog", projectDir);
    expect(first.name).toBe(`blog-t${last6}`);
    const projectDir2 = makeTempDir("agend-1301-project2-");
    const second = await create(fm, LONG_ID, "blog", projectDir2);
    expect(second.name).toBe(`blog-t${LONG_ID.slice(-7)}`);
    expect(Object.keys(readInstances(configPath)).sort()).toEqual(
      [`blog-t${LONG_ID.slice(-7)}`, `blog-t${last6}`].sort(),
    );
  });

  it("leaves a pre-existing long-named instance untouched and addressable", async () => {
    const { fm, configPath } = makeFleet();
    const oldName = `old-t${LONG_ID}`;
    fm.fleetConfig!.instances[oldName] = { working_directory: "/tmp/w", topic_id: LONG_ID } as never;
    fm.saveFleetConfig();
    const projectDir = makeTempDir("agend-1301-project-");
    const result = await create(fm, LONG_ID, "shop", projectDir);
    expect(result.name).toBe(`shop-t${last6}`);
    const after = readInstances(configPath);
    expect(after[oldName]).toEqual({ working_directory: "/tmp/w", topic_id: LONG_ID });
    // Still addressable by the full name: the daemon dir resolves under it.
    expect(fm.getInstanceDir(oldName)).toContain(oldName);
  });

  it("refuses creation on cross-topic suffix collision instead of overwriting (#1305 P1/r3)", async () => {
    const { fm, configPath } = makeFleet();
    const discordTopic = "1503381916525123456"; // last6 = 123456
    const projectDir = makeTempDir("agend-1301-project-");
    const first = await create(fm, discordTopic, "blog", projectDir);
    expect(first.name).toBe("blog-t123456");
    // Telegram topic 123456, same base: its full form equals the taken short name.
    const projectDir2 = makeTempDir("agend-1301-project2-");
    vi.spyOn(fm, "createForumTopic").mockResolvedValue("123456");
    vi.spyOn(fm, "deleteForumTopic").mockResolvedValue(undefined);
    let result: unknown;
    let failure: unknown;
    await fm.lifecycle.handleCreate(
      CreateInstanceArgs.parse({ directory: projectDir2, topic_name: "blog" }),
      (value, err) => { result = value; failure = err; },
    );
    expect(result).toBeNull();
    expect(String(failure)).toMatch(/already used by a different topic.*different topic_name/);
    // The created topic is rolled back, and the original entry is untouched.
    expect(fm.deleteForumTopic).toHaveBeenCalledWith("123456", undefined);
    const after = readInstances(configPath);
    expect(after["blog-t123456"]).toMatchObject({ topic_id: discordTopic });
    expect(Object.keys(after)).toEqual(["blog-t123456"]);
  });

  it("rolls back the secondary world's topic when creation is refused there (#1305 P2-4)", async () => {
    const { fm } = makeFleet();
    fm.fleetConfig!.instances["blog-t123456"] = { working_directory: "/tmp/x", topic_id: "999" } as never;
    fm.saveFleetConfig();
    const secondaryDelete = vi.fn(async () => {});
    const primaryDelete = vi.fn(async () => {});
    fm.worlds.set("secondary", { adapter: {
      createTopic: async () => "123456",
      deleteTopic: secondaryDelete,
    } } as never);
    (fm as unknown as { adapter: unknown }).adapter = { deleteTopic: primaryDelete };
    const projectDir = makeTempDir("agend-1301-p24-");
    let result: unknown;
    let failure: unknown;
    await fm.lifecycle.handleCreate(
      CreateInstanceArgs.parse({ directory: projectDir, topic_name: "blog" }),
      (value, err) => { result = value; failure = err; },
      "secondary",
    );
    expect(result).toBeNull();
    expect(String(failure)).toMatch(/different topic_name/);
    expect(secondaryDelete).toHaveBeenCalledTimes(1);
    expect(secondaryDelete).toHaveBeenCalledWith("123456");
    expect(primaryDelete).not.toHaveBeenCalled();
    expect(fm.fleetConfig!.instances["blog-t123456"]).toMatchObject({ topic_id: "999" });
  });

  it("replace keeps the old long name instead of renaming to a short one", async () => {
    const { fm } = makeFleet();
    const oldName = `blog-t${LONG_ID}`;
    fm.fleetConfig!.instances[oldName] = { working_directory: "/tmp/w", topic_id: LONG_ID } as never;
    const daemon = { collectHandoverContext: () => "" };
    (fm.lifecycle as unknown as { daemons: Map<string, unknown> }).daemons.set(oldName, daemon);
    vi.spyOn(fm.lifecycle, "stop").mockResolvedValue(undefined);
    vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
    let result: unknown;
    await fm.lifecycle.handleReplace({ name: oldName, reason: "test" }, (value) => { result = value; });
    expect(result).toMatchObject({ success: true, old_name: oldName, new_name: oldName });
    expect(fm.fleetConfig!.instances[oldName]).toBeDefined();
    expect(Object.keys(fm.fleetConfig!.instances)).toHaveLength(1);
  });
});

describe("visibility posts and Mirror line (#1301)", () => {
  const SENDER = `leader-t${LONG_ID}`;
  const TARGET = `blog-t${LONG_ID}`;

  async function sendTask(senderDisplay?: string, targetDisplay?: string, names?: { sender: string; target: string }) {
    const sender = names?.sender ?? SENDER;
    const target = names?.target ?? TARGET;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sendText = vi.fn(async () => {});
    const mirror: string[] = [];
    const instances: Record<string, { working_directory: string; topic_id: string; display_name?: string }> = {
      [sender]: { working_directory: "/tmp/s", topic_id: "111" },
      [target]: { working_directory: "/tmp/t", topic_id: "222" },
    };
    if (senderDisplay !== undefined) instances[sender]!.display_name = senderDisplay;
    if (targetDisplay !== undefined) instances[target]!.display_name = targetDisplay;
    const ctx = {
      logger,
      fleetConfig: { defaults: {}, instances, channel: { group_id: "999" } },
      adapter: { sendText },
      sessionRegistry: new Map<string, string>(),
      instanceIpcClients: new Map<string, unknown>([[target, { deliverMessage: async () => ({}) }]]),
      lifecycle: { daemons: new Map([[sender, {}], [target, {}]]), isPaused: () => false },
      deliverToInstance: vi.fn(async () => {}),
      queueMirrorMessage: (line: string) => { mirror.push(line); },
    };
    let receipt: unknown;
    await outboundHandlers.get("send_to_instance")!(
      ctx as never,
      { instance_name: target, message: "please review", request_kind: "task" },
      (value) => { receipt = value; },
      { instanceName: sender } as never,
    );
    expect(receipt).toMatchObject({ sent: true });
    return { sendText, mirror };
  }

  it("target-topic and sender-topic posts use display_name when set", async () => {
    const { sendText } = await sendTask("Leader", "Blog");
    expect(sendText).toHaveBeenCalledTimes(2);
    const texts = sendText.mock.calls.map((call) => String((call as unknown[])[1]));
    for (const text of texts) {
      expect(text).toContain("Leader → Blog");
    }
    expect(texts.join("\n")).not.toContain(LONG_ID);
  });

  it("keeps two legacy same-tail entries distinct in topic posts and Mirror (#1305 P2-1)", async () => {
    const names = {
      sender: "blog-t1503381916525793300",
      target: "blog-t1503381916526793300",
    };
    const { sendText, mirror } = await sendTask(undefined, undefined, names);
    expect(sendText).toHaveBeenCalledTimes(2);
    for (const call of sendText.mock.calls) {
      const text = String((call as unknown[])[1]);
      expect(text).toContain("blog-t793300 → blog-t6793300");
      expect(text).not.toContain("1503381916525793300");
      expect(text).not.toContain("1503381916526793300");
    }
    expect(mirror).toHaveLength(1);
    expect(mirror[0]).toContain("blog-t793300 → blog-t6793300:");
  });

  it("falls back to the shortened -t… form and covers the Mirror line", async () => {
    const { sendText, mirror } = await sendTask();
    expect(sendText).toHaveBeenCalledTimes(2);
    const label = `leader-t${last6} → blog-t${last6}`;
    for (const call of sendText.mock.calls) {
      const text = String((call as unknown[])[1]);
      expect(text).toContain(label);
      expect(text).not.toContain(LONG_ID);
    }
    expect(mirror).toHaveLength(1);
    expect(mirror[0]).toContain(`${label}:`);
    expect(mirror[0]).not.toContain(LONG_ID);
  });
});

describe("bindAndStart naming (#1305 P1/r3)", () => {
  it("refuses a cross-topic suffix collision instead of overwriting", async () => {
    const dir = makeTempDir("agend-1305-bind-");
    const instances: Record<string, { working_directory: string; topic_id: string }> = {
      "blog-t123456": { working_directory: "/tmp/orig", topic_id: "1503381916525123456" },
    };
    const routing = new Map<string, unknown>();
    const tc = new TopicCommands({
      dataDir: dir,
      fleetConfig: { defaults: {}, instances },
      getInstanceDir: (name: string) => join(dir, name),
      saveFleetConfig: () => {},
      routingTable: { set: (k: string, v: unknown) => { routing.set(k, v); } },
      startInstance: async () => {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as never);
    await expect(tc.bindAndStart("/projects/blog", "123456")).rejects.toThrow(/different topic_name/);
    expect(instances["blog-t123456"]).toEqual({ working_directory: "/tmp/orig", topic_id: "1503381916525123456" });
    expect(Object.keys(instances)).toEqual(["blog-t123456"]);
  });

  it("reuses the name on a genuine same-topic rebind", async () => {
    const dir = makeTempDir("agend-1305-rebind-");
    const instances: Record<string, { working_directory: string; topic_id: string }> = {
      "blog-t123456": { working_directory: "/tmp/orig", topic_id: "123456" },
    };
    const routing = new Map<string, unknown>();
    const tc = new TopicCommands({
      dataDir: dir,
      fleetConfig: { defaults: {}, instances },
      getInstanceDir: (name: string) => join(dir, name),
      saveFleetConfig: () => {},
      routingTable: { set: (k: string, v: unknown) => { routing.set(k, v); } },
      startInstance: async () => {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as never);
    const name = await tc.bindAndStart("/projects/blog", "123456");
    expect(name).toBe("blog-t123456");
    expect(Object.keys(instances)).toEqual(["blog-t123456"]);
  });
});

describe("allocator output always matches the orphan predicate (#1305 P2-3)", () => {
  it("every emitted name shape is recognised by the real startup-cleanup predicate", () => {
    const names = [
      uniqueInstanceName("blog", "901", () => false), // blog-t901
      uniqueInstanceName("blog", LONG_ID, () => false), // short
      uniqueInstanceName("blog", LONG_ID, (n) => n === `blog-t${last6}`), // lengthened 7
      uniqueInstanceName("blog", LONG_ID, (n) => n !== `blog-t${LONG_ID}` && n.startsWith("blog-t")), // full
      uniqueInstanceName("My Blog!", "123456", () => false), // sanitized short
      uniqueInstanceName("shop", "1503381916525793300", () => false),
    ];
    expect(names).toHaveLength(6);
    for (const name of names) expect(isOrphanInstanceWindowName(name)).toBe(true);
    // And the predicate still ignores ordinary windows.
    expect(isOrphanInstanceWindowName("general")).toBe(false);
    expect(isOrphanInstanceWindowName("my-project")).toBe(false);
  });
});

describe("assignDisplayLabels (#1305 P2-1)", () => {
  const LEG_A = "blog-t1503381916525793300";
  const LEG_B = "blog-t1503381916526793300";

  it("lengthens two legacy same-tail entries just enough to differ", () => {
    const labels = assignDisplayLabels([{ name: LEG_A }, { name: LEG_B }]);
    const a = labels.get(LEG_A)!;
    const b = labels.get(LEG_B)!;
    expect(a).toBe("blog-t793300");
    expect(b).toBe("blog-t6793300");
    expect(a).not.toBe(b);
  });

  it("keeps explicit display_name collisions distinct without touching lookups", () => {
    const labels = assignDisplayLabels([
      { name: "aaa-t111111", displayName: "Blog" },
      { name: "zzz-t222222", displayName: "Blog" },
    ]);
    const [a, b] = ["aaa-t111111", "zzz-t222222"].map((n) => labels.get(n)!);
    expect(a).toBe("Blog");
    expect(b).not.toBe("Blog");
    expect(b).toContain("zzz-t222222");
  });

  it("is deterministic regardless of input order", () => {
    const fwd = assignDisplayLabels([{ name: LEG_A }, { name: LEG_B }]);
    const rev = assignDisplayLabels([{ name: LEG_B }, { name: LEG_A }]);
    expect([...fwd.entries()]).toEqual([...rev.entries()]);
  });
});

describe("/status display (#1301)", () => {
  function statusCommands(extra: Record<string, { display_name?: string; working_directory: string }>) {
    const dir = makeTempDir("agend-1301-status-");
    return new TopicCommands({
      dataDir: dir,
      fleetConfig: { defaults: {}, instances: extra },
      getInstanceStatus: () => "running",
      getInstanceExecutionState: () => null,
      modelDisplayForInstance: () => "auto",
    } as never);
  }

  it("shortens a long suffix and prefers display_name, without leaking the full id", async () => {
    const dir = makeTempDir("agend-1301-status-w-");
    const commands = statusCommands({
      [`blog-t${LONG_ID}`]: { working_directory: dir },
      [`shop-t${last6}`]: { working_directory: dir, display_name: "Shop" },
    });
    const text = await commands.getStatusText();
    expect(text).toContain(`blog-t${last6}`);
    expect(text).toContain("Shop");
    expect(text).not.toContain(LONG_ID);
  });

  it("keeps two same base/tail instances distinguishable in the renderer (#1305 P2)", async () => {
    const dir = makeTempDir("agend-1301-status-p2-");
    const commands = statusCommands({
      "blog-t793300": { working_directory: dir },
      "blog-t9793300": { working_directory: dir },
    });
    const text = await commands.getStatusText();
    expect(text).toContain("blog-t793300");
    expect(text).toContain("blog-t9793300");
  });

  it("lengthens two legacy same-tail entries just enough in /status (#1305 P2-1)", async () => {
    const dir = makeTempDir("agend-1301-status-leg-");
    const commands = statusCommands({
      "blog-t1503381916525793300": { working_directory: dir },
      "blog-t1503381916526793300": { working_directory: dir },
    });
    const text = await commands.getStatusText();
    expect(text).toContain("blog-t793300");
    expect(text).toContain("blog-t6793300");
    expect(text).not.toContain("1503381916525793300");
    expect(text).not.toContain("1503381916526793300");
  });
});
