import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FleetContext } from "./fleet-context.js";
import type { InstanceConfig } from "./types.js";
import type { EphemeralInstanceConfig } from "./meeting/types.js";

export class MeetingManager {
  private ephemeralTopicMap: Map<string, number> = new Map();

  constructor(private ctx: FleetContext) {}

  /** Get the ephemeral topic ID for an instance (used by fleet-manager for outbound routing) */
  getEphemeralTopicId(instanceName: string): number | undefined {
    return this.ephemeralTopicMap.get(instanceName);
  }

  async spawnEphemeralInstance(config: EphemeralInstanceConfig, signal?: AbortSignal): Promise<string> {
    const name = `meet-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

    let workDir = config.workingDirectory;
    if (workDir !== "/tmp") {
      if (!existsSync(join(workDir, ".git"))) {
        throw new Error(`Not a git repository: ${workDir}`);
      }
      const { execFileSync } = await import("child_process");
      try {
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, stdio: "pipe" });
      } catch {
        execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: workDir, stdio: "pipe" });
      }
      const worktreePath = join("/tmp", `ccd-collab-${name}`);
      const branchName = `meet/${name}`;
      execFileSync("git", ["worktree", "add", worktreePath, "-b", branchName], { cwd: workDir, stdio: "pipe" });
      workDir = worktreePath;
      this.ctx.logger.info({ name, worktreePath, branchName }, "Created git worktree for collab instance");
    }

    const instanceConfig: InstanceConfig = {
      working_directory: workDir,
      lightweight: true,
      systemPrompt: config.systemPrompt,
      skipPermissions: config.skipPermissions,
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { threshold_percentage: 100, max_idle_wait_ms: 0, completion_timeout_ms: 0, grace_period_ms: 0, max_age_hours: 24 },
      memory: { auto_summarize: false, watch_memory_dir: false, backup_to_sqlite: false },
      log_level: "info",
      backend: config.backend,
    };

    await this.ctx.startInstance(name, instanceConfig, true);

    const deadline = Date.now() + 60_000;
    const sockPath = join(this.ctx.getInstanceDir(name), "channel.sock");
    while (!existsSync(sockPath)) {
      if (Date.now() > deadline) throw new Error(`IPC timeout for ${name}`);
      if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      await new Promise(r => setTimeout(r, 500));
    }
    await this.ctx.connectIpcToInstance(name);

    const ipc = this.ctx.instanceIpcClients.get(name);
    if (ipc) {
      const mcpDeadline = Date.now() + 60_000;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          settled = true;
          ipc.removeListener("message", onMessage);
          clearTimeout(timer);
        };
        const onMessage = (msg: Record<string, unknown>) => {
          if (msg.type === "mcp_ready") { cleanup(); resolve(); }
        };
        ipc.on("message", onMessage);
        const check = () => {
          if (settled) return;
          if (Date.now() > mcpDeadline) {
            cleanup();
            reject(new Error(`MCP ready timeout for ${name}`));
          } else {
            timer = setTimeout(check, 500);
          }
        };
        check();
      });
    }

    return name;
  }

  /** Clean up ephemeral instance resources (worktree, topic map). Called on topic deletion. */
  async cleanupEphemeral(name: string): Promise<void> {
    this.ephemeralTopicMap.delete(name);

    const worktreePath = join("/tmp", `ccd-collab-${name}`);
    if (!existsSync(worktreePath)) return;

    try {
      const { execFileSync } = await import("child_process");
      const mainRepo = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: worktreePath, stdio: "pipe" }).toString().trim();
      const mainRepoDir = dirname(mainRepo);
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: mainRepoDir, stdio: "pipe" });
      try {
        execFileSync("git", ["branch", "-D", `meet/${name}`], { cwd: mainRepoDir, stdio: "pipe" });
      } catch { /* branch may not exist */ }
      this.ctx.logger.info({ name }, "Cleaned up ephemeral worktree");
    } catch (err) {
      this.ctx.logger.warn({ name, err }, "Failed to clean up ephemeral worktree");
    }
  }

  async createMeetingChannel(title: string): Promise<{ channelId: number }> {
    const threadId = await this.ctx.createForumTopic(title);
    return { channelId: threadId };
  }

  async closeMeetingChannel(channelId: number): Promise<void> {
    const groupId = this.ctx.fleetConfig?.channel?.group_id;
    const botTokenEnv = this.ctx.fleetConfig?.channel?.bot_token_env;
    if (!groupId || !botTokenEnv) return;
    const botToken = process.env[botTokenEnv];
    if (!botToken) return;

    await fetch(
      `https://api.telegram.org/bot${botToken}/closeForumTopic`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: groupId, message_thread_id: channelId }),
      },
    );
  }
}
