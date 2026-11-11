/** Execute the whole piped installer with hostile stdin-reading package children; no real package manager or CLI. */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "../install.sh"), "utf8");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function run(o: { manager?: string; installer?: boolean; version?: "broken" | "empty" | "missing"; script?: string; nvm?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "agend-stdin-3633-")); dirs.push(d);
  const bin = join(d, "bin"), home = join(d, "home"); mkdirSync(bin); mkdirSync(home);
  for (const name of ["cat", "bash", "uname", "grep", "sed", "cut", "id", "dirname", "mkdir", "readlink", "rm", "env"])
    symlinkSync(`/usr/bin/${name}`, join(bin, name));
  const exe = (name: string, code: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${code}\n`); chmodSync(join(bin, name), 0o755); };
  // Every child deliberately tries to consume the rest of the script. Only /dev/null is safe.
  const drain = `input=$(/bin/cat); if [ -n "$input" ]; then echo "STOLEN:$input" >> "$RIG/log"; fi`;
  exe("sudo", `${drain}\nexec "$@"`);
  const tmux = `printf '#!/bin/sh\\necho tmux-test\\n' > "$RIG/bin/tmux"; /bin/chmod +x "$RIG/bin/tmux"`;
  exe(o.manager ?? "apt-get", `${drain}\necho "package $* frontend=\${DEBIAN_FRONTEND:-unset} brew=\${NONINTERACTIVE:-unset}" >> "$RIG/log"\ncase " $* " in *' tmux '*) ${tmux};; esac`);
  const agend = o.version === "broken" ? "exit 42" : o.version === "empty" ? "exit 0" : "echo 2.3.5-test";
  exe("npm", `${drain}
echo "npm $*" >> "$RIG/log"
case "$1" in
 config|prefix) echo "$RIG/prefix";;
 list) exit 1;;
 view) echo '${o.installer ? '{"agend-install":"launcher/agend-install.cjs"}' : '{"agend":"launcher/agend"}'}';;
 exec|install) ${o.version === "missing" ? "true" : `printf '#!/bin/sh\\n${agend}\\n' > "$RIG/bin/agend"; /bin/chmod +x "$RIG/bin/agend"`};;
 *) exit 9;;
esac`);
  if (o.nvm) {
    // The downloaded nvm script, sourced library and nvm commands also attempt reads.
    exe("curl", `${drain}\n/bin/cat "$RIG/nvm-install"`);
    writeFileSync(join(d, "nvm-install"), `${drain}\n/bin/mkdir -p "$HOME/.nvm"\n/bin/cp "$RIG/nvm-lib" "$HOME/.nvm/nvm.sh"`);
    writeFileSync(join(d, "nvm-lib"), `${drain}\nnvm() { ${drain}; /bin/ln -sf "$REAL_NODE" "$RIG/bin/node"; }\n`);
  } else symlinkSync(process.execPath, join(bin, "node"));
  const result = spawnSync("/bin/bash", [], {
    input: o.script ?? source, encoding: "utf8", timeout: 10000,
    env: { HOME: home, PATH: bin, RIG: d, REAL_NODE: process.execPath, AGEND_HOME: join(home, ".agend"), AGEND_NO_COMPLETION: "1", LANG: "C" },
  });
  return { ...result, log: existsSync(join(d, "log")) ? readFileSync(join(d, "log"), "utf8") : "" };
}
describe("#3633 piped bootstrap keeps child stdin separate and verifies the PATH command", () => {
  it.each(["apt-get", "dnf", "pacman", "brew"])("%s cannot consume the remaining installer, including build tools", manager => {
    const r = run({ manager });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.log).not.toContain("STOLEN");
    expect(r.stdout).toContain("Installation Complete");
    expect(r.stdout).toContain("AgEnD 2.3.5-test installed");
    if (manager === "brew") expect(r.log).toContain("brew=1");
    if (manager === "apt-get") {
      expect(r.log).toContain("package install -y -qq tmux frontend=noninteractive");
      expect(r.log).toContain("package install -y build-essential python3 frontend=noninteractive");
    }
  });
  it("npm exec and its installer children get EOF too", () => {
    const r = run({ installer: true });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.log).toContain("npm exec");
    expect(r.log).not.toContain("STOLEN");
    expect(r.stdout).toContain("Installation Complete");
  });
  it("nvm download, source and install get EOF without losing the parent script", () => {
    const r = run({ nvm: true });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.log).not.toContain("STOLEN");
    expect(r.stdout).toContain("Installation Complete");
  });
  it.each(["broken", "empty", "missing"] as const)("an installed command that is %s fails before the success banner", version => {
    const r = run({ version });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).not.toContain("Installation Complete");
    expect(r.stdout).toContain(version === "missing"
      ? "Installation finished, but `agend` is not on PATH."
      : "Installation finished, but agend --version could not run from your PATH.");
  });
});
