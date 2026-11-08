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
import { defaultDispatchDeps, DELAYED_UPDATE_SCRIPT_NPM, resolveInstalledAgend, updateCommand } from "../src/update-dispatch.js";
import { defaultUpdateLaunchDeps, resolveUpdateLaunch } from "../src/update-launch.js";

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

  it("no npm of its own, but its own Node: PATH's npm on that Node installs into it — accepted, as the update will run it", async () => {
    const h = host();
    rmSync(join(h.nvm, "bin", "npm"));
    vi.stubEnv("PATH", `${join(h.sys, "bin")}:/usr/bin:/bin`);
    expect(await resolveInstalledAgend(h.deps)).toEqual({ ok: true, agend: join(h.nvm, "bin", "agend"), version: "2.3.5-beta.1" });
  });

  it("no npm here manages the running install: refused in plain words, naming the root it expected", async () => {
    const h = host();
    rmSync(join(h.nvm, "bin", "npm")); rmSync(join(h.nvm, "bin", "node"));      // neither npm nor Node of its own
    vi.stubEnv("PATH", `${join(h.sys, "bin")}:/usr/bin:/bin`);
    const r = await resolveInstalledAgend(h.deps);
    expect(r.ok).toBe(false);
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain(`no npm here manages the running AgEnD: expected the npm whose global root is ${join(h.nvm, "lib", "node_modules")}`);
    expect(reason).toContain(`${join(h.sys, "bin", "npm")} (PATH's) → ${join(h.sys, "lib", "node_modules")}`);
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
    expect(await resolveInstalledAgend(deps)).toEqual({ ok: true, agend: join(custom, "bin", "agend"), version: "2.3.5-beta.1", npmDir: join(node, "bin") });
  });

  it("a candidate answering through a symlink (an nvm `current` link, /usr/local → elsewhere) counts by its real root; another real root does not", async () => {
    const h = host();
    const viaLink = join(h.t, "current"); symlinkSync(h.nvm, viaLink);              // npm reports the link path
    const npmSays = (root: string, prefix: string) =>
      writeFileSync(join(h.nvm, "bin", "npm"), `#!/bin/sh\ncase "$1" in root) echo "${root}" ;; prefix) echo "${prefix}" ;; esac\n`);
    vi.stubEnv("PATH", `${join(h.sys, "bin")}:/usr/bin:/bin`);
    npmSays(join(viaLink, "lib", "node_modules"), viaLink);
    expect(await resolveInstalledAgend(h.deps)).toEqual({ ok: true, agend: join(viaLink, "bin", "agend"), version: "2.3.5-beta.1" });
    const sysLink = join(h.t, "syslink"); symlinkSync(h.sys, sysLink);              // a link to a DIFFERENT real root
    npmSays(join(sysLink, "lib", "node_modules"), sysLink);
    const r = await resolveInstalledAgend(h.deps);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain(`${join(h.nvm, "bin", "npm")} → ${join(h.sys, "lib", "node_modules")}`);
  });

  it("#3443 review P2-1: a custom prefix with no npm of its own, resolve → launch: the updater's npm IS the proved one", async () => {
    const h = host();
    const custom = join(h.t, "home", ".npm-global");
    mkdirSync(join(custom, "bin"), { recursive: true }); mkdirSync(join(custom, "lib", "node_modules", "@songsid"), { recursive: true });
    execFileSync("cp", ["-a", join(h.nvm, "lib", "node_modules", "@songsid", "agend"), join(custom, "lib", "node_modules", "@songsid")]);
    symlinkSync(join("..", "lib", "node_modules", "@songsid", "agend", "launcher", "agend"), join(custom, "bin", "agend"));
    const node = prefix(join(h.t, "opt", "node"));
    writeFileSync(join(node, "bin", "npm"), `#!/bin/sh\ncase "$1" in root) echo "${join(custom, "lib", "node_modules")}" ;; prefix) echo "${custom}" ;; esac\n`);
    const decoyPath = `${join(h.sys, "bin")}:/usr/bin:/bin`;
    vi.stubEnv("PATH", decoyPath);
    const installed = await resolveInstalledAgend({ ...defaultDispatchDeps, packageDir: join(custom, "lib", "node_modules", "@songsid", "agend"), execPath: join(node, "bin", "node") });
    expect(installed).toMatchObject({ ok: true, agend: join(custom, "bin", "agend"), npmDir: join(node, "bin") });
    // The installed agend (its launcher) as the updater: what npm it finds, and where that npm installs.
    const out = join(h.t, "seen");
    writeFileSync(join(custom, "lib", "node_modules", "@songsid", "agend", "launcher", "agend"), `#!/bin/sh\n{ command -v npm; npm root -g; } > ${out}\n`);
    const ok = installed as { agend: string; npmDir: string };
    const { command, args } = updateCommand(ok.agend, ok.npmDir);
    execFileSync(command, args.map(a => a === DELAYED_UPDATE_SCRIPT_NPM ? a.replace("sleep 2", "true") : a), { env: { PATH: decoyPath } });
    expect(execFileSync("cat", [out], { encoding: "utf8" }).trim().split("\n")).toEqual([join(node, "bin", "npm"), join(custom, "lib", "node_modules")]);
    // The service path: systemd-run --scope carries the same argv, npm directory included.
    const launch = await resolveUpdateLaunch(ok.agend, { ...defaultUpdateLaunchDeps, platform: "linux", uid: () => 1000,
      cgroup: async () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/com.agend.fleet.service\n",
      version: async () => "systemd 255 (255.4-1)", nonce: () => "a".repeat(32) }, ok.npmDir);
    expect(launch.ok && launch.command === "systemd-run" && launch.args.slice(-6)).toEqual(["sh", "-c", DELAYED_UPDATE_SCRIPT_NPM, "sh", ok.agend, ok.npmDir]);
  });

  it("the proving npm comes before the install's own bin on the updater's PATH, when that bin holds an npm for another root", async () => {
    const h = host();
    writeFileSync(join(h.nvm, "bin", "npm"), `#!/bin/sh\ncase "$1" in root) echo "${join(h.sys, "lib", "node_modules")}" ;; prefix) echo "${h.sys}" ;; esac\n`);
    const good = join(h.t, "good", "bin"); mkdirSync(good, { recursive: true });   // PATH's npm: manages the running root
    writeFileSync(join(good, "npm"), `#!/bin/sh\ncase "$1" in root) echo "${join(h.nvm, "lib", "node_modules")}" ;; prefix) echo "${h.nvm}" ;; esac\n`); chmodSync(join(good, "npm"), 0o755);
    const empty = join(h.t, "empty", "bin"); mkdirSync(empty, { recursive: true });   // first on PATH, holds no npm
    vi.stubEnv("PATH", `${empty}:${good}:/usr/bin:/bin`);
    const installed = await resolveInstalledAgend(h.deps) as { ok: boolean; agend: string; npmDir: string };
    expect(installed).toMatchObject({ ok: true, agend: join(h.nvm, "bin", "agend"), npmDir: good });
    const out = join(h.t, "seen");
    writeFileSync(join(h.pkg, "launcher", "agend"), `#!/bin/sh\ncommand -v npm > ${out}\n`);
    const { command, args } = updateCommand(installed.agend, installed.npmDir);
    execFileSync(command, args.map(a => a === DELAYED_UPDATE_SCRIPT_NPM ? a.replace("sleep 2", "true") : a), { env: { PATH: `${join(h.sys, "bin")}:/usr/bin:/bin` } });
    expect(execFileSync("cat", [out], { encoding: "utf8" }).trim()).toBe(join(good, "npm"));
  });

  it("#3443 review (PATH interpreter): PATH's npm proves the install on the install's own Node — the launch keeps that pairing", async () => {
    const h = host();
    rmSync(join(h.nvm, "bin", "npm"));                                   // A/bin: AgEnD and Node A, no npm
    const B = prefix(join(h.t, "B"));                                    // B/bin: npm B and Node B
    const path = `${join(h.nvm, "bin")}:${join(B, "bin")}:/usr/bin:/bin`;
    vi.stubEnv("PATH", path);
    const installed = await resolveInstalledAgend(h.deps) as { ok: boolean; agend: string; npmDir?: string };
    expect(installed).toEqual({ ok: true, agend: join(h.nvm, "bin", "agend"), version: "2.3.5-beta.1" });   // no npmDir: B/bin is NOT put first
    const out = join(h.t, "seen");
    writeFileSync(join(h.pkg, "launcher", "agend"), `#!/bin/sh\n{ command -v npm; npm root -g; } > ${out}\n`);
    const { command, args } = updateCommand(installed.agend, installed.npmDir);
    execFileSync(command, args.map(a => a.startsWith("sleep 2") ? a.replace("sleep 2", "true") : a), { env: { PATH: path } });
    expect(execFileSync("cat", [out], { encoding: "utf8" }).trim().split("\n")).toEqual([join(B, "bin", "npm"), join(h.nvm, "lib", "node_modules")]);
  });

  it("#3443 review (symlinked prefix): proved again in the launch PATH of the prefix npm reports; a decoy npm in that bin is not run", async () => {
    const h = host();
    const store = h.nvm;                                                 // the real files: STORE/lib/node_modules/@songsid/agend
    rmSync(join(store, "bin", "npm"));                                   // STORE/bin (the guessed bin) holds no npm
    const P = join(h.t, "P"); mkdirSync(join(P, "bin"), { recursive: true }); mkdirSync(join(P, "lib"));
    symlinkSync(join(store, "lib", "node_modules"), join(P, "lib", "node_modules"));
    symlinkSync(join("..", "lib", "node_modules", "@songsid", "agend", "launcher", "agend"), join(P, "bin", "agend"));
    writeFileSync(join(P, "bin", "npm"), `#!/bin/sh\ncase "$1" in root) echo "${join(h.sys, "lib", "node_modules")}" ;; prefix) echo "${h.sys}" ;; esac\n`); chmodSync(join(P, "bin", "npm"), 0o755);
    const good = join(h.t, "good", "bin"); mkdirSync(good, { recursive: true });
    writeFileSync(join(good, "npm"), `#!/bin/sh\ncase "$1" in root) echo "${join(P, "lib", "node_modules")}" ;; prefix) echo "${P}" ;; esac\n`); chmodSync(join(good, "npm"), 0o755);
    const path = `${good}:/usr/bin:/bin`;
    vi.stubEnv("PATH", path);
    const installed = await resolveInstalledAgend({ ...h.deps, packageDir: join(P, "lib", "node_modules", "@songsid", "agend") }) as { ok: boolean; agend: string; npmDir?: string };
    expect(installed).toMatchObject({ ok: true, agend: join(P, "bin", "agend"), npmDir: good });
    const out = join(h.t, "seen");
    writeFileSync(join(h.pkg, "launcher", "agend"), `#!/bin/sh\ncommand -v npm > ${out}\n`);
    const { command, args } = updateCommand(installed.agend, installed.npmDir);
    execFileSync(command, args.map(a => a.startsWith("sleep 2") ? a.replace("sleep 2", "true") : a), { env: { PATH: path } });
    expect(execFileSync("cat", [out], { encoding: "utf8" }).trim()).toBe(join(good, "npm"));
  });

  it("#3443 review P2-2: the running package's location cannot be read → refused, never another install found through PATH", async () => {
    const h = host();
    const other = prefix(join(h.t, "other"), { agend: true });          // a second, otherwise valid AgEnD under PATH's npm
    vi.stubEnv("PATH", `${join(other, "bin")}:/usr/bin:/bin`);
    const unreadable = { ...h.deps, realpath: async (p: string) => {
      if (p === h.pkg) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return defaultDispatchDeps.realpath(p);
    } };
    expect(await resolveInstalledAgend(unreadable)).toEqual({ ok: false, reason: `cannot read where the running AgEnD is installed (${h.pkg}: EACCES), so it cannot tell which install to update` });
    // ...while a readable source checkout still takes PATH's npm (the control below).
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
