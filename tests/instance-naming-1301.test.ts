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
import { displayInstanceName, uniqueInstanceName } from "../src/topic-commands.js";
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

  async function sendTask(senderDisplay?: string, targetDisplay?: string) {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sendText = vi.fn(async () => {});
    const mirror: string[] = [];
    const instances: Record<string, { working_directory: string; topic_id: string; display_name?: string }> = {
      [SENDER]: { working_directory: "/tmp/s", topic_id: "111" },
      [TARGET]: { working_directory: "/tmp/t", topic_id: "222" },
    };
    if (senderDisplay !== undefined) instances[SENDER]!.display_name = senderDisplay;
    if (targetDisplay !== undefined) instances[TARGET]!.display_name = targetDisplay;
    const ctx = {
      logger,
      fleetConfig: { defaults: {}, instances, channel: { group_id: "999" } },
      adapter: { sendText },
      sessionRegistry: new Map<string, string>(),
      instanceIpcClients: new Map<string, unknown>([[TARGET, { deliverMessage: async () => ({}) }]]),
      lifecycle: { daemons: new Map([[SENDER, {}], [TARGET, {}]]), isPaused: () => false },
      deliverToInstance: vi.fn(async () => {}),
      queueMirrorMessage: (line: string) => { mirror.push(line); },
    };
    let receipt: unknown;
    await outboundHandlers.get("send_to_instance")!(
      ctx as never,
      { instance_name: TARGET, message: "please review", request_kind: "task" },
      (value) => { receipt = value; },
      { instanceName: SENDER } as never,
    );
    expect(receipt).toMatchObject({ sent: true });
    return { sendText, mirror };
  }

  it("target-topic and sender-topic posts use display_name when set", async () => {
    const { sendText } = await sendTask("Leader", "Blog");
    expect(sendText).toHaveBeenCalledTimes(2);
    for (const call of sendText.mock.calls) {
      expect(String(call[1])).toContain("Leader → Blog");
    }
    const texts = sendText.mock.calls.map((c) => String(c[1])).join("\n");
    expect(texts).not.toContain(LONG_ID);
  });

  it("falls back to the shortened -t… form and covers the Mirror line", async () => {
    const { sendText, mirror } = await sendTask();
    expect(sendText).toHaveBeenCalledTimes(2);
    const label = `leader-t${last6} → blog-t${last6}`;
    for (const call of sendText.mock.calls) {
      expect(String(call[1])).toContain(label);
      expect(String(call[1])).not.toContain(LONG_ID);
    }
    expect(mirror).toHaveLength(1);
    expect(mirror[0]).toContain(`${label}:`);
    expect(mirror[0]).not.toContain(LONG_ID);
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
});
