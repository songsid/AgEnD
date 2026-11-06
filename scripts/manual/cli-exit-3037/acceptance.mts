/** Real CLI /exit, real tmux/control/health/lifecycle/Restart offer; synthetic account and local API only. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { FleetManager } from "../../../src/fleet-manager.js";
import { Daemon } from "../../../src/daemon.js";
import { ClaudeCodeBackend } from "../../../src/backend/claude-code.js";
import { TmuxManager } from "../../../src/tmux-manager.js";
import { TmuxControlClient } from "../../../src/tmux-control.js";
import { DEFAULT_INSTANCE_CONFIG } from "../../../src/config.js";
import { getTmuxSocketName } from "../../../src/paths.js";
import { setLocale } from "../../../src/locale.js";
const binary = process.env.CLAUDE_BIN;
assert(binary, "Set CLAUDE_BIN to the real Claude executable; no account or vendor API is needed");
assert.equal(execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" }).trim(), "", "Commit tracked source first");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const root = mkdtempSync(resolve(".artifacts/normal-exit-3037-")), home = join(root, "home"), cwd = join(root, "cwd"), config = join(home, ".claude");
mkdirSync(config, { recursive: true }); mkdirSync(cwd); process.env.AGEND_HOME = join(home, "agend");
const socket = getTmuxSocketName(); assert(socket && socket !== "agend"); TmuxManager.setSocketName(socket); setLocale("en");
const session = "exit-proof", tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const key = "local-fixture-only-not-a-credential";
writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
writeFileSync(join(root, "settings.json"), JSON.stringify({ theme: "dark" })); writeFileSync(join(root, "mcp.json"), '{"mcpServers":{}}');
let apiTurns = 0;
const server = createServer((req, res) => { if (req.url?.startsWith("/v1/messages") && !req.url.includes("count_tokens")) apiTurns++; req.resume(); res.setHeader("content-type", "application/json"); res.end("{}"); });
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const alerts: any[] = [], notices: string[] = [], events: any[] = [];
const fm = new FleetManager(process.env.AGEND_HOME), instance = join(root, "instance"); mkdirSync(instance);
const cfg = { ...structuredClone(DEFAULT_INSTANCE_CONFIG), working_directory: cwd, backend: "claude-code", channel_id: "scratch", topic_id: "worker-topic", mcp_auto_restart: false,
  restart_policy: { max_retries: 0, backoff: "linear" as const, reset_after: 0, health_check_interval_ms: 25 } };
fm.fleetConfig = { defaults: {}, channels: [{ id: "scratch", type: "telegram", mode: "topic", group_id: "scratch-group", bot_token_env: "UNUSED", access: { mode: "locked", allowed_users: ["admin"] } }],
  instances: { general: { ...cfg, general_topic: true, topic_id: "general-topic" }, worker: cfg } };
const adapter: any = { id: "scratch", type: "telegram", sendText: async (_chat: string, text: string) => { notices.push(text); return { messageId: "notice", chatId: "scratch-group" }; },
  notifyAlert: async (_chat: string, value: any) => { alerts.push(value); return { messageId: "offer", chatId: "scratch-group", threadId: "general-topic" }; }, editMessageRemoveButtons: async () => {} };
fm.adapter = adapter; fm.adapters.set("scratch", adapter); fm.worlds.set("scratch", { id: "scratch", adapter, groupId: "scratch-group", channelConfig: fm.fleetConfig.channels![0] } as never);
const daemon = new Daemon("worker", cfg, instance, true, new ClaudeCodeBackend(instance), undefined, fm.logger);
fm.daemons.set("worker", daemon); fm.daemons.set("general", {} as never); fm.lifecycle.attachIncidentHandlers("worker", daemon);
daemon.on("supervision_ended", value => events.push(value));
let control: TmuxControlClient | undefined, childPid: number | null = null, passed = false;
const until = async (check: () => Promise<boolean> | boolean, label: string, ms = 20_000) => { const end = performance.now() + ms; while (!await check()) { assert(performance.now() < end, label); await new Promise(r => setTimeout(r, 50)); } };
try {
  await TmuxManager.ensureSession(session);
  const env = { PATH: process.env.PATH!, HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), AGEND_HOME: process.env.AGEND_HOME!, TERM: "xterm-256color",
    ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}`, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  const command = "env -i " + Object.entries(env).map(([k, v]) => k + "=" + quote(v)).join(" ") + " " + quote(binary)
    + " --settings " + quote(join(root, "settings.json")) + " --mcp-config " + quote(join(root, "mcp.json")) + " --permission-mode plan";
  const launcher = new TmuxManager(session, ""); const window = await launcher.createWindow(command, cwd, "worker"); await launcher.setRemainOnExit();
  childPid = await TmuxManager.getPanePid(session, window);
  await until(async () => { const screen = await launcher.capturePane(); return screen.includes("❯") && screen.includes("Claude Code"); }, "real Claude composer");
  control = new TmuxControlClient(session, 100, fm.logger); control.start(); await control.registerWindow(window);
  const pane = new TmuxManager(session, window, undefined, control); (daemon as any).tmux = pane;
  (daemon as any).tmuxSessionName = session; (daemon as any).startHealthCheck();
  await pane.sendKeys("/exit"); assert(await pane.sendSpecialKey("Enter"));
  await until(() => alerts.length === 1 && events.length === 1, "normal-exit Restart offer");
  assert.equal(daemon.getProcessStatus(), "stopped"); assert.equal(events[0].exitCode, 0); assert.equal((daemon as any).crashCount, 0);
  assert.equal(alerts[0].type, "exit_restart"); assert.match(alerts[0].message, /stopped \(normal exit\).*Restart/s);
  assert.deepEqual(alerts[0].choices.map((x: any) => x.label), ["Restart", "Ignore"]);
  assert.equal((daemon as any).healthCheckPaused, true); assert.equal(apiTurns, 0);
  await new Promise(r => setTimeout(r, 1_250)); assert.equal(alerts.length, 1); assert.equal(events.length, 1);
  assert.equal(await pane.getPaneStatus(), null); // normal-exit branch removed the exact dead window
  passed = true;
  console.log(JSON.stringify({ head, version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), tmux: tmux("-V").trim(),
    scratchHome: true, privateSocket: socket, realControlRead: true, command: "/exit", exitCode: events[0].exitCode, status: daemon.getProcessStatus(), restartOffers: alerts.length,
    offer: alerts[0].message, choices: alerts[0].choices.map((x: any) => x.label), crashCount: (daemon as any).crashCount, apiTurns, noRespawn: true }));
} finally {
  clearTimeout((daemon as any).healthCheckTimer); (daemon as any).stopInstanceStateMonitor();
  for (const entry of (fm as any).pendingNonceButtons.values()) clearTimeout(entry.timer);
  control?.stop(); try { tmux("kill-server"); } catch { /* own server already gone */ }
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  if (childPid) await until(() => { try { process.kill(childPid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }, "owned Claude exit", 5_000);
  rmSync(root, { recursive: true, force: true }); console.log(JSON.stringify({ cleaned: true, passed }));
}
