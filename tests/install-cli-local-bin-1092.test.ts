/**
 * #1092: `/install-cli codex` left codex unreachable from the fleet. The codex
 * installer (read from https://chatgpt.com/codex/install.sh and run for real,
 * see the opt-in test at the bottom) puts a `codex` symlink in
 * `${CODEX_INSTALL_DIR:-$HOME/.local/bin}` and, when `$SHELL` is bash on Linux,
 * appends its PATH line to `~/.bashrc` — below the stock early `return` that
 * every non-interactive shell takes. /install-cli verified on `bash -lc`
 * (#1059), which never gets that far on a root account: "verification
 * failed", and nothing joined the fleet's PATH. The installer's own binary
 * directory is now checked when the login shell cannot see the binary.
 *
 * The HOME here is the shape the real installer left behind: Debian/Ubuntu
 * root's `.profile` (sources `.bashrc`) and `.bashrc` (returns when not
 * interactive), with the installer's block appended after that return.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeSessions: Array<{ events: any }> = [];
vi.mock("../src/login-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/login-manager.js")>();
  class FakeLoginSession {
    state = "starting";
    constructor(_flow: any, _tmux: any, public events: any) { fakeSessions.push({ events }); }
    async start() {}
    async cancel() {}
  }
  return { ...real, LoginSession: FakeLoginSession };
});
vi.mock("../src/tmux-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tmux-manager.js")>();
  class FakeTmux { constructor() {} static async ensureSession() {} }
  return { ...real, TmuxManager: Object.assign(FakeTmux, { ensureSession: async () => {} }) };
});

import { FleetManager } from "../src/fleet-manager.js";
import { checkBinaryInstalled } from "../src/instance-lifecycle.js";
import { resolveBinary } from "../src/backend/types.js";

const ROOT_PROFILE = `if [ "$BASH" ]; then\n  if [ -f ~/.bashrc ]; then\n    . ~/.bashrc\n  fi\nfi\nmesg n 2> /dev/null || true\n`;
const ROOT_BASHRC = `[ -z "$PS1" ] && return\nexport LS_OPTIONS='--color=auto'\n`;

let root: string;
let home: string;
let localBin: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: process.env.SHELL, CODEX_INSTALL_DIR: process.env.CODEX_INSTALL_DIR, GROK_BIN_DIR: process.env.GROK_BIN_DIR };

/** What install.sh leaves: the release under ~/.codex, a symlink in BIN_DIR, the PATH block in .bashrc. */
function installLikeTheRealInstaller(binDir: string) {
  const release = join(home, ".codex", "packages", "standalone", "current", "bin");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "codex"), "#!/bin/sh\necho codex-cli 0.160.0\n");
  chmodSync(join(release, "codex"), 0o755);
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join(release, "codex"), join(binDir, "codex"));
  writeFileSync(join(home, ".bashrc"),
    `${ROOT_BASHRC}\n# >>> Codex installer >>>\nexport PATH="${binDir}:$PATH"\n# <<< Codex installer <<<\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-1092-"));
  home = join(root, "home");
  localBin = join(home, ".local", "bin");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".profile"), ROOT_PROFILE);
  writeFileSync(join(home, ".bashrc"), ROOT_BASHRC);
  process.env.HOME = home;
  process.env.SHELL = "/bin/bash";
  process.env.PATH = "/usr/bin:/bin";
  delete process.env.CODEX_INSTALL_DIR;
  delete process.env.GROK_BIN_DIR;
  fakeSessions.length = 0;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fleet() {
  const fm = new FleetManager(join(root, "data"));
  fm.fleetConfig = { defaults: {}, instances: {} } as any;
  const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
  const adapter = { id: "tg", type: "telegram", notifyAlert: vi.fn(async (chatId: string) => ({ messageId: "p1", chatId })),
    sendText, editMessageRemoveButtons: vi.fn() } as any;
  vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
  return { fm, sendText, chat: { adapter, adapterId: "tg", chatId: "chat", threadId: undefined, userId: "admin" } };
}

async function finishInstall(fm: FleetManager, chat: any) {
  await fm.startInstallSession("codex", chat);
  await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
}

describe("/install-cli codex: the installer's ~/.local/bin is found when no login shell can see it (#1092)", () => {
  it("the reported state: the binary is there, but `bash -lc` (what #1059 verified with) cannot find it", () => {
    installLikeTheRealInstaller(localBin);
    const r = spawnSync("bash", ["-lc", "command -v codex"], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(localBin, "codex"))).toBe(true);
    expect(checkBinaryInstalled("codex")).toBe(false);
  });

  it("after the install, the fleet's PATH has ~/.local/bin: `which`, a spawn and the success notice all see codex", async () => {
    installLikeTheRealInstaller(localBin);
    const { fm, chat, sendText } = fleet();
    await finishInstall(fm, chat);
    expect(process.env.PATH!.split(":")[0]).toBe(localBin);
    expect(checkBinaryInstalled("codex")).toBe(true);
    expect(resolveBinary("codex")).toBe(join(localBin, "codex"));
    expect(execFileSync("codex", [], { encoding: "utf8" }).trim()).toBe("codex-cli 0.160.0");
    expect(sendText.mock.calls.map(c => String(c[1]))).toContainEqual(expect.stringMatching(/codex.*verified/));
  });

  it("CODEX_INSTALL_DIR (the installer's own override) is honoured", async () => {
    const custom = join(root, "opt-codex-bin");
    process.env.CODEX_INSTALL_DIR = custom;
    installLikeTheRealInstaller(custom);
    const { fm, chat } = fleet();
    await finishInstall(fm, chat);
    expect(process.env.PATH!.split(":")[0]).toBe(custom);
    expect(checkBinaryInstalled("codex")).toBe(true);
  });

  it("nothing installed anywhere: still reported as a failed verification, PATH untouched", async () => {
    const { fm, chat, sendText } = fleet();
    await finishInstall(fm, chat);
    expect(String(sendText.mock.calls.at(-1)![1])).toContain("PATH");
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("a non-executable file in ~/.local/bin is not a binary", async () => {
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(localBin, "codex"), "not a program");
    chmodSync(join(localBin, "codex"), 0o644);
    const { fm, chat } = fleet();
    await finishInstall(fm, chat);
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("a directory named codex in ~/.local/bin is not a binary", async () => {
    mkdirSync(join(localBin, "codex"), { recursive: true });
    const { fm, chat } = fleet();
    await finishInstall(fm, chat);
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("a relative CODEX_INSTALL_DIR is ignored (never resolved against the fleet's cwd)", async () => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      process.env.CODEX_INSTALL_DIR = "relbin";
      mkdirSync(join(root, "relbin"), { recursive: true });
      writeFileSync(join(root, "relbin", "codex"), "#!/bin/sh\necho rel\n");
      chmodSync(join(root, "relbin", "codex"), 0o755);
      const { fm, chat } = fleet();
      await finishInstall(fm, chat);
      expect(process.env.PATH).toBe("/usr/bin:/bin");
    } finally {
      process.chdir(cwd);
    }
  });

  it("a login shell that does see the binary still wins (the #1059 path is unchanged)", async () => {
    const other = join(home, "elsewhere");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "codex"), "#!/bin/sh\necho other\n");
    chmodSync(join(other, "codex"), 0o755);
    writeFileSync(join(home, ".bash_profile"), `export PATH="${other}:$PATH"\n`);
    installLikeTheRealInstaller(localBin);
    const { fm, chat } = fleet();
    await finishInstall(fm, chat);
    expect(process.env.PATH!.split(":")[0]).toBe(other);
  });
});

/**
 * Where each backend's real installer left its binary in a throwaway root-like
 * HOME with SHELL=/bin/bash (run 2026-10-02, see the opt-in test below), and
 * whether `bash -lc` could see it there:
 *
 *   claude-code  ~/.local/bin/claude     no rc edit                  not found
 *   codex        ~/.local/bin/codex      .bashrc (after the return)  not found
 *   kiro-cli     ~/.local/bin/kiro-cli   no rc edit                  not found
 *   grok         ~/.grok/bin/grok        .bashrc (after the return)  not found
 *   opencode     ~/.opencode/bin/opencode .bashrc (after the return) not found
 *   antigravity  ~/.local/bin/agy        .profile and .bashrc        found
 *   muse         ~/.local/bin/muse (new install command)  no rc edit  not found
 */
const LAYOUTS: Array<[backend: string, binary: string, dir: (home: string) => string]> = [
  ["claude-code", "claude", h => join(h, ".local", "bin")],
  ["codex", "codex", h => join(h, ".local", "bin")],
  ["kiro-cli", "kiro-cli", h => join(h, ".local", "bin")],
  ["grok", "grok", h => join(h, ".grok", "bin")],
  ["opencode", "opencode", h => join(h, ".opencode", "bin")],
  ["antigravity", "agy", h => join(h, ".local", "bin")],
  ["muse", "muse", h => join(h, ".local", "bin")],
];

describe("every /install-cli backend is found where its own installer puts it (#1092)", () => {
  for (const [backend, binary, dirOf] of LAYOUTS) {
    it(`${backend}: ${binary} in its installer's directory joins the fleet PATH`, async () => {
      const dir = dirOf(home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, binary), `#!/bin/sh\necho ${binary} ok\n`);
      chmodSync(join(dir, binary), 0o755);
      expect(spawnSync("bash", ["-lc", `command -v ${binary}`]).status, "login shell must not see it here").not.toBe(0);
      const { fm, chat } = fleet();
      await fm.startInstallSession(backend, chat);
      await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
      expect(process.env.PATH!.split(":")[0]).toBe(dir);
      expect(checkBinaryInstalled(binary)).toBe(true);
    });
  }

  it("grok's own override (GROK_BIN_DIR) is honoured", async () => {
    const custom = join(root, "grok-bin");
    process.env.GROK_BIN_DIR = custom;
    try {
      mkdirSync(custom, { recursive: true });
      writeFileSync(join(custom, "grok"), "#!/bin/sh\necho grok\n");
      chmodSync(join(custom, "grok"), 0o755);
      const { fm, chat } = fleet();
      await fm.startInstallSession("grok", chat);
      await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
      expect(process.env.PATH!.split(":")[0]).toBe(custom);
    } finally {
      delete process.env.GROK_BIN_DIR;
    }
  });

  it("muse is installed as a saved launcher in ~/.local/bin, never piped (it would install into the cwd)", async () => {
    const { BACKEND_INSTALLATION_INFO } = await import("../src/instance-lifecycle.js");
    const cmd = BACKEND_INSTALLATION_INFO.muse!.install;
    expect(cmd).not.toMatch(/\|\s*bash/);
    expect(cmd).toContain('-o "$HOME/.local/bin/muse"');
    expect(cmd).toContain('MUSE_LAUNCHER_INSTALL=1 "$HOME/.local/bin/muse"');
  });

  it("the setup wizard shows the same muse install command as /install-cli", async () => {
    const { BACKEND_INSTALLATION_INFO } = await import("../src/instance-lifecycle.js");
    const src = (await import("node:fs")).readFileSync(join(process.cwd(), "src", "setup-wizard.ts"), "utf8");
    expect(src).toContain(`install: '${BACKEND_INSTALLATION_INFO.muse!.install}'`);
  });
});

/**
 * Opt-in (`AGEND_INSTALL_E2E=1`, network, large downloads): each backend's
 * actual /install-cli command, for real, into its own throwaway root-like
 * HOME with no CLI on PATH and a scratch cwd, then the real completion path.
 */
describe.skipIf(process.env.AGEND_INSTALL_E2E !== "1")("real installers through /install-cli completion (#1092)", () => {
  for (const [backend, binary] of LAYOUTS) {
    it(`${backend}: the real installer, then the fleet finds ${binary}`, async () => {
      const { BACKEND_INSTALLATION_INFO } = await import("../src/instance-lifecycle.js");
      const cwd = join(root, "cwd");
      mkdirSync(cwd, { recursive: true });
      const r = spawnSync("bash", ["-c", BACKEND_INSTALLATION_INFO[backend]!.install], {
        cwd, env: { HOME: home, SHELL: "/bin/bash", PATH: "/usr/bin:/bin", TERM: "dumb" },
        input: "", encoding: "utf8", timeout: 600_000,
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const { fm, chat } = fleet();
      await fm.startInstallSession(backend, chat);
      await fakeSessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
      expect(checkBinaryInstalled(binary), `${backend}: fleet PATH ${process.env.PATH}`).toBe(true);
    }, 660_000);
  }
});
