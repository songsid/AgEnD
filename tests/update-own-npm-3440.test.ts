/**
 * #3440 (field, WSL): AgEnD installed under nvm, a system /usr/bin/npm too. General's `/update` resolved npm from the
 * fleet's PATH — the system one came first — and refused: "/usr/lib/node_modules/@songsid/agend is not an installed
 * AgEnD package". The updater must use the npm that manages the RUNNING install, and run the update with it first on
 * PATH. Real processes on a scratch layout: each fake `npm` reports the prefix of the Node that runs it — the one named
 * when a Node runs it explicitly, else (its shebang) the first `node` on PATH — as real npm takes its global prefix.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDispatchDeps, resolveInstalledAgend, updateCommand } from "../src/update-dispatch.js";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NPM = `#!/bin/sh
n=\${AGEND_FAKE_NODE:-$(command -v node)} || exit 1
p=$(cd "$(dirname "$n")/.." && pwd -P)
case "$1" in root) echo "$p/lib/node_modules" ;; prefix) echo "$p" ;; *) exit 1 ;; esac
`;
function prefix(at: string, opts: { npm?: boolean; agend?: boolean } = {}): string {
  mkdirSync(join(at, "bin"), { recursive: true }); mkdirSync(join(at, "lib", "node_modules"), { recursive: true });
  // A Node that runs the script it is given (and says it is the one running it).
  writeFileSync(join(at, "bin", "node"), '#!/bin/sh\nAGEND_FAKE_NODE="$0" exec sh "$@"\n'); chmodSync(join(at, "bin", "node"), 0o755);
  if (opts.npm !== false) { writeFileSync(join(at, "bin", "npm"), NPM); chmodSync(join(at, "bin", "npm"), 0o755); }
  if (opts.agend) {
    const pkg = join(at, "lib", "node_modules", "@songsid", "agend");
    mkdirSync(join(pkg, "launcher"), { recursive: true }); mkdirSync(join(pkg, "node_modules", "@songsid", "agend-node-linux-x64", "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.3.5-beta.1", bin: { agend: "./launcher/agend" } }));
    writeFileSync(join(pkg, "launcher", "agend"), "#!/bin/sh\n"); chmodSync(join(pkg, "launcher", "agend"), 0o755);
    symlinkSync(join("..", "lib", "node_modules", "@songsid", "agend", "launcher", "agend"), join(at, "bin", "agend"));
  }
  return at;
}
/** nvm's prefix holds AgEnD; the system prefix has its own npm and node (and no AgEnD). */
function host() {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "agend-3440-"))); dirs.push(t);
  const nvm = prefix(join(t, "home", ".nvm", "versions", "node", "v22.23.1"), { agend: true });
  const sys = prefix(join(t, "usr"));
  const pkg = join(nvm, "lib", "node_modules", "@songsid", "agend");
  // AgEnD runs on its bundled Node: no npm beside process.execPath.
  const deps = { ...defaultDispatchDeps, packageDir: pkg, execPath: join(pkg, "node_modules", "@songsid", "agend-node-linux-x64", "bin", "node") };
  return { t, nvm, sys, pkg, deps };
}

describe("#3440: /update uses the npm of the running install, not the first npm on PATH", () => {
  it("a system npm first on PATH (nvm's after it): the nvm prefix's agend, with nvm's bin for the update", async () => {
    const h = host();
    vi.stubEnv("PATH", `${join(h.sys, "bin")}:${join(h.nvm, "bin")}:/usr/bin:/bin`);
    expect(await resolveInstalledAgend(h.deps)).toEqual({ ok: true, agend: join(h.nvm, "bin", "agend"), version: "2.3.5-beta.1" });
  });

  it("a minimal service PATH with no nvm on it at all: still the running install's npm", async () => {
    const h = host();
    vi.stubEnv("PATH", `${join(h.sys, "bin")}:/usr/bin:/bin`);
    expect(await resolveInstalledAgend(h.deps)).toEqual({ ok: true, agend: join(h.nvm, "bin", "agend"), version: "2.3.5-beta.1" });
  });

  it("no npm here manages the running install: refused in plain words, naming the root it expected", async () => {
    const h = host();
    rmSync(join(h.nvm, "bin", "npm"));
    vi.stubEnv("PATH", `${join(h.sys, "bin")}:/usr/bin:/bin`);
    const r = await resolveInstalledAgend(h.deps);
    expect(r.ok).toBe(false);
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain(`no npm here manages the running AgEnD: expected the npm whose global root is ${join(h.nvm, "lib", "node_modules")}`);
    expect(reason).toContain(`npm on PATH → ${join(h.sys, "lib", "node_modules")}`);
  });

  it("an npm that answers but manages another root (a custom global prefix) is not taken", async () => {
    const h = host();
    writeFileSync(join(h.nvm, "bin", "npm"), `#!/bin/sh\ncase "$1" in root) echo "${join(h.sys, "lib", "node_modules")}" ;; prefix) echo "${h.sys}" ;; esac\n`);
    vi.stubEnv("PATH", `${join(h.sys, "bin")}:/usr/bin:/bin`);
    const r = await resolveInstalledAgend(h.deps);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain(`${join(h.nvm, "bin", "npm")} → ${join(h.sys, "lib", "node_modules")}`);
  });

  it("AgEnD on a plain Node whose npm installs into a configured prefix (no npm of its own there): the npm beside that Node", async () => {
    const h = host();
    const custom = join(h.t, "home", ".npm-global");                    // `npm config set prefix ~/.npm-global`
    mkdirSync(join(custom, "bin"), { recursive: true }); mkdirSync(join(custom, "lib", "node_modules", "@songsid"), { recursive: true });
    execFileSync("cp", ["-a", join(h.nvm, "lib", "node_modules", "@songsid", "agend"), join(custom, "lib", "node_modules", "@songsid")]);
    symlinkSync(join("..", "lib", "node_modules", "@songsid", "agend", "launcher", "agend"), join(custom, "bin", "agend"));
    const node = prefix(join(h.t, "opt", "node"));                    // the plain Node AgEnD runs on, and its npm
    writeFileSync(join(node, "bin", "npm"), `#!/bin/sh\ncase "$1" in root) echo "${join(custom, "lib", "node_modules")}" ;; prefix) echo "${custom}" ;; esac\n`);
    vi.stubEnv("PATH", `${join(h.sys, "bin")}:/usr/bin:/bin`);
    const deps = { ...defaultDispatchDeps, packageDir: join(custom, "lib", "node_modules", "@songsid", "agend"), execPath: join(node, "bin", "node") };
    expect(await resolveInstalledAgend(deps)).toEqual({ ok: true, agend: join(custom, "bin", "agend"), version: "2.3.5-beta.1" });
  });

  it("the launched update runs with that npm's directory first on PATH: its npm and node are the install's", () => {
    const h = host();
    const out = join(h.t, "seen");
    const agend = join(h.nvm, "bin", "agend-probe");                 // beside the install's agend link, as the real one is
    writeFileSync(agend, `#!/bin/sh\n{ echo "args=$*"; command -v npm; command -v node; } > ${out}\n`); chmodSync(agend, 0o755);
    const { command, args } = updateCommand(agend);
    execFileSync(command, args, { env: { PATH: `${join(h.sys, "bin")}:/usr/bin:/bin` } });
    expect(execFileSync("cat", [out], { encoding: "utf8" }).trim().split("\n")).toEqual(["args=update", join(h.nvm, "bin", "npm"), join(h.nvm, "bin", "node")]);
  });

  it("a source checkout (not a global install) keeps the old rule: PATH's npm decides", async () => {
    const h = host();
    const checkout = join(h.t, "checkout"); mkdirSync(checkout);
    vi.stubEnv("PATH", `${join(h.nvm, "bin")}:/usr/bin:/bin`);
    expect(await resolveInstalledAgend({ ...h.deps, packageDir: checkout })).toEqual({ ok: true, agend: join(h.nvm, "bin", "agend"), version: "2.3.5-beta.1" });
  });
});
