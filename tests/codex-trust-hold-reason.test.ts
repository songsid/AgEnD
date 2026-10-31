/**
 * A held codex trust prompt says why the authorized answer passed it by (log only): the pane's folder and root against
 * what preTrust authorized, and whether the instance's own config trusts the folder codex asks about — so a field case
 * of a held "Trust this folder?" explains itself in daemon.log (#2893).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-trust-why-"));
  dirs.push(dir);
  const shared = join(dir, "shared-codex"), instance = join(dir, "instance"), cwd = join(dir, "folder");
  for (const d of [shared, instance, cwd]) mkdirSync(d);
  process.env.CODEX_HOME = shared;
  const backend = new CodexBackend(instance);
  backend.writeConfig({ workingDirectory: cwd, instanceDir: instance, instanceName: "test", mcpServers: {} } as any);
  return { dir, instance, cwd, backend };
}
/** Codex's "Folder access" decision block (0.156+ layout), as the trust-modal tests draw it. */
function trustPane(folder: string, cursor: "trust" | "quit" = "trust") {
  return ["› Ask Codex to do anything", "", "  Folder access", `  ${folder}`, "",
    "  Trust this folder? Codex can read, edit, and run files here, subject to your",
    "  permission settings. Folder settings can run code automatically, even",
    "  without a model request. Continue only if you trust these files. Your trust",
    "  decision will be saved.", "",
    `${cursor === "trust" ? "›" : " "} 1. Trust and continue`, `${cursor === "quit" ? "›" : " "} 2. Quit`, "",
    "  enter continue · esc quit", ""].join("\n");
}
const hold = (backend: CodexBackend) => backend.getRuntimeDialogs().find(d => d.description === "Codex folder trust needs human confirmation")!;

describe("a held codex trust prompt says why it was not answered", () => {
  it("no preTrust for this launch: said so, with the config path and that the folder is not trusted there", () => {
    const { cwd, backend } = fixture();
    const why = hold(backend).heldReason!(trustPane(cwd));
    expect(why).toMatchObject({ trustHoldReason: "preTrust did not authorize this launch", promptFolder: cwd, authorizedCwd: null, configTrust: "absent" });
    expect(String(why.configPath)).toMatch(/config\.toml$/);
  });

  it("preTrust authorized another folder: the two folders, side by side", () => {
    const { cwd, backend } = fixture();
    backend.preTrust(cwd);
    const stranger = join(cwd, "stranger");
    expect(hold(backend).heldReason!(trustPane(stranger))).toMatchObject({
      trustHoldReason: "the folder codex asks about is not the one AgEnD trusted", promptFolder: stranger, authorizedCwd: cwd, configTrust: "absent",
    });
  });

  it("the authorized folder with the cursor off Trust is held for that reason, and its config does trust it", () => {
    const { cwd, backend } = fixture();
    backend.preTrust(cwd);
    expect(hold(backend).heldReason!(trustPane(cwd, "quit"))).toMatchObject({
      trustHoldReason: "the cursor is not on the trust choice", promptFolder: cwd, authorizedCwd: cwd, configTrust: "trusted",
    });
  });

  it("a trust layout AgEnD never answers (Open restricted / Trust and continue) is named as such", () => {
    const { backend } = fixture();
    const pane = ["  Folder access", "  /work/repo", "", "› 1. Trust and continue", "  2. Open restricted", "  3. Quit", "", "  enter continue · esc quit", ""].join("\n");
    expect(hold(backend).isActive!(pane)).toBe(true);
    expect(hold(backend).heldReason!(pane)).toMatchObject({ trustHoldReason: expect.stringMatching(/^a trust layout AgEnD never answers/) });
  });

  it("the daemon's startup scan logs it once, with the reason, when the prompt is held (it never logged before)", async () => {
    const { instance, cwd, backend } = fixture();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("test", {
      working_directory: cwd, backend: "codex", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
    } as any, instance, false, backend, undefined, { child: () => logger } as any) as any;
    const pane = trustPane(cwd);                       // no preTrust: the authorized answer does not take it
    daemon.tmux = { capturePane: vi.fn(async () => pane), isWindowAlive: async () => true, sendSpecialKey: vi.fn(async () => true) };
    await daemon.dismissDialogsUntilReady(300, 0);
    const held = logger.warn.mock.calls.filter(([, msg]) => String(msg).startsWith("Startup dialog held"));
    expect(held).toHaveLength(1);
    expect(held[0]![0]).toMatchObject({ description: "Codex folder trust needs human confirmation",
      trustHoldReason: "preTrust did not authorize this launch", promptFolder: cwd, authorizedCwd: null });
    expect(daemon.tmux.sendSpecialKey).not.toHaveBeenCalled();
  });
});
