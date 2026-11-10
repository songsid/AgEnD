/**
 * M-2858: `agend update` and the web Update / chat `/update` refused when no npm was on the process's PATH ("Could not
 * ask npm which prefix it installs into"), e.g. a launchd service or a runtime that ships Node alone (AgEnD's bundled Node
 * has no npm) — although the npm that installed AgEnD was on the machine. The npm is now also looked for in the usual
 * places, and used only when its global root is the running install's own (#3440's proof). With none anywhere, the
 * refusal says what to do, before anything is asked or changed.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDispatchDeps, noNpmReason, npmForUpdate, resolveInstalledAgend, updateCommand, usualNpmDirs, type DispatchDeps } from "../src/update-dispatch.js";

const HOME = "/home/u";
const PREFIX = `${HOME}/.npm-global`;                                   // a custom prefix: no npm in it
const PKG = `${PREFIX}/lib/node_modules/@songsid/agend`;
const MANIFEST = JSON.stringify({ name: "@songsid/agend", version: "2.3.5-alpha.12", bin: { agend: "dist/cli.js" } });
const MINE = { root: `${PREFIX}/lib/node_modules`, prefix: PREFIX };
const OTHER = { root: "/usr/local/lib/node_modules", prefix: "/usr/local" };
const SERVICE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";                  // launchd's default: no npm here

/** npm binaries by absolute path → their global root/prefix; bare `npm` resolves through the PATH it is given. */
function deps(npms: Record<string, { root: string; prefix: string }>, nvm: string[] = []): DispatchDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked, packageDir: PKG, homeDir: HOME, pathEnv: SERVICE_PATH,
    execPath: `${PKG}/node_modules/@songsid/agend-node-darwin-arm64/bin/node`,          // the bundled Node: no npm beside it
    listDir: async path => (path === `${HOME}/.nvm/versions/node` ? nvm : []),
    isExecutable: async path => path in npms,
    run: async (command, args, _t, env) => {
      const resolved = command === "npm" ? (env?.PATH ?? SERVICE_PATH).split(":").map(d => `${d}/npm`).find(p => p in npms) ?? "(no npm)" : command;
      asked.push(`${resolved} ${args.join(" ")}`);
      const npm = npms[resolved];
      if (!npm) return { status: null, stdout: "" };
      return { status: 0, stdout: `${args[0] === "root" ? npm.root : npm.prefix}\n` };
    },
    readFile: async path => { if (path === `${PKG}/package.json`) return MANIFEST; throw Object.assign(Error("ENOENT"), { code: "ENOENT" }); },
    realpath: async path => {
      if (path === `${PKG}/dist/cli.js` || path === `${PREFIX}/bin/agend`) return `${PKG}/dist/cli.js`;
      if ([PKG, MINE.root, OTHER.root].includes(path) || path.startsWith(`${HOME}/.nvm/`)) return path;
      throw Object.assign(Error("ENOENT"), { code: "ENOENT" });
    },
  };
}

describe.skipIf(process.platform === "win32")("M-2858: no npm on the service's PATH, but the npm that installed AgEnD is on the machine", () => {
  it("Homebrew's npm (custom prefix) is found and proved: the web Update / `/update` launch puts it first", async () => {
    const d = deps({ "/opt/homebrew/bin/npm": MINE });
    expect(await resolveInstalledAgend(d)).toEqual({ ok: true, agend: `${PREFIX}/bin/agend`, version: "2.3.5-alpha.12", npmDir: "/opt/homebrew/bin" });
    expect(updateCommand(`${PREFIX}/bin/agend`, "/opt/homebrew/bin").args).toContain("/opt/homebrew/bin");
  });
  it("`agend update` (CLI): the PATH to update with starts with that npm's directory, then the install's own bin", async () => {
    const d = deps({ "/opt/homebrew/bin/npm": MINE });
    expect(await npmForUpdate(d, SERVICE_PATH)).toEqual({ ok: true, path: `/opt/homebrew/bin:${PREFIX}/bin:${SERVICE_PATH}`, npmDir: "/opt/homebrew/bin" });
  });
  it("nvm: the newest version first (numerically: v22 before v9), and one whose root is another install is passed over", async () => {
    const v = (x: string) => `${HOME}/.nvm/versions/node/${x}/bin`;
    expect((await usualNpmDirs({ homeDir: HOME, listDir: async () => ["v9.11.2", "v22.23.1", "v24.1.0", "notes.txt"] })).slice(0, 3)).toEqual([v("v24.1.0"), v("v22.23.1"), v("v9.11.2")]);
    const d = deps({ [`${v("v24.1.0")}/npm`]: { root: `${HOME}/.nvm/versions/node/v24.1.0/lib/node_modules`, prefix: `${HOME}/.nvm/versions/node/v24.1.0` }, [`${v("v22.23.1")}/npm`]: MINE }, ["v22.23.1", "v24.1.0"]);
    expect(await npmForUpdate(d, SERVICE_PATH)).toMatchObject({ ok: true, npmDir: v("v22.23.1") });
  });
  it("an npm in a usual place that manages ANOTHER install is never used: refused, naming what it answered", async () => {
    const r = await npmForUpdate(deps({ "/usr/local/bin/npm": OTHER }), SERVICE_PATH);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("/usr/local/bin/npm (not on PATH) → /usr/local/lib/node_modules");
  });
  it("an npm already on PATH changes nothing (null: the update runs as before, nothing else is asked)", async () => {
    const d = deps({ "/usr/bin/npm": OTHER });
    expect(await npmForUpdate(d, SERVICE_PATH)).toEqual({ ok: true, path: null });
    expect(d.asked).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("M-2858: no npm anywhere — the refusal says what to do, and nothing is changed", () => {
  it("names the install, where it looked, and the two ways out; the web Update and the CLI say the same", async () => {
    const want = noNpmReason(PREFIX);
    expect(want).toMatch(/install Node\.js \(with its npm\), or add the folder that holds npm to the PATH/);
    expect(want).toMatch(/Nothing was changed\.$/);
    expect(await resolveInstalledAgend(deps({}))).toEqual({ ok: false, reason: want });
    expect(await npmForUpdate(deps({}), SERVICE_PATH)).toEqual({ ok: false, reason: want });
  });
  it("`agend update` asks it before any npm and stops there (the source order; a refusal is recorded as the update's outcome)", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const action = cli.slice(cli.indexOf('.command("update")'));
    const ask = action.indexOf("await npmForUpdate()"), firstNpm = action.search(/spawnSync\("npm"|execSync\("npm/);
    expect(ask).toBeGreaterThan(0);
    expect(firstNpm).toBeGreaterThan(ask);
    expect(action.slice(ask, firstNpm)).toMatch(/setUpdateProgressStage\(DATA_DIR, "failed", \{ error: `Not updated: \$\{found\.reason\}` \}\);\s*process\.exitCode = 1;\s*return;/);
    expect(action.slice(ask, firstNpm)).toMatch(/process\.env\.PATH = found\.path;/);
  });
});

describe.skipIf(process.platform === "win32")("M-2858: the real lookup, on a node-only runtime (real files, real shell)", () => {
  it("a PATH with Node and no npm: the npm in a usual place is proved by really running it, and the launch PATH finds it first", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2858-"));
    const home = join(root, "home"), prefix = join(home, ".npm-global"), pkg = join(prefix, "lib", "node_modules", "@songsid", "agend");
    const runtime = join(root, "runtime", "bin"), brew = join(home, ".volta", "bin");     // Node alone; npm in a usual place
    for (const d of [join(pkg, "dist"), join(prefix, "bin"), runtime, brew]) mkdirSync(d, { recursive: true });
    writeFileSync(join(pkg, "package.json"), MANIFEST); writeFileSync(join(pkg, "dist", "cli.js"), "");
    execFileSync("ln", ["-s", join(pkg, "dist", "cli.js"), join(prefix, "bin", "agend")]);
    execFileSync("ln", ["-s", process.execPath, join(runtime, "node")]);
    const fake = `#!/bin/sh\ncase "$1" in root) echo "${join(prefix, "lib", "node_modules")}";; prefix) echo "${prefix}";; *) exit 3;; esac\n`;
    writeFileSync(join(brew, "npm"), fake); chmodSync(join(brew, "npm"), 0o755);
    const path = `${runtime}:/usr/bin:/bin`;
    // Only this test's tree counts as holding an npm: a CI runner's own /usr/local/bin/npm must not answer for it.
    const mine = async (file: string) => file.startsWith(root) && await defaultDispatchDeps.isExecutable!(file);
    const before = await npmForUpdate({ ...defaultDispatchDeps, isExecutable: mine, packageDir: pkg, homeDir: join(root, "nobody"), execPath: join(runtime, "node") }, path);
    expect(before.ok).toBe(false);                                                         // nowhere to look: refused, plainly
    expect(!before.ok && before.reason).toBe(noNpmReason(prefix));
    const found = await npmForUpdate({ ...defaultDispatchDeps, isExecutable: mine, packageDir: pkg, homeDir: home, execPath: join(runtime, "node") }, path);
    expect(found).toEqual({ ok: true, path: `${brew}:${prefix}/bin:${path}`, npmDir: brew });
    // What the update then runs: bare `npm` under that PATH is the proved one.
    expect(execFileSync("sh", ["-c", "command -v npm && npm root -g"], { env: { PATH: (found as { path: string }).path }, encoding: "utf8" }).trim().split("\n"))
      .toEqual([join(brew, "npm"), join(prefix, "lib", "node_modules")]);
  });
});
