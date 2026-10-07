/**
 * #1302: `cross_instance_visibility` — full | summary | hidden — decides how much of a bot-to-bot message is posted in
 * the instance topics. `full` (and unset) is exactly what was posted before; delivery, the Mirror Topic and General
 * topics are the same in every mode.
 *
 * The real send_to_instance handler runs against a recording adapter and a recording durable admission: no daemon,
 * CLI, tmux or real fleet (bd0c88aa). Persistence uses a scratch fleet.yaml.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { crossInstanceVisibility, runVisibilityCommand } from "../src/cross-instance-notice.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { loadFleetConfig } from "../src/config.js";
import { FleetManager } from "../src/fleet-manager.js";
import { buildSettingsImpactSchema, classifyInstanceChange } from "../src/instance-config-impact.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1302-")); dirs.push(d); return d; };
beforeEach(() => setLocale("en"));
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const GROUP = "-100777";
const KINDS = [undefined, "task", "query", "report", "update"] as const;
type Kind = typeof KINDS[number];
const LONG = `First line of the request.\n\nSecond paragraph — ${"x".repeat(150)}`;

interface Sent { threadId: string; text: string }

async function send(opts: {
  defaults?: Record<string, unknown>;
  sender?: Record<string, unknown>;
  target?: Record<string, unknown>;
  kind?: Kind;
  taskSummary?: string;
  message?: string;
}) {
  const posts: Sent[] = [];
  const mirror: string[] = [];
  const admitted: Array<{ payload: { content: string; meta: Record<string, string> } }> = [];
  const adapter = {
    sendText: async (chatId: string, text: string, o?: { threadId?: string }) => {
      expect(chatId).toBe(GROUP);
      posts.push({ threadId: String(o?.threadId), text });
      return { messageId: "m", chatId };
    },
  };
  const ctx = {
    fleetConfig: {
      channel: { type: "telegram", group_id: GROUP },
      defaults: { ...(opts.defaults ?? {}) },
      instances: {
        alice: { working_directory: "/w/a", topic_id: 11, ...(opts.sender ?? {}) },
        bob: { working_directory: "/w/b", topic_id: 22, ...(opts.target ?? {}) },
      },
    },
    adapter,
    instanceIpcClients: new Map([["bob", { connected: true }]]),
    sessionRegistry: new Map(),
    lifecycle: { daemons: new Map() },
    getInstanceStatus: () => "running",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    admitDurableDelivery: (record: { payload: { content: string; meta: Record<string, string> } }) => {
      admitted.push(record);
      return { deliveryId: "d1", state: "queued", duplicate: false };
    },
    queueMirrorMessage: (line: string) => { mirror.push(line); },
  };
  const message = opts.message ?? LONG;
  let error: unknown;
  await outboundHandlers.get("send_to_instance")!(
    ctx as never,
    { instance_name: "bob", message, ...(opts.kind ? { request_kind: opts.kind } : {}), ...(opts.taskSummary ? { task_summary: opts.taskSummary } : {}) } as never,
    (_result, err) => { error = err; },
    { instanceName: "alice" } as never,
  );
  expect(error).toBeUndefined();
  await new Promise(r => setImmediate(r));
  return {
    sender: posts.filter(p => p.threadId === "11").map(p => p.text),
    target: posts.filter(p => p.threadId === "22").map(p => p.text),
    others: posts.filter(p => p.threadId !== "11" && p.threadId !== "22"),
    mirror, admitted, message,
  };
}

const LABEL = "alice → bob";

/** What was posted before #1302, written out by hand rather than computed by the code under test. */
function before(kind: Kind, message: string, taskSummary?: string) {
  const full = `${LABEL}:\n${message}`;
  const target = kind === "report" || kind === "update" ? []
    : kind === "task" || kind === "query" ? [full]
    : [`${LABEL}: ${taskSummary ?? message.slice(0, 99) + "…"}`];
  return { sender: [full], target };
}

describe("full, and unset: exactly the posts made before", () => {
  it.each(KINDS.map(kind => [kind ?? "(none)", kind] as const))("request_kind %s", async (_label, kind) => {
    for (const config of [{}, { defaults: { cross_instance_visibility: "full" } }, { sender: { cross_instance_visibility: "full" }, target: { cross_instance_visibility: "full" } }]) {
      for (const taskSummary of [undefined, "Review PR #9"]) {
        const r = await send({ ...config, kind, taskSummary });
        expect({ sender: r.sender, target: r.target }, JSON.stringify(config)).toEqual(before(kind, r.message, taskSummary));
      }
    }
  });
});

describe("summary: the same posts, one line each", () => {
  it.each(KINDS.map(kind => [kind ?? "(none)", kind] as const))("request_kind %s", async (_label, kind) => {
    const silentTarget = kind === "report" || kind === "update";
    const r = await send({ defaults: { cross_instance_visibility: "summary" }, kind });
    const preview = `${LABEL}: First line of the request. Second paragraph — ${"x".repeat(100 - "First line of the request. Second paragraph — ".length - 1)}…`;
    expect(r.sender).toEqual([preview]);
    expect(r.target).toEqual(silentTarget ? [] : [preview]);
    for (const line of [...r.sender, ...r.target]) expect(line).not.toContain("\n");

    const withSummary = await send({ defaults: { cross_instance_visibility: "summary" }, kind, taskSummary: "Review\n  PR #9" });
    expect(withSummary.sender).toEqual([`${LABEL}: Review PR #9`]);
    expect(withSummary.target).toEqual(silentTarget ? [] : [`${LABEL}: Review PR #9`]);
  });

  it("a whitespace-only task summary falls back to the message", async () => {
    const r = await send({ defaults: { cross_instance_visibility: "summary" }, kind: "task", taskSummary: " \n ", message: "short ask" });
    expect(r.sender).toEqual([`${LABEL}: short ask`]);
  });
});

describe("hidden: nothing in either topic", () => {
  it.each(KINDS.map(kind => [kind ?? "(none)", kind] as const))("request_kind %s", async (_label, kind) => {
    const r = await send({ defaults: { cross_instance_visibility: "hidden" }, kind, taskSummary: "Review PR #9" });
    expect(r.sender).toEqual([]);
    expect(r.target).toEqual([]);
    expect(r.others).toEqual([]);
  });
});

describe("each topic follows its own instance", () => {
  it("an instance's own setting beats the fleet default, for the side it is on", async () => {
    const r = await send({ defaults: { cross_instance_visibility: "hidden" }, sender: { cross_instance_visibility: "full" }, kind: "task" });
    expect(r.sender).toEqual([`${LABEL}:\n${r.message}`]);
    expect(r.target).toEqual([]);
    const s = await send({ sender: { cross_instance_visibility: "hidden" }, target: { cross_instance_visibility: "summary" }, kind: "task", taskSummary: "Ship it" });
    expect(s.sender).toEqual([]);
    expect(s.target).toEqual([`${LABEL}: Ship it`]);
  });

  it("a value the fleet does not know reads as unset: the default, never hidden", async () => {
    const r = await send({ defaults: { cross_instance_visibility: "summary" }, sender: { cross_instance_visibility: "verbose" }, kind: "task", taskSummary: "Ship it" });
    expect(r.sender).toEqual([`${LABEL}: Ship it`]);
    const s = await send({ defaults: { cross_instance_visibility: "nope" }, kind: "task" });
    expect(s.sender).toEqual([`${LABEL}:\n${s.message}`]);
  });
});

describe("General topics are skipped in every mode", () => {
  it.each(["full", "summary", "hidden"])("%s", async mode => {
    for (const kind of KINDS) {
      const toGeneral = await send({ defaults: { cross_instance_visibility: mode }, target: { general_topic: true }, kind });
      expect(toGeneral.target).toEqual([]);
      const fromGeneral = await send({ defaults: { cross_instance_visibility: mode }, sender: { general_topic: true }, kind });
      expect(fromGeneral.sender).toEqual([]);
    }
  });
});

describe("delivery and the Mirror Topic do not read the setting", () => {
  it.each(["summary", "hidden"])("%s: the same delivery and the same Mirror line as full", async mode => {
    for (const kind of KINDS) {
      const full = await send({ kind, taskSummary: "S" });
      const other = await send({ defaults: { cross_instance_visibility: mode }, sender: { cross_instance_visibility: mode }, target: { cross_instance_visibility: mode }, kind, taskSummary: "S" });
      expect(other.mirror).toEqual([`${LABEL}: ${LONG.slice(0, 500)}`]);
      expect(other.mirror).toEqual(full.mirror);
      expect(other.admitted).toHaveLength(1);
      expect(other.admitted[0]!.payload.content).toBe(full.admitted[0]!.payload.content);
      const strip = (m: Record<string, string>) => { const { message_id: _id, ts: _ts, correlation_id: _c, ...rest } = m; return rest; };
      expect(strip(other.admitted[0]!.payload.meta)).toEqual(strip(full.admitted[0]!.payload.meta));
    }
  });
});

describe("config", () => {
  const fleet = (defaults: Record<string, unknown>, instance: Record<string, unknown> = {}) =>
    validateFleetConfig({ channel: { type: "telegram", group_id: 1, bot_token_env: "T" }, defaults, instances: { a: { working_directory: "/tmp/a", ...instance } } } as never);

  it("accepts the three modes on the defaults and on an instance; rejects anything else", () => {
    for (const mode of ["full", "summary", "hidden"]) {
      expect(fleet({ cross_instance_visibility: mode }).valid).toBe(true);
      expect(fleet({}, { cross_instance_visibility: mode }).valid).toBe(true);
    }
    expect(fleet({ cross_instance_visibility: "verbose" }).errors).toEqual([expect.objectContaining({ path: "defaults.cross_instance_visibility" })]);
    expect(fleet({}, { cross_instance_visibility: true }).errors).toEqual([expect.objectContaining({ path: "instances.a.cross_instance_visibility" })]);
  });

  it("unset is valid and stays unset: nothing is invented on load (the #1298 lesson)", () => {
    const dir = scratch();
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, `defaults:\n  tool_progress: standard\ninstances:\n  a:\n    working_directory: ${dir}\n`);
    const loaded = loadFleetConfig(path);
    expect(loaded.defaults).not.toHaveProperty("cross_instance_visibility");
    expect(loaded.instances.a).not.toHaveProperty("cross_instance_visibility");
    expect(fleet({}).valid).toBe(true);
    expect(crossInstanceVisibility(loaded, "a")).toBe("full");
  });

  it("the fleet default is not copied into each instance's config, so changing it restarts nobody", () => {
    const dir = scratch();
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, `defaults:\n  cross_instance_visibility: hidden\ninstances:\n  a:\n    working_directory: ${dir}\n  b:\n    working_directory: ${dir}\n    cross_instance_visibility: summary\n`);
    const loaded = loadFleetConfig(path);
    expect(loaded.instances.a).not.toHaveProperty("cross_instance_visibility");
    expect(crossInstanceVisibility(loaded, "a")).toBe("hidden");
    expect(crossInstanceVisibility(loaded, "b")).toBe("summary");
  });

  it("an instance override is applied to the live agent without a restart (impact: now)", () => {
    const base = { working_directory: "/tmp/a" } as never;
    expect(classifyInstanceChange(base, { working_directory: "/tmp/a", cross_instance_visibility: "hidden" } as never)).toBe("hot");
    const { impacts } = buildSettingsImpactSchema();
    expect(impacts["instance.cross_instance_visibility"]).toBe("now");
    expect(impacts["defaults.cross_instance_visibility"]).toBe("now");
  });
});

describe("/visibility", () => {
  it("with a mode: sets the fleet default; without: says what it is; anything else: usage, nothing changed", () => {
    const fleet = { defaults: {}, instances: { a: { working_directory: "/w" }, b: { working_directory: "/w", cross_instance_visibility: "full" as const } } };
    let saves = 0;
    const save = () => { saves++; };
    expect(runVisibilityCommand(fleet as never, "", save)).toMatch(new RegExp(`^${t("visibility.current", "full")}\n`));
    expect(saves).toBe(0);
    const set = runVisibilityCommand(fleet as never, " HIDDEN ", save);
    expect(set.split("\n")).toEqual([t("visibility.set", "hidden"), t("visibility.mode.hidden"), t("visibility.overrides", "b (full)")]);
    expect(fleet.defaults).toEqual({ cross_instance_visibility: "hidden" });
    expect(saves).toBe(1);
    expect(runVisibilityCommand(fleet as never, "loud", save)).toBe(t("visibility.usage"));
    expect(fleet.defaults).toEqual({ cross_instance_visibility: "hidden" });
    expect(saves).toBe(1);
  });

  it("a save that fails is undone in memory and reported", () => {
    const unset = { defaults: {} as Record<string, unknown>, instances: {} };
    const reply = runVisibilityCommand(unset as never, "summary", () => { throw new Error("Refusing to overwrite invalid fleet.yaml"); });
    expect(reply).toBe(t("visibility.save_failed", "Refusing to overwrite invalid fleet.yaml"));
    expect(unset.defaults).not.toHaveProperty("cross_instance_visibility");
    const set = { defaults: { cross_instance_visibility: "hidden" } as Record<string, unknown>, instances: {} };
    runVisibilityCommand(set as never, "full", () => { throw new Error("disk full"); });
    expect(set.defaults.cross_instance_visibility).toBe("hidden");
  });

  it("persists to fleet.yaml and holds after a restart (Telegram, General topic, fleet admin)", async () => {
    const dir = scratch();
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, `# my fleet\nchannel:\n  type: telegram\n  mode: topic\n  bot_token_env: T\n  group_id: ${GROUP}\n  access:\n    mode: locked\n    allowed_users: ["42"]\ndefaults:\n  tool_progress: standard # keep me\ninstances:\n  general:\n    working_directory: ${dir}\n    topic_id: 1\n    general_topic: true\n  a:\n    working_directory: ${dir}\n    topic_id: 11\n`);
    const fm = new FleetManager(scratch());
    const any = fm as any;
    try {
      fm.loadConfig(path);
      const replies: string[] = [];
      const adapter = { id: "telegram", type: "telegram", sendText: async (_c: string, text: string) => { replies.push(text); return { messageId: "m", chatId: GROUP }; } };
      any.adapter = adapter;
      any.adapters.set("telegram", adapter);
      const say = (userId: string, text: string) => any.topicCommands.handleGeneralCommand({
        source: "telegram", adapterId: "telegram", chatId: GROUP, threadId: "1", messageId: "m1", userId, username: "u", text, timestamp: new Date(),
      });

      expect(await say("7", "/visibility hidden")).toBe(true);
      expect(replies).toEqual([t("not_authorized")]);
      expect(readFileSync(path, "utf8")).not.toContain("cross_instance_visibility");

      replies.length = 0;
      expect(await say("42", "/visibility@agend_bot summary")).toBe(true);
      expect(replies[0]).toContain(t("visibility.set", "summary"));
      const yaml = readFileSync(path, "utf8");
      expect(yaml).toContain("cross_instance_visibility: summary");
      expect(yaml).toContain("# my fleet");
      expect(yaml).toContain("tool_progress: standard # keep me");
      expect(yaml.match(/cross_instance_visibility/g)).toHaveLength(1);       // the default only, no instance copies

      const restarted = loadFleetConfig(path);
      expect(restarted.defaults.cross_instance_visibility).toBe("summary");
      expect(crossInstanceVisibility(restarted, "a")).toBe("summary");
      expect(validateFleetConfig(restarted).valid).toBe(true);
    } finally {
      fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); fm.memoryPressure.stop();
    }
  });
});
