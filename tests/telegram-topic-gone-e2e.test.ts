import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrammyError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const gone = { ok: false, error_code: 400, description: "Bad Request: message thread not found" };

describe("Telegram delivery failure → passive confirm → quarantine (#777, end to end)", () => {
  let dataDir: string;
  let workDir: string;
  let sourceDir: string;
  let fleetPath: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `agend-tg-e2e-${process.pid}-${Date.now()}`);
    sourceDir = join(dataDir, "source");
    workDir = join(dataDir, "repo", "worker");
    mkdirSync(sourceDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: sourceDir });
    execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: sourceDir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: sourceDir });
    writeFileSync(join(sourceDir, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: sourceDir });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: sourceDir });
    execFileSync("git", ["worktree", "add", "-q", "-b", "worker-branch", workDir], { cwd: sourceDir });
    writeFileSync(join(workDir, "untracked.txt"), "must survive\n");
    fleetPath = join(dataDir, "fleet.yaml");
    writeFileSync(fleetPath, "sentinel fleet config must survive\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("quarantines the route through the real adapter and real FleetManager without touching any data", async () => {
    const fm = new FleetManager(dataDir);
    fm.fleetConfig = {
      channels: [{ id: "telegram", type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100123" }],
      defaults: {},
      instances: { worker: { working_directory: workDir, worktree_source: sourceDir, topic_id: "118", channel_id: "telegram" } },
    } as any;
    fm.routing.register("118", { kind: "instance", name: "worker" });
    (fm as any).notifyFleetError = vi.fn();
    (fm as any).adapterState.set("telegram", { status: "connected", retryCount: 0 });
    const adapter = new TelegramAdapter({ id: "telegram", botToken: TOKEN, accessManager: {} as never, inboxDir: join(dataDir, "inbox") });
    (adapter as any).lastChatId = "-100123";
    (fm.adapters as Map<string, any>).set("telegram", adapter);
    (fm as any).bindTopicClosedHandler(adapter, "telegram", "adapter[telegram].topic_closed");
    const remove = vi.spyOn(fm.lifecycle, "remove");
    const removeInstance = vi.spyOn(fm, "removeInstance");
    const before = JSON.stringify(fm.fleetConfig);

    // The on-demand confirm probe: Telegram answers the probe's send with thread-not-found.
    const probeSend = vi.spyOn(adapter.getBot().api, "sendMessage")
      .mockRejectedValue(new GrammyError("Call to 'sendMessage' failed!", gone as never, "sendMessage", {}));

    // A real delivery fails: drive the outermost transformer as grammY would.
    const installed = adapter.getBot().api.config.installedTransformers() as any[];
    const observe = installed[installed.length - 1];
    await observe(async () => gone, "sendMessage", { chat_id: -100123, message_thread_id: 118, text: "reply from worker" });

    await vi.waitFor(() => expect(fm.routing.resolve("118")).toBeUndefined());

    expect(probeSend).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(removeInstance).not.toHaveBeenCalled();
    expect(JSON.stringify(fm.fleetConfig)).toBe(before);
    expect(readFileSync(fleetPath, "utf8")).toBe("sentinel fleet config must survive\n");
    expect(readFileSync(join(workDir, "untracked.txt"), "utf8")).toBe("must survive\n");
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: sourceDir, encoding: "utf8" })).toContain(`worktree ${workDir}`);
    expect((fm as any).notifyFleetError).toHaveBeenCalledTimes(1);
    expect((fm as any).notifyFleetError.mock.calls[0][0]).toContain("118");
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  }, 20_000);
});
