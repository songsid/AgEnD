/**
 * #931: with the issue's exact user config — a quoted-key status_line and no
 * Context item — the real Codex CLI's idle pane passes every readiness proof.
 *
 * Opt-in (`AGEND_CODEX_E2E=1`, codex-cli 0.157.x on PATH): throwaway
 * AGEND_HOME / CODEX_HOME, a fresh session (no resume), a private tmux socket,
 * and no prompt, so no model turn is spent. The login
 * (`AGEND_CODEX_E2E_AUTH`, default ~/.codex/auth.json) is symlinked, never
 * copied.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const AUTH = process.env.AGEND_CODEX_E2E_AUTH || join(homedir(), ".codex", "auth.json");
function codexVersion(): string | null {
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}
const version = process.env.AGEND_CODEX_E2E === "1" ? codexVersion() : null;
const enabled = !!version && /\b0\.157\.\d+\b/.test(version) && existsSync(AUTH);

let root = "";
let socket = "";
const saved = { AGEND_HOME: process.env.AGEND_HOME, CODEX_HOME: process.env.CODEX_HOME };
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 10_000 });

describe.skipIf(!enabled)("real codex 0.157: a quoted-key status_line without Context reads ready (#931)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agend-codex-e2e-931-"));
    socket = `agend-e2e-931-${process.pid}`;
    process.env.AGEND_HOME = join(root, "agend");
    process.env.CODEX_HOME = join(root, "shared-codex-home");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    symlinkSync(AUTH, join(process.env.CODEX_HOME, "auth.json"));
  });
  afterAll(() => {
    try { tmux("kill-server"); } catch { /* not started */ }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("gets context-remaining prepended and its idle pane passes every readiness proof", async () => {
    const { CodexBackend } = await import("../src/backend/codex.js");
    writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), '"tui"."status_line" = ["model-with-reasoning"]\n');
    const wd = join(root, "work");
    mkdirSync(wd);
    const instanceDir = join(root, "agend", "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    const backend = new CodexBackend(instanceDir);
    const config = { workingDirectory: wd, instanceDir, instanceName: "worker", mcpServers: {}, skipResume: true };
    backend.writeConfig(config);
    backend.preTrust(wd);
    const privateConfig = parse(readFileSync(join((backend as any).isolatedCodexHome, "config.toml"), "utf8")) as any;
    expect(privateConfig.tui.status_line).toEqual(["context-remaining", "model-with-reasoning"]);
    const cmd = backend.buildCommand(config);
    expect(backend.consumeLaunchWarning()).toBeNull();

    tmux("new-session", "-d", "-s", "e2e", "-x", "120", "-y", "36", "-c", wd, `${cmd}; sleep 600`);
    let pane = "";
    const deadline = Date.now() + 45_000;
    for (;;) {
      pane = tmux("capture-pane", "-p", "-t", "e2e");
      if ((backend.getReadyPattern().test(pane) && !backend.getBusyPattern().test(pane)) || Date.now() > deadline) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(pane, pane).toMatch(/Context \d+% left/);
    expect(backend.getReadyPattern().test(pane) && !backend.getBusyPattern().test(pane), pane).toBe(true);
    expect(backend.isDeliveryInputReadyPane(pane), pane).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(pane), pane).toBe(true);
  }, 90_000);
});
