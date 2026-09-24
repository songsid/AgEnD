import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";

const dirs: string[] = [];
const priorCodexHome = process.env.CODEX_HOME;
afterEach(() => {
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorCodexHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-trust-"));
  dirs.push(dir);
  const shared = join(dir, "shared-codex");
  const instance = join(dir, "instance");
  const cwd = join(dir, "folder");
  mkdirSync(shared);
  mkdirSync(instance);
  mkdirSync(cwd);
  process.env.CODEX_HOME = shared;
  return { dir, shared, instance, cwd, backend: new CodexBackend(instance) };
}

/** Codex 0.156.0 live-captured decision block; paths and non-decision header chrome vary by fixture. */
function liveTrustPane(folder: string, root?: string, cursor: "trust" | "quit" | "unknown" = "trust") {
  return [
    "╭────────────────────────────────────────────────────────╮",
    "│ >_ OpenAI Codex (v0.156.0)                             │",
    "│ model:     loading   /model to change                  │",
    "│ directory: ~/…/folder                                │",
    "╰────────────────────────────────────────────────────────╯",
    "",
    "› Ask Codex to do anything",
    "",
    "  Folder access",
    `  ${folder}`,
    "",
    ...(root ? [
      "  Note: You’re in a subdirectory of a Git project. Trusting will apply to the",
      "  repository root:",
      `  ${root}`,
      "",
    ] : []),
    "  Trust this folder? Codex can read, edit, and run files here, subject to your",
    "  permission settings. Folder settings can run code automatically, even",
    "  without a model request. Continue only if you trust these files. Your trust",
    "  decision will be saved.",
    "",
    `${cursor === "trust" ? "›" : cursor === "quit" ? " " : "?"} 1. Trust and continue`,
    `${cursor === "quit" ? "›" : " "} 2. Quit`,
    "",
    "  enter continue · esc quit",
    "",
  ].join("\n");
}

function active(dialog: { pattern: RegExp; isActive?: (pane: string) => boolean }, pane: string) {
  return dialog.pattern.test(pane) && (dialog.isActive?.(pane) ?? true);
}

describe("Codex 0.156 trust prompt", () => {
  it("overwrites an existing untrusted project entry in the private config, idempotently", () => {
    const { shared, instance, cwd, backend } = fixture();
    writeFileSync(join(shared, "config.toml"), `[projects."${cwd}"]\ntrust_level = "untrusted"\ncustom = "keep"\n`);
    backend.writeConfig({ workingDirectory: cwd, instanceDir: instance, instanceName: "test", mcpServers: {} });
    backend.preTrust(cwd);
    backend.preTrust(cwd);
    const privateConfig = readFileSync(join(instance, "codex-home", "config.toml"), "utf-8");
    expect(privateConfig.match(/trust_level = "trusted"/g)).toHaveLength(1);
    expect(privateConfig).not.toContain('trust_level = "untrusted"');
    expect(privateConfig).toContain('custom = "keep"');
    expect(readFileSync(join(shared, "config.toml"), "utf-8")).toContain('trust_level = "untrusted"');
  });

  it("does not mistake a quoted project table inside a TOML multiline value for effective trust", () => {
    const { shared, instance, cwd, backend } = fixture();
    writeFileSync(join(shared, "config.toml"), `[mcp_servers.third_party.env]\nnote = """\n[projects."${cwd}"]\ntrust_level = "untrusted"\n"""\n`);
    backend.writeConfig({ workingDirectory: cwd, instanceDir: instance, instanceName: "test", mcpServers: {} });
    backend.preTrust(cwd);
    const config = readFileSync(join(instance, "codex-home", "config.toml"), "utf-8");
    expect(config).toContain(`[projects."${cwd}"]\ntrust_level = "trusted"`);
    expect(config).toContain(`note = """\n[projects."${cwd}"]\ntrust_level = "untrusted"\n"""`);
  });

  it("trusts the canonical Git common root, not a linked worktree CWD", () => {
    const { dir, instance, backend } = fixture();
    const main = join(dir, "main");
    const worktree = join(dir, "linked-worktree");
    mkdirSync(main);
    execFileSync("git", ["-C", main, "init", "-q"]);
    execFileSync("git", ["-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "--detach", worktree]);
    backend.writeConfig({ workingDirectory: worktree, instanceDir: instance, instanceName: "test", mcpServers: {} });
    backend.preTrust(worktree);
    const config = readFileSync(join(instance, "codex-home", "config.toml"), "utf-8");
    expect(config).toContain(`[projects."${main}"]\ntrust_level = "trusted"`);
    expect(config).not.toContain(`[projects."${worktree}"]`);
    const [auto] = backend.getStartupDialogs();
    expect(active(auto, liveTrustPane(worktree, main))).toBe(true);
  });

  it("auto-enters only the authorized current folder with canonical options and cursor on Trust", () => {
    const { instance, cwd, backend } = fixture();
    backend.writeConfig({ workingDirectory: cwd, instanceDir: instance, instanceName: "test", mcpServers: {} });
    backend.preTrust(cwd);
    const [auto, hold] = backend.getStartupDialogs();
    expect(auto.keys).toEqual(["Enter"]);
    expect(active(auto, liveTrustPane(cwd))).toBe(true);
    expect(active(auto, liveTrustPane(join(cwd, "stranger")))).toBe(false);
    expect(active(hold, liveTrustPane(join(cwd, "stranger")))).toBe(true);
    expect(active(auto, liveTrustPane(cwd, undefined, "quit"))).toBe(false);
    expect(active(auto, liveTrustPane(cwd, undefined, "unknown"))).toBe(false);
    expect(active(hold, liveTrustPane(cwd, undefined, "quit"))).toBe(true);
    expect(active(hold, liveTrustPane(cwd, undefined, "unknown"))).toBe(true);
    const noHeader = liveTrustPane(cwd).split("\n").slice(7).join("\n");
    expect(active(auto, noHeader)).toBe(false);
    expect(active(hold, noHeader)).toBe(true);
    const noAccessLabel = liveTrustPane(cwd).replace("Folder access", "Workspace permission");
    expect(active(auto, noAccessLabel)).toBe(false);
    expect(active(hold, noAccessLabel)).toBe(true);
  });

  it("holds reversed, extra-option, and unknown-footer variants; ignores quoted prose", () => {
    const { instance, cwd, backend } = fixture();
    backend.writeConfig({ workingDirectory: cwd, instanceDir: instance, instanceName: "test", mcpServers: {} });
    backend.preTrust(cwd);
    const [auto, hold] = backend.getStartupDialogs();
    const pane = liveTrustPane(cwd);
    const reversed = pane.replace("1. Trust and continue", "1. Quit").replace("2. Quit", "2. Trust and continue");
    const extra = pane.replace("  2. Quit", "  2. Quit\n  3. Ask later");
    const footer = pane.replace("enter continue · esc quit", "press enter to proceed");
    for (const variant of [reversed, extra, footer]) {
      expect(active(auto, variant)).toBe(false);
      expect(active(hold, variant)).toBe(true);
    }
    const legacy = pane.replace("Trust this folder?", "Do you trust the files in this folder?");
    expect(active(auto, legacy)).toBe(false);
    expect(active(hold, legacy)).toBe(true);
    // Also captured live from 0.156.0 with an explicit untrusted project entry.
    const restricted = [
      "│ >_ OpenAI Codex (v0.156.0) │",
      "  Folder access",
      `  ${cwd}`,
      "  Config, hooks, and exec policies from untrusted folders stay disabled.",
      "  Trusted project folders can still contribute settings. Skills still load,",
      "  and tools follow your permission settings. Opening will not change saved",
      "  trust.",
      "› 1. Open restricted",
      "  2. Quit",
      "  enter continue · esc quit",
    ].join("\n");
    expect(active(auto, restricted)).toBe(false);
    expect(active(hold, restricted)).toBe(true);
    expect(active(auto, `The captured screen was:\n${pane}\n\n› Ask Codex to do anything`)).toBe(false);
    expect(active(hold, `The captured screen was:\n${pane}\n\n› Ask Codex to do anything`)).toBe(false);
    expect(active(auto, "› User says: Trust this folder? I saw 1. Trust and continue in documentation.")).toBe(false);
  });

  it("startup sends Enter for the authorized modal; an unknown folder stays blocked", async () => {
    const { instance, cwd, backend } = fixture();
    backend.writeConfig({ workingDirectory: cwd, instanceDir: instance, instanceName: "test", mcpServers: {} });
    backend.preTrust(cwd);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("test", {
      working_directory: cwd, backend: "codex", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
    } as any, instance, false, backend, undefined, { child: () => logger } as any) as any;
    let pane = liveTrustPane(cwd);
    const keys: string[] = [];
    daemon.tmux = {
      capturePane: vi.fn(async () => pane),
      isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); pane = "› Ask Codex to do anything"; return true; }),
    };
    expect(await daemon.dismissDialogsUntilReady(1_000, 0)).toBe(true);
    expect(keys).toEqual(["Enter"]);
    pane = liveTrustPane(join(cwd, "stranger"));
    expect((await daemon.probeBlockingDialog()).state).toBe("dialog");
    expect(keys).toEqual(["Enter"]);
    const parked: unknown[] = [];
    daemon.on("dialog_parked", (event: unknown) => parked.push(event));
    const started = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(started);
      await daemon.probeBlockingDialog();
      clock.mockReturnValue(started + 61_000);
      await daemon.probeBlockingDialog();
      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({ holdOnly: true });
    } finally { clock.mockRestore(); }
  });

  it("rechecks the cursor under the write lock and never repeats a safety Enter", async () => {
    const { instance, cwd, backend } = fixture();
    backend.writeConfig({ workingDirectory: cwd, instanceDir: instance, instanceName: "test", mcpServers: {} });
    backend.preTrust(cwd);
    const daemon = new Daemon("test", {
      working_directory: cwd, backend: "codex", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
    } as any, instance, false, backend, undefined,
    { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as any) as any;
    let captures = 0;
    const keys: string[] = [];
    daemon.tmux = {
      capturePane: vi.fn(async () => ++captures === 1 ? liveTrustPane(cwd) : liveTrustPane(cwd, undefined, "quit")),
      isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); return true; }),
    };
    await daemon.dismissDialogsUntilReady(200, 0);
    expect(keys).toEqual([]);

    captures = 0;
    daemon.tmux.capturePane = vi.fn(async () => liveTrustPane(cwd));
    await daemon.dismissDialogsUntilReady(500, 0);
    expect(keys).toEqual(["Enter"]);
    await daemon.dismissDialogsUntilReady(200, 0);
    expect(keys).toEqual(["Enter"]); // a second startup scan must not re-answer the same modal
  });
});
