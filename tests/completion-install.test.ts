import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectShells,
  installBashCompletion,
  installZshCompletion,
  installCompletions,
  ZSH_RC_MARKER,
} from "../src/completion-install.js";

// Use unique temp directories per test run to avoid collisions when multiple
// vitest processes run in parallel (issue #669)
const HOME = mkdtempSync(join(tmpdir(), "ccd-test-completion-home-"));
const SYS = mkdtempSync(join(tmpdir(), "ccd-test-completion-sys-"));

const BASH_SCRIPT = "# bash completion v1\ncomplete -F _agend agend\n";
const ZSH_FPATH = "#compdef agend\n_agend() { :; }\n_agend \"$@\"\n";

let savedXdg: string | undefined;

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(SYS, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  // The bash path honours XDG_DATA_HOME; tests must not leak the runner's.
  savedXdg = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  rmSync(HOME, { recursive: true, force: true });
  rmSync(SYS, { recursive: true, force: true });
});

describe("detectShells", () => {
  it("reads $SHELL and rc-file evidence, deduplicated", () => {
    writeFileSync(join(HOME, ".zshrc"), "# zshrc");
    expect(detectShells({ SHELL: "/bin/bash" }, HOME)).toEqual(["bash", "zsh"]);
  });

  it("returns empty for exotic shells with no rc files", () => {
    expect(detectShells({ SHELL: "/usr/bin/fish" }, HOME)).toEqual([]);
  });

  it("detects bash from .bashrc alone (no $SHELL)", () => {
    writeFileSync(join(HOME, ".bashrc"), "# bashrc");
    expect(detectShells({}, HOME)).toEqual(["bash"]);
  });
});

describe("installBashCompletion", () => {
  it("writes the user-level bash-completion file without touching any rc file", () => {
    const r = installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false });
    expect(r.status).toBe("installed");
    expect(r.path).toBe(join(HOME, ".local/share/bash-completion/completions/agend"));
    expect(readFileSync(r.path!, "utf-8")).toBe(BASH_SCRIPT);
    expect(existsSync(join(HOME, ".bashrc"))).toBe(false);
  });

  it("is idempotent: unchanged content reports unchanged, new content updates", () => {
    installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false });
    expect(installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false }).status).toBe("unchanged");
    const r = installBashCompletion("# bash completion v2\n", { home: HOME, isRoot: false });
    expect(r.status).toBe("updated");
    expect(readFileSync(r.path!, "utf-8")).toContain("v2");
  });

  it("prefers the system directory when root and it is writable", () => {
    const sysDir = join(SYS, "bash-completion", "completions");
    mkdirSync(sysDir, { recursive: true });
    const r = installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: true, systemBashDir: sysDir });
    expect(r.path).toBe(join(sysDir, "agend"));
    expect(r.status).toBe("installed");
  });

  it("refresh mode skips when nothing was ever installed", () => {
    expect(installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false, refresh: true }).status).toBe("skipped");
  });

  it("refresh mode rewrites an existing stale file", () => {
    installBashCompletion("# old names\n", { home: HOME, isRoot: false });
    const r = installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false, refresh: true });
    expect(r.status).toBe("updated");
    expect(readFileSync(r.path!, "utf-8")).toBe(BASH_SCRIPT);
  });
});

describe("installZshCompletion", () => {
  it("without --modify-rc: leaves ~/.zshrc alone and returns a hint", () => {
    writeFileSync(join(HOME, ".zshrc"), "# my zshrc\n");
    const r = installZshCompletion(ZSH_FPATH, { home: HOME, isRoot: false });
    expect(r.status).toBe("hint");
    expect(readFileSync(join(HOME, ".zshrc"), "utf-8")).toBe("# my zshrc\n");
    expect(r.hint).toContain("--modify-rc");
  });

  it("with modifyRc: appends the marker block exactly once", () => {
    writeFileSync(join(HOME, ".zshrc"), "# my zshrc\n");
    const first = installZshCompletion(ZSH_FPATH, { home: HOME, isRoot: false, modifyRc: true });
    expect(first.status).toBe("installed");
    const second = installZshCompletion(ZSH_FPATH, { home: HOME, isRoot: false, modifyRc: true });
    expect(second.status).toBe("unchanged");
    const content = readFileSync(join(HOME, ".zshrc"), "utf-8");
    expect(content.startsWith("# my zshrc\n")).toBe(true);
    expect(content.split(ZSH_RC_MARKER).length - 1).toBe(1); // exactly one block
    expect(content).toContain('eval "$(agend completion zsh)"');
  });

  it("root with a writable site-functions dir writes _agend and skips the rc entirely", () => {
    const sysDir = join(SYS, "zsh", "site-functions");
    mkdirSync(sysDir, { recursive: true });
    const r = installZshCompletion(ZSH_FPATH, { home: HOME, isRoot: true, systemZshDir: sysDir });
    expect(r.status).toBe("installed");
    expect(r.path).toBe(join(sysDir, "_agend"));
    expect(readFileSync(r.path!, "utf-8").startsWith("#compdef agend")).toBe(true);
    expect(existsSync(join(HOME, ".zshrc"))).toBe(false);
  });

  it("refresh mode never adds the rc line, but keeps an existing marker as unchanged", () => {
    expect(installZshCompletion(ZSH_FPATH, { home: HOME, isRoot: false, refresh: true }).status).toBe("skipped");
    writeFileSync(join(HOME, ".zshrc"), `x\n${ZSH_RC_MARKER}\neval ...\n`);
    // The rc line re-evals the live binary every shell start — nothing to refresh.
    expect(installZshCompletion(ZSH_FPATH, { home: HOME, isRoot: false, refresh: true }).status).toBe("unchanged");
  });

  it("creates ~/.zshrc when authorized and missing", () => {
    const r = installZshCompletion(ZSH_FPATH, { home: HOME, isRoot: false, modifyRc: true });
    expect(r.status).toBe("installed");
    expect(readFileSync(join(HOME, ".zshrc"), "utf-8")).toContain(ZSH_RC_MARKER);
  });
});

describe("installCompletions", () => {
  it("fans out per shell with one shared policy", () => {
    writeFileSync(join(HOME, ".zshrc"), "");
    const results = installCompletions(
      { bash: BASH_SCRIPT, zshFpath: ZSH_FPATH },
      ["bash", "zsh"],
      { home: HOME, isRoot: false },
    );
    expect(results.map(r => [r.shell, r.status])).toEqual([
      ["bash", "installed"],
      ["zsh", "hint"],
    ]);
  });
});

// ── #1003: the bash file only works where bash-completion is loaded ─────────
import { spawnSync } from "node:child_process";
import {
  BASH_RC_MARKER,
  completionStatus,
  completionTipNeeded,
  probeBashCompletion,
} from "../src/completion-install.js";

const BC_MAIN = "/usr/share/bash-completion/bash_completion";
const bashFile = () => join(HOME, ".local", "share", "bash-completion", "completions", "agend");

describe("bash completion activation (#1003)", () => {
  it("keeps the static file and touches no rc file when bash-completion is loaded", () => {
    const r = installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false, bashCompletionActive: () => "active" });
    expect(r).toEqual({ shell: "bash", status: "installed", path: bashFile() });
    expect(existsSync(join(HOME, ".bashrc"))).toBe(false);
  });

  it("says <TAB> will not work, and why, when bash-completion is not loaded and no rc edit is authorized", () => {
    writeFileSync(join(HOME, ".bashrc"), "# mine\n");
    const r = installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false, bashCompletionActive: () => "inactive" });
    expect(r.status).toBe("hint");
    expect(r.hint).toMatch(/bash-completion is not loaded.*--modify-rc/);
    expect(readFileSync(join(HOME, ".bashrc"), "utf-8")).toBe("# mine\n");
  });

  it("adds the marker-guarded eval line to ~/.bashrc exactly once when authorized", () => {
    writeFileSync(join(HOME, ".bashrc"), "# mine\n");
    const opts = { home: HOME, isRoot: false, modifyRc: true, bashCompletionActive: () => "inactive" as const };
    expect(installBashCompletion(BASH_SCRIPT, opts)).toMatchObject({ status: "installed", path: join(HOME, ".bashrc") });
    expect(installBashCompletion(BASH_SCRIPT, opts)).toMatchObject({ status: "unchanged" });
    const rc = readFileSync(join(HOME, ".bashrc"), "utf-8");
    expect(rc.startsWith("# mine\n")).toBe(true);
    expect(rc.split(BASH_RC_MARKER).length - 1).toBe(1);
    expect(rc).toContain('eval "$(agend completion bash)"');
  });

  it("does not block the install when activation cannot be checked", () => {
    expect(installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false, bashCompletionActive: () => "unknown" }).status).toBe("installed");
  });

  it("never probes or edits an rc file in refresh mode (agend update)", () => {
    installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false });
    const probe = () => { throw new Error("refresh must not probe"); };
    expect(installBashCompletion(BASH_SCRIPT + "#v2\n", { home: HOME, isRoot: false, refresh: true, modifyRc: true, bashCompletionActive: probe }).status).toBe("updated");
    expect(existsSync(join(HOME, ".bashrc"))).toBe(false);
  });

  it.skipIf(!existsSync(BC_MAIN))("probes a real interactive bash: active only when its rc loads bash-completion", () => {
    writeFileSync(join(HOME, ".bashrc"), `. ${BC_MAIN}\n`);
    expect(probeBashCompletion(HOME)).toBe("active");
    writeFileSync(join(HOME, ".bashrc"), "# no bash-completion here\n");
    // Some distros source bash-completion from /etc/bash.bashrc for everyone.
    const systemWide = spawnSync("bash", ["-c", "grep -v '^\\s*#' /etc/bash.bashrc 2>/dev/null | grep -q bash_completion"]).status === 0;
    expect(probeBashCompletion(HOME)).toBe(systemWide ? "active" : "inactive");
  });
});

describe("completion status (#1003)", () => {
  const sys = { systemBashDir: join(SYS, "bash"), systemZshDir: join(SYS, "zsh") };

  it("reports missing, inactive and active for bash", () => {
    expect(completionStatus(["bash"], { home: HOME, ...sys, bashCompletionActive: () => "active" })[0]!.state).toBe("missing");
    installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false });
    expect(completionStatus(["bash"], { home: HOME, ...sys, bashCompletionActive: () => "inactive" })[0]).toMatchObject({ state: "inactive", detail: expect.stringContaining("--modify-rc") });
    expect(completionStatus(["bash"], { home: HOME, ...sys, bashCompletionActive: () => "active" })[0]!.state).toBe("active");
    installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false, modifyRc: true, bashCompletionActive: () => "inactive" });
    expect(completionStatus(["bash"], { home: HOME, ...sys, bashCompletionActive: () => "inactive" })[0]!.state).toBe("active");
  });

  it("reports zsh active only with the rc marker or the site-functions file", () => {
    expect(completionStatus(["zsh"], { home: HOME, ...sys })[0]!.state).toBe("missing");
    installZshCompletion(ZSH_FPATH, { home: HOME, isRoot: false, modifyRc: true });
    expect(completionStatus(["zsh"], { home: HOME, ...sys })[0]!.state).toBe("active");
  });
});

describe("the agend ls tip (#1003)", () => {
  const sys = { systemBashDir: join(SYS, "bash"), systemZshDir: join(SYS, "zsh") };
  it("shows only while bash or zsh is in use and nothing is installed", () => {
    expect(completionTipNeeded({ SHELL: "/bin/bash" }, { home: HOME, ...sys })).toBe(true);
    expect(completionTipNeeded({ SHELL: "/usr/bin/fish" }, { home: HOME, ...sys })).toBe(false);
    installBashCompletion(BASH_SCRIPT, { home: HOME, isRoot: false });
    expect(completionTipNeeded({ SHELL: "/bin/bash" }, { home: HOME, ...sys })).toBe(false);
  });

  it("also stops once only an rc line exists", () => {
    installZshCompletion(ZSH_FPATH, { home: HOME, isRoot: false, modifyRc: true });
    expect(completionTipNeeded({ SHELL: "/bin/zsh" }, { home: HOME, ...sys })).toBe(false);
  });
});

describe("agend completion install, for real (#1003)", () => {
  it.skipIf(!existsSync(BC_MAIN))("tells a shell without bash-completion that <TAB> will not work yet, then fixes it with --modify-rc", () => {
    writeFileSync(join(HOME, ".bashrc"), "# no bash-completion\n");
    const systemWide = spawnSync("bash", ["-c", "grep -v '^\\s*#' /etc/bash.bashrc 2>/dev/null | grep -q bash_completion"]).status === 0;
    if (systemWide) return;
    const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), "completion", ...args],
      { env: { ...process.env, HOME, SHELL: "/bin/bash", XDG_DATA_HOME: "" }, encoding: "utf-8", timeout: 60_000 });
    const plain = cli("install", "bash");
    expect(plain.stdout).toMatch(/bash-completion is not loaded/);
    const fixed = cli("install", "bash", "--modify-rc");
    expect(fixed.stdout).toMatch(/completion installed .*\.bashrc/);
    expect(fixed.stdout).toMatch(/Open a new terminal/);
    expect(cli("status", "bash").stdout).toMatch(/bash: active/);
  }, 90_000);
});
