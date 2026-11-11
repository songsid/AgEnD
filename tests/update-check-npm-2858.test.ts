/**
 * M-2858 follow-up (alpha.13 rehearsal): the fleet's update check — the "update available" notice and the web Update
 * offer — ran a plain `npm view` from PATH. On an install whose npm is not on the service's PATH (only ~/.volta/bin/npm,
 * the Mac Hub pilot's shape), nothing was ever offered and web Update answered 409 nothing_to_install. It now looks in
 * the environment npmEnvForUpdate proves (the same resolver `agend update` uses, #3605): the npm that manages this install.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { defaultDispatchDeps, noNpmReason, npmEnvForUpdate, type DispatchDeps } from "../src/update-dispatch.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A global install in a custom prefix (no npm in it), a node-only runtime, and an npm in ~/.volta/bin that manages it. */
function world(o: { volta?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-2858c-")); dirs.push(root);
  const home = join(root, "home"), prefix = join(home, ".npm-global"), pkg = join(prefix, "lib", "node_modules", "@songsid", "agend");
  const runtime = join(root, "runtime", "bin"), volta = join(home, ".volta", "bin");
  for (const d of [join(pkg, "dist"), join(prefix, "bin"), runtime, volta]) mkdirSync(d, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.3.5", bin: { agend: "dist/cli.js" } }));
  writeFileSync(join(pkg, "dist", "cli.js"), "");
  symlinkSync(join(pkg, "dist", "cli.js"), join(prefix, "bin", "agend"));
  copyFileSync(realpathSync(process.execPath), join(runtime, "node")); chmodSync(join(runtime, "node"), 0o755);
  if (o.volta !== false) {
    writeFileSync(join(volta, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/npm-calls.log'
case "$1 $2" in
  "root -g") echo '${join(prefix, "lib", "node_modules")}';;
  "prefix -g") echo '${prefix}';;
  "view @songsid/agend") echo 2.4.0;;
  "view @songsid/agend@alpha") echo 2.4.0-alpha.3;;
  *) exit 1;;
esac
`);
    chmodSync(join(volta, "npm"), 0o755);
  }
  // Only this world's files count as executables (the host's own npm must not answer for it).
  const deps: DispatchDeps = { ...defaultDispatchDeps, packageDir: pkg, homeDir: home, execPath: join(runtime, "node"),
    isExecutable: async path => path.startsWith(root) && defaultDispatchDeps.isExecutable!(path) };
  return { root, home, prefix, pkg, runtime, volta, deps, calls: () => { try { return readFileSync(join(root, "npm-calls.log"), "utf8").trim().split("\n"); } catch { return []; } } };
}

/** lookUpUpdateTarget as the fleet runs it, with the service's PATH = Node only (no npm anywhere on it). */
async function lookUp(w: ReturnType<typeof world>, version: string) {
  const fm = new FleetManager(w.root) as unknown as { updateNpmProbe?: unknown; lookUpUpdateTarget(v: string): Promise<{ target: string; fromChannel: boolean }> };
  fm.updateNpmProbe = { deps: w.deps };
  const saved = process.env.PATH;
  process.env.PATH = `${w.runtime}:/usr/bin:/bin`;
  try { return await fm.lookUpUpdateTarget(version); } finally { process.env.PATH = saved; }
}

describe.skipIf(process.platform === "win32")("M-2858: the update check finds the npm that manages this install", () => {
  it("only ~/.volta/bin/npm (not on the service's PATH): the check asks it, and an update is found", async () => {
    const w = world();
    expect(await lookUp(w, "2.3.5")).toEqual({ target: "2.4.0", fromChannel: false });
    expect(w.calls()).toEqual(expect.arrayContaining(["root -g", "prefix -g", "view @songsid/agend version"]));
  });
  it("an alpha install asks its channel too, through the same npm", async () => {
    const w = world();
    const r = await lookUp(w, "2.4.0-alpha.1");                                          // same core as @latest: the channel's own
    expect(r).toEqual({ target: "2.4.0-alpha.3", fromChannel: true });
    expect(w.calls()).toContain("view @songsid/agend@alpha version");
  });
  it("no npm anywhere: the check fails with the plain reason (what to do), never a guess", async () => {
    const w = world({ volta: false });
    await expect(lookUp(w, "2.3.5")).rejects.toThrow(noNpmReason(w.prefix));
  });
  it("npm already on PATH: the environment is the same object — nothing else is asked", async () => {
    const w = world();
    const env = { PATH: `${w.volta}:/usr/bin` };
    const r = await npmEnvForUpdate(w.deps, env);
    expect(r).toEqual({ ok: true, env });
    expect(r.ok && r.env).toBe(env);
    expect(w.calls()).toEqual([]);
  });
  it("one resolver: the fleet's check takes npmEnvForUpdate, which is npmForUpdate's proof", () => {
    const fm = readFileSync(join(import.meta.dirname, "..", "src", "fleet-manager.ts"), "utf8");
    const look = fm.slice(fm.indexOf("private async lookUpUpdateTarget("), fm.indexOf("private async checkForUpdates("));
    expect(look).toMatch(/await npmEnvForUpdate\(/);
    expect(look).toMatch(/execFileP\("npm", \["view", spec, "version"\], \{ timeout: 15_000, env: npmEnv\.env \}\)/);
    const dispatch = readFileSync(join(import.meta.dirname, "..", "src", "update-dispatch.ts"), "utf8");
    expect(dispatch).toMatch(/export async function npmEnvForUpdate[\s\S]*?const found = await npmForUpdate\(deps, env\.PATH \?\? ""\);/);
  });
});
