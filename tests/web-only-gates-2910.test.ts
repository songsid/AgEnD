/**
 * #2910 PR2: the channel gates come off a web-only fleet (no Discord or Telegram connection at all).
 * - Its agents run in topic mode, the mode their cross-instance tools need (one answer for every start path).
 * - The scheduler (schedules, the task board, decisions) starts without a channel.
 * - A new agent is created without a forum topic (named as asked, then -2, -3…).
 * - A channel tool that can never work there says so instead of "retry shortly".
 * The real web-only fleet (a real Claude Code against a mock API, in a container) is the PR's acceptance.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { CreateInstanceArgs } from "../src/outbound-schemas.js";
import { daemonTopicMode, isWebOnlyFleetConfig } from "../src/web-only-fleet.js";
import { sanitizeInstanceName } from "../src/instance-names.js";
import { isGeneralInstance } from "../src/general-instance.js";

const dirs: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("#2910 web-only fleet: what it is, and the mode its agents run in", () => {
  it.each([
    ["no channel, no channels", { instances: {} }, true, true],
    ["an empty channels list", { channels: [] }, true, true],
    ["a topic-mode channel", { channel: { mode: "topic" } }, false, true],
    ["a topic-mode connection among several", { channels: [{ mode: "dm" }, { mode: "topic" }] }, false, true],
    ["a channel not in topic mode", { channel: { mode: "dm" } }, false, false],
    ["no config yet", null, false, false],
  ] as const)("%s → web-only %s, topic mode %s", (_why, cfg, webOnly, topic) => {
    expect([isWebOnlyFleetConfig(cfg as never), daemonTopicMode(cfg as never)]).toEqual([webOnly, topic]);
  });
  it("every start path asks the same helper (no copy that ignores a web-only fleet or a channels list)", () => {
    const fm = readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8"), web = readFileSync(join(process.cwd(), "src", "web-api.ts"), "utf8");
    // Only the Classic start keeps its own (a Classic room needs a channel; a web-only fleet has none).
    expect(fm.match(/channel\?\.mode === "topic"/g)?.length ?? 0).toBe(1);
    expect(web.match(/channel\?\.mode === "topic"/g)?.length ?? 0).toBe(0);
    expect((fm.match(/daemonTopicMode\(/g)?.length ?? 0) >= 7 && web.includes("daemonTopicMode(ctx.fleetConfig)")).toBe(true);
    // The scheduler's block opens on topic mode alone (web-only included), the adapters' still on a channel.
    expect([fm.includes("    if (topicMode) {\n      const schedulerConfig: SchedulerConfig"), fm.includes("if (topicMode && (fleet.channel || fleet.channels?.length)) {\n      // An adapter becoming reachable")])
      .toEqual([true, true]);
  });
});

function webOnlyFleet(extra = "") {
  const dataDir = temp("agend-2910-gates-");
  vi.stubEnv("AGEND_HOME", dataDir);
  const configPath = join(dataDir, "fleet.yaml");
  writeFileSync(configPath, `instances: {}\n${extra}`);
  const fm = new FleetManager(dataDir);
  fm.loadConfig(configPath);
  const topic = vi.spyOn(fm, "createForumTopic").mockResolvedValue("901");
  const start = vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
  const register = vi.spyOn(fm.routing, "register");
  const create = async (args: Record<string, unknown>) => {
    let result: any; let error: string | undefined;
    await fm.lifecycle.handleCreate(CreateInstanceArgs.parse(args), (r, e) => { result = r; error = e; });
    return { result, error };
  };
  return { fm, dataDir, configPath, topic, start, register, create };
}

describe("#2910 web-only fleet: a new agent has no topic", () => {
  it("created without a forum topic, named as asked, in its own workspace; started in topic mode; nothing routed", async () => {
    const h = webOnlyFleet();
    const { result, error } = await h.create({ topic_name: "helper" });
    expect([error, result]).toEqual([undefined, { success: true, name: "helper", topic_id: undefined }]);
    expect([h.topic.mock.calls.length, h.register.mock.calls.length]).toEqual([0, 0]);
    expect(h.start.mock.calls[0]!.slice(0, 1).concat(h.start.mock.calls[0]![2])).toEqual(["helper", true]);
    const saved = (yaml.load(readFileSync(h.configPath, "utf8")) as { instances: Record<string, Record<string, unknown>> }).instances.helper!;
    expect(["topic_id" in saved, saved.working_directory]).toEqual([false, join(h.dataDir, "workspaces", "helper")]);
  });
  it("a taken name gets the first free -2, -3…; a directory names it by its folder", async () => {
    const h = webOnlyFleet("");
    await h.create({ topic_name: "helper" });
    expect((await h.create({ topic_name: "helper" })).result.name).toBe("helper-2");
    mkdirSync(h.fm.getInstanceDir("helper-3"), { recursive: true });                 // a leftover directory is taken too
    expect((await h.create({ topic_name: "helper" })).result.name).toBe("helper-4");
    const project = temp("agend-2910-project-");
    expect((await h.create({ directory: project })).result.name).toBe(sanitizeInstanceName(project.split("/").at(-1)!));
  });
  // #2919 review (Prism): "general" alone makes an instance the General (General's tools, never paused) — an ordinary
  // New agent is never given that name, whether asked for ("General") or from its folder's name.
  it("never 'general': an asked-for General, or a folder named general, is general-2 (a worker: no General tools, pausable)", async () => {
    const h = webOnlyFleet();
    const asked = (await h.create({ topic_name: "General" })).result.name;
    const folder = join(temp("agend-2919-"), "general"); mkdirSync(folder);
    const fromDir = (await h.create({ directory: folder })).result.name;
    expect([asked, fromDir, "general" in h.fm.fleetConfig!.instances]).toEqual(["general-2", "general-3", false]);
    for (const name of [asked, fromDir]) {
      expect([isGeneralInstance(h.fm.fleetConfig, name), (h.fm as any).checkToolPermission("ipc-outbound", name, "create_instance").allowed]).toEqual([false, false]);
    }
  });
  it("a fleet with a channel still creates its topic and suffixes the name with it (unchanged)", async () => {
    const h = webOnlyFleet("channel:\n  type: telegram\n  mode: topic\n  bot_token_env: T\n  group_id: -100\n  access: { mode: locked, allowed_users: [1] }\n");
    const { result } = await h.create({ topic_name: "helper" });
    expect([result.name, result.topic_id, h.topic.mock.calls.length, h.register.mock.calls.length]).toEqual(["helper-t901", "901", 1, 1]);
  });
});

describe("#2910 web-only fleet: a channel tool that cannot work there says so", () => {
  it("edit_message / download_attachment: 'not available on a web-only fleet', not 'retry shortly'; a channel fleet before its adapter: unchanged", async () => {
    const h = webOnlyFleet();
    // The answer goes back over the instance's IPC connection: a fake one records it.
    const ask = async (fm: FleetManager, tool: string) => {
      const sent: Array<{ error?: string }> = [];
      (fm as any).instanceIpcClients.set("helper", { send: (m: { error?: string }) => { sent.push(m); return true; } });
      await (fm as any).handleOutboundFromInstance("helper", { type: "fleet_outbound", tool, args: { message_id: "123", text: "x" }, requestId: 1 });
      return sent.at(-1)?.error;
    };
    h.fm.fleetConfig!.instances.helper = { working_directory: "/tmp/x" } as never;
    const e1 = await ask(h.fm, "edit_message"), e2 = await ask(h.fm, "download_attachment");
    expect([e1, e2]).toEqual([
      "edit_message is not available on a web-only fleet (no Discord or Telegram connection); answer with reply",
      "download_attachment is not available on a web-only fleet (no Discord or Telegram connection); answer with reply",
    ]);
    const chat = webOnlyFleet("channel:\n  type: telegram\n  mode: topic\n  bot_token_env: T\n  group_id: -100\n  access: { mode: locked, allowed_users: [1] }\n");
    chat.fm.fleetConfig!.instances.helper = { working_directory: "/tmp/x" } as never;
    expect(await ask(chat.fm, "edit_message")).toBe("Channel adapters are not ready — retry shortly");
  });
});
