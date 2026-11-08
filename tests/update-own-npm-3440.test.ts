/**
 * #3440 (field, WSL): AgEnD installed under nvm, a system /usr/bin/npm too. General's `/update` resolved npm from the
 * fleet's PATH — the system one came first — and refused: "/usr/lib/node_modules/@songsid/agend is not an installed
 * AgEnD package". The updater must use the npm that manages the RUNNING install, and run the update with it first on
 * PATH. Real processes on a scratch layout: each fake `npm` reports the prefix of whichever `node` it finds first on
 * PATH — as real npm takes its global prefix from the Node that runs it.
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
n=$(command -v node) || exit 1
p=$(cd "$(dirname "$n")/.." && pwd -P)
case "$1" in root) echo "$p/lib/node_modules" ;; prefix) echo "$p" ;; *) exit 1 ;; esac
`;
function prefix(at: string, opts: { npm?: boolean; agend?: boolean } = {}): string {
  mkdirSync(join(at, "bin"), { recursive: true }); mkdirSync(join(at, "lib", "node_modules"), { recursive: true });
  writeFileSync(join(at, "bin", "node"), "#!/bin/sh\n"); chmodSync(join(at, "bin", "node"), 0o755);
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
    expect(await resolveInstalledAgend(h.deps)).toEqual({ ok: true, agend: join(h.nvm, "bin", "agend"), version: "2.3.5-beta.1", binDir: join(h.nvm, "bin") });
  });

  it("a minimal service PATH with no nvm on it at all: still the running install's npm", async () => {
    const h = host();
    vi.stubEnv("PATH", `${join(h.sys, "bin")}:/usr/bin:/bin`);
    expect(await resolveInstalledAgend(h.deps)).toMatchObject({ ok: true, agend: join(h.nvm, "bin", "agend"), binDir: join(h.nvm, "bin") });
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

  it("the launched update runs with that npm's directory first on PATH: its npm and node are the install's", () => {
    const h = host();
    const out = join(h.t, "seen");
    const agend = join(h.t, "fake-agend");
    writeFileSync(agend, `#!/bin/sh\n{ echo "args=$*"; command -v npm; command -v node; } > ${out}\n`); chmodSync(agend, 0o755);
    const { command, args } = updateCommand(agend, join(h.nvm, "bin"));
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
