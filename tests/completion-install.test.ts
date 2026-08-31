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
