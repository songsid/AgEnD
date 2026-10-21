/**
 * #2294: install.sh picks sudo when the configured npm prefix does not exist yet
 * (for example ~/.npm-global with no lib/). The one-liner then installs with sudo:
 * on Linux that also drives apt for build tools and fails without a terminal; on
 * macOS a non-admin account is stuck. Judge writability from the nearest existing
 * parent, not the full path. If the prefix is under $HOME, or that parent is
 * writable, create the missing directories and install without sudo. A system
 * prefix the user cannot write still uses sudo.
 *
 * The marked block is run exactly as install.sh has it, under `set -euo pipefail`,
 * with stub npm and sudo, in a scratch HOME. No real install, no live tmux.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const script = readFileSync(join(REPO, "install.sh"), "utf8");
const step = /# >>> npm-prefix sudo[^\n]*\n([\s\S]*?)# <<< npm-prefix sudo/.exec(script)?.[1] ?? "";

const OLD_STEP = `NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "/usr/local")
if [ -w "$NPM_PREFIX/lib/node_modules" ] 2>/dev/null || [ -w "$NPM_PREFIX/lib" ] 2>/dev/null; then
  SUDO=""
else
  SUDO="sudo"
fi
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    for (const p of [join(d, "locked"), join(d, "home", ".npm-global", "lib")]) {
      try { chmodSync(p, 0o755); } catch { /* may not exist */ }
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function host() {
  const d = mkdtempSync(join(tmpdir(), "agend-2294-"));
  dirs.push(d);
  const home = join(d, "home");
  mkdirSync(home, { recursive: true });
  const bin = join(d, "bin");
  mkdirSync(bin);
  const sudoLog = join(d, "sudo.log");
  writeFileSync(join(bin, "sudo"), `#!/bin/sh
printf 'sudo %s\\n' "$*" >> ${JSON.stringify(sudoLog)}
exit 42
`);
  chmodSync(join(bin, "sudo"), 0o755);
  writeFileSync(join(bin, "npm"), `#!/bin/sh
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  printf '%s\\n' "$STUB_NPM_PREFIX"
  exit 0
fi
echo "unexpected npm $*" >&2
exit 9
`);
  chmodSync(join(bin, "npm"), 0o755);
  return { d, home, bin, sudoLog };
}

function runBlock(h: ReturnType<typeof host>, prefix: string, block = step) {
  const r = spawnSync("bash", ["-c", `set -euo pipefail
SUDO=sudo
${block}
printf 'SUDO=%s\\n' "$SUDO"
printf 'PREFIX=%s\\n' "$NPM_PREFIX"
`], {
    encoding: "utf8",
    env: {
      PATH: `${h.bin}:/usr/bin:/bin`,
      HOME: h.home,
      STUB_NPM_PREFIX: prefix,
    },
  });
  const sudo = /(?:^|\n)SUDO=(.*)/.exec(r.stdout ?? "")?.[1] ?? "(missing)";
  return { r, sudo };
}

describe("#2294 install.sh: a missing npm prefix is not a reason to use sudo", () => {
  it("the marked block is install.sh's prefix/sudo step; the website copy is identical", () => {
    expect(step).toMatch(/NPM_PREFIX=\$\(npm config get prefix/);
    expect(readFileSync(join(REPO, "website", "public", "install.sh"), "utf8")).toBe(script);
    // Compatibility: published latest (2.2.6) and beta still go through $SUDO npm.
    expect(script).toMatch(/\$SUDO npm exec --yes --package "\$AGEND_SPEC" -- agend-install/);
    expect(script).toMatch(/\$SUDO npm install -g "\$AGEND_SPEC"/);
  });

  it("prefix does not exist under $HOME: create it and do not use sudo", () => {
    const h = host();
    const prefix = join(h.home, ".npm-global");
    const { r, sudo } = runBlock(h, prefix);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(sudo).toBe("");
    expect(existsSync(join(prefix, "lib"))).toBe(true);
    expect(existsSync(h.sudoLog)).toBe(false);
  });

  it("nearest existing parent is writable: create the prefix and do not use sudo", () => {
    const h = host();
    const parent = join(h.d, "writable");
    mkdirSync(parent);
    const prefix = join(parent, "new-prefix");
    const { r, sudo } = runBlock(h, prefix);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(sudo).toBe("");
    expect(existsSync(join(prefix, "lib"))).toBe(true);
    expect(existsSync(h.sudoLog)).toBe(false);
  });

  it("nearest existing parent is not writable: keep sudo, do not create the prefix", () => {
    const h = host();
    const parent = join(h.d, "locked");
    mkdirSync(parent);
    chmodSync(parent, 0o555);
    const prefix = join(parent, "new-prefix");
    try {
      const { r, sudo } = runBlock(h, prefix);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(sudo).toBe("sudo");
      expect(existsSync(prefix)).toBe(false);
      expect(existsSync(h.sudoLog)).toBe(false);
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it("prefix already exists with lib/: do not use sudo", () => {
    const h = host();
    const prefix = join(h.home, ".npm-global");
    mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
    const { r, sudo } = runBlock(h, prefix);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(sudo).toBe("");
    expect(existsSync(h.sudoLog)).toBe(false);
  });

  it("prefix exists under $HOME but has no lib/: create lib/ and do not use sudo", () => {
    const h = host();
    const prefix = join(h.home, ".npm-global");
    mkdirSync(prefix);
    const { r, sudo } = runBlock(h, prefix);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(sudo).toBe("");
    expect(existsSync(join(prefix, "lib"))).toBe(true);
    expect(existsSync(h.sudoLog)).toBe(false);
  });

  it("prefix is writable but existing lib/ is not: keep sudo (mkdir does not fix lib perms)", () => {
    const h = host();
    const prefix = join(h.home, ".npm-global");
    const lib = join(prefix, "lib");
    mkdirSync(lib, { recursive: true });
    chmodSync(lib, 0o555);
    try {
      const { r, sudo } = runBlock(h, prefix);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(sudo).toBe("sudo");
      expect(existsSync(join(lib, "node_modules"))).toBe(false);
      expect(existsSync(h.sudoLog)).toBe(false);
    } finally {
      chmodSync(lib, 0o755);
    }
  });

  describe("mutation: the pre-#2294 -w lib check", () => {
    it("still picks sudo when the prefix is missing under $HOME (the defect)", () => {
      const h = host();
      const prefix = join(h.home, ".npm-global");
      const { r, sudo } = runBlock(h, prefix, OLD_STEP);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(sudo).toBe("sudo");
      expect(existsSync(prefix)).toBe(false);
    });

    it("still picks sudo when a writable parent has no prefix yet", () => {
      const h = host();
      const parent = join(h.d, "writable");
      mkdirSync(parent);
      const { sudo } = runBlock(h, join(parent, "new-prefix"), OLD_STEP);
      expect(sudo).toBe("sudo");
    });

    it("the live block is not that old check — the missing-prefix cases above would stay red if it were", () => {
      expect(step.replace(/\s+/g, " ").trim()).not.toBe(OLD_STEP.replace(/\s+/g, " ").trim());
      expect(step).toMatch(/dirname/);
      expect(step).toMatch(/HOME/);
    });

    it("checking -w on the full prefix path (not the parent) still picks sudo when the prefix is missing", () => {
      const mutant = `NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "/usr/local")
if [ -w "$NPM_PREFIX" ] 2>/dev/null || [ -w "$NPM_PREFIX/lib" ] 2>/dev/null; then
  SUDO=""
else
  SUDO="sudo"
fi
`;
      const h = host();
      const parent = join(h.d, "writable");
      mkdirSync(parent);
      expect(runBlock(h, join(parent, "new-prefix"), mutant).sudo).toBe("sudo");
    });

    it("skipping mkdir still leaves a missing prefix unwritable, so sudo is picked", () => {
      const mutant = step.replace(/mkdir -p "\$NPM_PREFIX\/lib" "\$NPM_PREFIX\/bin" 2>\/dev\/null \|\| true/, "true");
      expect(mutant).not.toBe(step);
      const h = host();
      const prefix = join(h.home, ".npm-global");
      const { sudo } = runBlock(h, prefix, mutant);
      expect(sudo).toBe("sudo");
      expect(existsSync(prefix)).toBe(false);
    });

    it("putting back || [ -w prefix ] skips sudo even when existing lib/ is not writable", () => {
      const mutant = step.replace(
        /if \[ -w "\$NPM_PREFIX\/lib\/node_modules" \] 2>\/dev\/null \|\| \[ -w "\$NPM_PREFIX\/lib" \] 2>\/dev\/null; then/,
        'if [ -w "$NPM_PREFIX/lib/node_modules" ] 2>/dev/null || [ -w "$NPM_PREFIX/lib" ] 2>/dev/null || [ -w "$NPM_PREFIX" ] 2>/dev/null; then',
      );
      expect(mutant).not.toBe(step);
      expect(step).not.toMatch(/\[ -w "\$NPM_PREFIX" \]/);
      const h = host();
      const prefix = join(h.home, ".npm-global");
      const lib = join(prefix, "lib");
      mkdirSync(lib, { recursive: true });
      chmodSync(lib, 0o555);
      try {
        expect(runBlock(h, prefix, mutant).sudo).toBe("");
      } finally {
        chmodSync(lib, 0o755);
      }
    });
  });
});
