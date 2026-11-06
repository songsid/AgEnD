/**
 * Field bug (v2.3.3): in a fleet with Telegram listed first plus Discord, the Discord General's create_instance made the
 * topic in Discord but wrote the instance WITHOUT channel_id, so the fleet routed it as a Telegram instance (its Discord
 * channel's messages never arrived), while `agend ls` guessed DC from the topic id. Now:
 *  - an instance made in a caller's world records that adapter as channel_id (both adapter orders), so routing uses it;
 *  - deploy_template makes its topics in the caller's world as well;
 *  - `agend ls` shows the adapter the fleet routes by (channel_id, else the first connection), never a guess;
 *  - a single-connection fleet's fleet.yaml is unchanged (no channel_id written).
 * And `agend ls` on a fleet.yaml without `instances:` lists nothing with doctor's hint, instead of crashing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const dirs: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TG = { id: "telegram", type: "telegram", mode: "topic", bot_token_env: "T", group_id: -100, access: { mode: "locked", allowed_users: [1] } };
const DC = { id: "discord", type: "discord", mode: "topic", bot_token_env: "D", group_id: "1234567890123456789", access: { mode: "locked", allowed_users: ["1"] } };
const TOPIC = { telegram: "901", discord: "1500000000000000001" } as const;

async function create(channels: unknown[], caller: "telegram" | "discord" | undefined, extra: Record<string, unknown> = {}) {
  const dataDir = temp("agend-chan-");
  const project = temp("agend-chan-project-");
  const configPath = join(dataDir, "fleet.yaml");
  writeFileSync(configPath, yaml.dump({ channels, instances: {
    "general-telegram": { working_directory: temp("agend-chan-gt-"), general_topic: true, channel_id: "telegram" },
    "general-discord": { working_directory: temp("agend-chan-gd-"), general_topic: true, channel_id: "discord" },
  }, ...extra }));
  const fm = new FleetManager(dataDir);
  fm.loadConfig(configPath);
  const made = vi.spyOn(fm, "createForumTopic").mockImplementation(async (_name: string, adapterId?: string) =>
    TOPIC[(adapterId ?? (channels[0] as { id: string }).id) as keyof typeof TOPIC]);
  vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
  let result: any; let error: string | undefined;
  await fm.lifecycle.handleCreate({ directory: project, topic_name: "pomodoro" }, (r, e) => { result = r; error = e; }, caller);
  expect(error).toBeUndefined();
  const saved = yaml.load(readFileSync(configPath, "utf8")) as { instances: Record<string, Record<string, unknown>> };
  return { fm, made, name: result.name as string, saved: saved.instances[result.name] };
}

describe("create_instance binds the new instance to the caller's adapter", () => {
  for (const order of [["telegram", "discord"], ["discord", "telegram"]] as const) {
    const channels = order.map((id) => (id === "telegram" ? TG : DC));
    for (const caller of ["telegram", "discord"] as const) {
      it(`channels [${order.join(", ")}], made by the ${caller} General: channel_id ${caller}, routed and listed there`, async () => {
        const { fm, made, name, saved } = await create(channels, caller);
        expect(made).toHaveBeenCalledWith("pomodoro", caller);
        expect(saved.topic_id).toBe(TOPIC[caller]);
        expect(saved.channel_id).toBe(caller);
        expect(fm.getInstanceAdapterId(name)).toBe(caller);
      });
    }
  }

  it("control: a single-connection fleet writes no channel_id (its fleet.yaml shape is unchanged)", async () => {
    const { saved, fm, name } = await create([TG], "telegram");
    expect(saved).not.toHaveProperty("channel_id");
    expect(fm.getInstanceAdapterId(name)).toBe("telegram");
  });

  it("no caller world (the web dashboard): the topic and the routing both use the first connection", async () => {
    const { saved, made, fm, name } = await create([TG, DC], undefined);
    expect(made).toHaveBeenCalledWith("pomodoro", undefined);
    expect(saved.topic_id).toBe(TOPIC.telegram);
    expect(saved).not.toHaveProperty("channel_id");
    expect(fm.getInstanceAdapterId(name)).toBe("telegram");
  });
});

describe("deploy_template makes its instances in the caller's world", () => {
  it("passes the calling General's adapter to every create", async () => {
    const handleCreate = vi.fn(async (_args: unknown, respond: (r: unknown) => void, _adapterId?: string) => respond({ name: "x", status: "running" }));
    const ctx: any = {
      fleetConfig: { defaults: {}, instances: { "general-discord": { general_topic: true, channel_id: "discord" } },
        templates: { pair: { instances: { a: {}, b: {} } } }, teams: {} },
      lifecycle: { handleCreate },
      getWorldForInstance: vi.fn((name: string) => (name === "general-discord" ? { id: "discord" } : undefined)),
      saveFleetConfig: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };
    const dir = temp("agend-deploy-");
    await outboundHandlers.get("deploy_template")!(ctx, { template: "pair", directory: dir }, () => {}, { instanceName: "general-discord" } as any);
    expect(handleCreate).toHaveBeenCalled();
    for (const call of handleCreate.mock.calls) expect(call[2]).toBe("discord");
  });
});

describe("agend ls", () => {
  function fixture(fleet: Record<string, unknown>) {
    const dir = temp("agend-ls-chan-");
    const bin = join(dir, "bin"); mkdirSync(bin);
    for (const name of ["tmux", "agend", "systemctl", "launchctl"]) {
      const path = join(bin, name);
      writeFileSync(path, `#!${process.execPath}\n${name === "tmux" ? "process.exit(1);" : "throw new Error('unexpected');"}`); chmodSync(path, 0o755);
    }
    writeFileSync(join(dir, "fleet.yaml"), yaml.dump({ health_port: 0, ...fleet }));
    return dir;
  }
  function run(dir: string, args: string[]) {
    const child = spawnSync(process.execPath, ["--require", join(process.cwd(), "tests/helpers/health-process-stub.cjs"), "--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(), encoding: "utf8", timeout: 15000,
      env: { ...process.env, AGEND_HOME: dir, HOME: dir, NOTIFY_SOCKET: "", PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });
    expect(child.status, child.stderr).toBe(0);
    return child.stdout;
  }

  it("Src is the adapter the fleet routes by, in both orders (channel_id, else the first connection)", () => {
    for (const [channels, implicit] of [[[TG, DC], "TG"], [[DC, TG], "DC"]] as const) {
      const w = temp("agend-ls-w-");
      const dir = fixture({ channels, instances: {
        pomodoro: { working_directory: w, topic_id: TOPIC.discord, channel_id: "discord" },
        tgwork: { working_directory: w, topic_id: TOPIC.telegram, channel_id: "telegram" },
        // No channel_id, a Discord-looking topic id: routed by the first connection, so listed there (no guessing).
        legacy: { working_directory: w, topic_id: TOPIC.discord },
      } });
      const rows = JSON.parse(run(dir, ["ls", "--json"])) as { name: string; source: string }[];
      const src = Object.fromEntries(rows.map((r) => [r.name, r.source]));
      expect(src).toMatchObject({ pomodoro: "DC", tgwork: "TG", legacy: implicit });
    }
  });

  it("M-2494 (Prism P3 on #3201): a Windows exec agent has no chat binding, so no source — a pane keeps its own", () => {
    for (const fleet of [{ channels: [TG, DC] }, { channel: TG }] as const) {
      const w = temp("agend-ls-win-");
      const dir = fixture({ ...fleet, instances: {
        winexec: { working_directory: w, runtime: "windows", native_adapter: "exec" },
        winexec2: { working_directory: w, runtime: "windows" },   // exec is the default adapter
        winpane: { working_directory: w, runtime: "windows", native_adapter: "pane", topic_id: TOPIC.telegram, channel_id: "telegram" },
        tgwork: { working_directory: w, topic_id: TOPIC.telegram },
      } });
      const src = Object.fromEntries((JSON.parse(run(dir, ["ls", "--json"])) as { name: string; source: string }[]).map((r) => [r.name, r.source]));
      expect(src).toMatchObject({ winexec: "—", winexec2: "—", winpane: "TG", tgwork: "TG" });
    }
  });

  it("a fleet.yaml with no instances: section lists nothing and gives doctor's hint, no crash", () => {
    const dir = fixture({ channel: TG });
    const out = run(dir, ["ls"]);
    expect(out).toContain("No instances configured.");
    expect(out).toContain("no general_topic instance");
    expect(run(dir, ["ls", "--names-only"])).toBe("");
  });
});
