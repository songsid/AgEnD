/**
 * #2337: install.sh Step 3 (tmux) hardcodes `sudo` for apt, so as root in a
 * minimal image with no sudo binary the tmux install fails. Use $SUDO (empty
 * as root; "sudo" when the user has it). Non-root without sudo gets a clear
 * error asking them to install tmux. Stubbed package managers; no live apt.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const script = readFileSync(join(REPO, "install.sh"), "utf8");
const step = /# >>> tmux install[^\n]*\n([\s\S]*?)# <<< tmux install/.exec(script)?.[1] ?? "";
const sudoInit = /# Default SUDO[^\n]*\n(?:if \[ "\$\(id -u\)" -eq 0 \]; then\n  SUDO=""\nelse\n  SUDO="sudo"\nfi\n)/.exec(script)?.[0] ?? "";
const helpers = [
  "GREEN=''; YELLOW=''; RED=''; DIM=''; BOLD=''; NC=''",
  "TOTAL=5",
  "info()  { echo \"info $1\"; }",
  "warn()  { echo \"warn $1\"; }",
  "error() { echo \"error $1\"; exit 1; }",
  "step()  { echo \"step $1 $2\"; }",
  "command_exists() { command -v \"$1\" >/dev/null 2>&1; }",
].join("\n");

const OLD_APT = "sudo apt-get update -qq && sudo apt-get install -y -qq tmux";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function host() {
  const d = mkdtempSync(join(tmpdir(), "agend-2337-"));
  dirs.push(d);
  const bin = join(d, "bin");
  mkdirSync(bin);
  const pkgLog = join(d, "pkg.log");
  const sudoLog = join(d, "sudo.log");
  writeFileSync(join(bin, "id"), `#!/bin/sh
if [ "$1" = "-u" ]; then
  printf '%s\\n' "\${STUB_UID:-0}"
  exit 0
fi
echo "unexpected id $*" >&2
exit 9
`);
  chmodSync(join(bin, "id"), 0o755);
  const installTmux = `/bin/cat > ${JSON.stringify(join(bin, "tmux"))} << 'EOF'
#!/bin/sh
echo "tmux 3.3a"
EOF
/bin/chmod 755 ${JSON.stringify(join(bin, "tmux"))}
`;
  writeFileSync(join(bin, "apt-get"), `#!/bin/sh
printf 'apt-get %s\\n' "$*" >> ${JSON.stringify(pkgLog)}
case " $* " in
  *" tmux "*) ${installTmux} ;;
esac
exit 0
`);
  chmodSync(join(bin, "apt-get"), 0o755);
  writeFileSync(join(bin, "dnf"), `#!/bin/sh
printf 'dnf %s\\n' "$*" >> ${JSON.stringify(pkgLog)}
case " $* " in
  *" tmux "*) ${installTmux} ;;
esac
exit 0
`);
  chmodSync(join(bin, "dnf"), 0o755);
  writeFileSync(join(bin, "sudo"), `#!/bin/sh
printf 'sudo %s\\n' "$*" >> ${JSON.stringify(sudoLog)}
exec "$@"
`);
  chmodSync(join(bin, "sudo"), 0o755);
  return { d, bin, pkgLog, sudoLog };
}

function runBlock(
  h: ReturnType<typeof host>,
  opts: { uid: string; pkg: string; withSudo: boolean; block?: string },
) {
  // PATH is only the stub bin: the host's tmux/sudo/apt-get must not leak in.
  const sudoPath = join(h.bin, "sudo");
  const sudoHid = join(h.d, "sudo.hidden");
  if (!opts.withSudo && existsSync(sudoPath)) {
    writeFileSync(sudoHid, readFileSync(sudoPath));
    chmodSync(sudoHid, 0o755);
    rmSync(sudoPath);
  }
  const r = spawnSync("/bin/bash", ["-c", `set -euo pipefail
${helpers}
${sudoInit}
PKG_MGR=${JSON.stringify(opts.pkg)}
${opts.block ?? step}
`], {
    encoding: "utf8",
    env: {
      PATH: h.bin,
      HOME: join(h.d, "home"),
      STUB_UID: opts.uid,
    },
  });
  if (!opts.withSudo && existsSync(sudoHid)) {
    writeFileSync(sudoPath, readFileSync(sudoHid));
    chmodSync(sudoPath, 0o755);
  }
  return r;
}

function pkgLog(h: ReturnType<typeof host>) {
  return existsSync(h.pkgLog) ? readFileSync(h.pkgLog, "utf8") : "";
}
function sudoLog(h: ReturnType<typeof host>) {
  return existsSync(h.sudoLog) ? readFileSync(h.sudoLog, "utf8") : "";
}

describe("#2337 install.sh: tmux install uses $SUDO, not a hardcoded sudo", () => {
  it("the marked block is install.sh's tmux step; $SUDO is defined before it; the website copy is identical", () => {
    expect(step).toMatch(/Checking tmux/);
    expect(sudoInit).toMatch(/SUDO=""/);
    expect(script.indexOf(sudoInit)).toBeGreaterThanOrEqual(0);
    expect(script.indexOf(sudoInit)).toBeLessThan(script.indexOf(step));
    expect(readFileSync(join(REPO, "website", "public", "install.sh"), "utf8")).toBe(script);
  });

  it("root without a sudo binary: apt-get runs directly and tmux is installed", () => {
    const h = host();
    const r = runBlock(h, { uid: "0", pkg: "apt", withSudo: false });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(pkgLog(h)).toMatch(/apt-get update/);
    expect(pkgLog(h)).toMatch(/apt-get install .*tmux/);
    expect(sudoLog(h)).toBe("");
    expect(r.stdout).toMatch(/tmux 3\.3a installed/);
    expect(existsSync(join(h.bin, "tmux"))).toBe(true);
  });

  it("non-root with sudo: apt-get is invoked through sudo", () => {
    const h = host();
    const r = runBlock(h, { uid: "1000", pkg: "apt", withSudo: true });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(sudoLog(h)).toMatch(/sudo apt-get update/);
    expect(sudoLog(h)).toMatch(/sudo apt-get install .*tmux/);
    expect(r.stdout).toMatch(/tmux 3\.3a installed/);
  });

  it("non-root without sudo: a clear error to install tmux; apt-get is not run", () => {
    const h = host();
    const r = runBlock(h, { uid: "1000", pkg: "apt", withSudo: false });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/install tmux/i);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/sudo is not available/);
    expect(pkgLog(h)).toBe("");
    expect(existsSync(join(h.bin, "tmux"))).toBe(false);
  });

  it("root without sudo, dnf: dnf runs directly (same $SUDO logic)", () => {
    const h = host();
    const r = runBlock(h, { uid: "0", pkg: "dnf", withSudo: false });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(pkgLog(h)).toMatch(/dnf install -y tmux/);
    expect(sudoLog(h)).toBe("");
  });

  describe("mutation: the hardcoded sudo apt-get line", () => {
    it("still fails as root when sudo is not on PATH (the defect)", () => {
      const mutant = step.replace(
        /\$SUDO apt-get update -qq && \$SUDO apt-get install -y -qq tmux/,
        OLD_APT,
      );
      expect(mutant).not.toBe(step);
      const h = host();
      const r = runBlock(h, { uid: "0", pkg: "apt", withSudo: false, block: mutant });
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toMatch(/sudo/i);
      expect(existsSync(join(h.bin, "tmux"))).toBe(false);
    });

    it("the live apt/dnf/pacman lines use $SUDO, not a bare sudo", () => {
      expect(step).toMatch(/\$SUDO apt-get update/);
      expect(step).toMatch(/\$SUDO apt-get install/);
      expect(step).toMatch(/\$SUDO dnf install/);
      expect(step).toMatch(/\$SUDO pacman /);
      expect(step).not.toMatch(/(?:^|[^\w$])sudo apt-get/m);
      expect(step).not.toMatch(/(?:^|[^\w$])sudo dnf/m);
      expect(step).not.toMatch(/(?:^|[^\w$])sudo pacman/m);
    });
  });
});
