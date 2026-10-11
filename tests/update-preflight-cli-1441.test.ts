/**
 * #1441 part B through the built CLI: a cross-minor beta update (2.2.0-beta.2 → @beta 2.3.0-beta.1) decides whether the
 * target can run on the Node it will run on BEFORE it touches anything. `npm`, `node` (its version only), `systemctl`
 * and `launchctl` on PATH are stubs; npm's prefix is a scratch directory — nothing real is installed or restarted.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeBusctl } from "./support/fake-busctl.js";
import { runtimePlatform } from "../src/update-preflight.js";

const cli = join(process.cwd(), "dist", "cli.js");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ENGINES = "^22.14.0 || ^23.6.0 || >=24";
const HOST = runtimePlatform.hostPlatform().id;

interface Case {
  /** The `npm view … --json` answer for the target, or null: the lookup fails. */
  manifest: Record<string, unknown> | null;
  /** The version the `node` on PATH reports. */
  pathNode: string;
  /** A chat-started /update: the fleet wrote the progress marker before spawning `agend update`. */
  chat?: boolean;
  /** The npm prefix is not writable: nvm's npm installs, on the Node 22 nvm selects (this version, and its npm's answer). */
  nvm?: { node: string; manifest: Record<string, unknown> | null };
}

function update(c: Case) {
  const installed = "2.2.0-beta.2", next = "2.3.0-beta.1";
  const home = mkdtempSync(join(tmpdir(), "agend-preflight-cli-")); dirs.push(home);
  const agendHome = join(home, ".agend"); mkdirSync(agendHome, { recursive: true });
  const pkg = join(home, "pkg"); mkdirSync(pkg);
  for (const d of ["dist", "templates", "launcher"]) spawnSync("cp", ["-r", join(process.cwd(), d), join(pkg, d)]);
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...manifest, version: installed }));
  symlinkSync(join(process.cwd(), "node_modules"), join(pkg, "node_modules"));
  const bin = join(home, "bin"); mkdirSync(bin);
  const log = join(home, "calls.log"); writeFileSync(log, "");
  const globalPkg = join(home, "lib", "node_modules", "@songsid", "agend");
  mkdirSync(join(globalPkg, "dist"), { recursive: true });
  symlinkSync(join(process.cwd(), "node_modules"), join(globalPkg, "node_modules"));
  const installedVersion = join(home, "installed-version"); writeFileSync(installedVersion, installed);
  writeFileSync(join(globalPkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version: installed, bin: { agend: "dist/cli.js" } }));
  const viewJson = join(home, "view.json");
  if (c.manifest) writeFileSync(viewJson, JSON.stringify(c.manifest));
  writeFileSync(join(bin, "npm"), `#!/bin/sh
echo "npm $*" >> '${log}'
case "$*" in
  "view @songsid/agend@beta version") echo '${next}';;
  "view @songsid/agend@latest version") echo '2.2.0';;
  "view @songsid/agend@${next} version engines optionalDependencies --json") [ -f '${viewJson}' ] && cat '${viewJson}' && exit 0; exit 1;;
  view*) echo "$2" | sed 's/.*@//';;
  "config get prefix") echo '${c.nvm ? join(home, "read-only-prefix") : home}';;
  "root -g") echo '${join(home, "lib", "node_modules")}';;
  "prefix -g") echo '${home}';;
  "install -g "*) v=$(echo "$3" | sed 's/.*@//'); echo "$v" > '${installedVersion}'
    printf '{"name":"@songsid/agend","version":"%s","bin":{"agend":"dist/cli.js"}}' "$v" > '${join(globalPkg, "package.json")}';;
esac
exit 0
`);
  // `node` on PATH: reports the case's version to the preflight's probe; anything else runs the real node.
  writeFileSync(join(bin, "node"), `#!/bin/sh
case "$*" in *"process.versions.node + ' ' + process.execPath"*) echo "${c.pathNode} ${join(bin, "node")}"; exit 0;; esac
exec '${process.execPath}' "$@"
`);
  writeFileSync(join(globalPkg, "dist", "cli.js"), [
    "#!/usr/bin/env node", "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, 'agend ' + process.argv.slice(2).join(' ') + '\\n');`,
    `if (process.argv[2] === '--version') process.stdout.write(fs.readFileSync(${JSON.stringify(installedVersion)}, 'utf8'));`,
  ].join("\n") + "\n");
  chmodSync(join(globalPkg, "dist", "cli.js"), 0o755);
  symlinkSync(join(globalPkg, "dist", "cli.js"), join(bin, "agend"));
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "launchctl $*" >> '${log}'\nexit 0\n`);
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> '${log}'\nexit 0\n`);
  writeFileSync(join(bin, "busctl"), fakeBusctl(log, join(home, ".config", "systemd", "user", "com.agend.fleet.service")));
  for (const f of ["npm", "node", "systemctl", "launchctl", "busctl"]) chmodSync(join(bin, f), 0o755);
  if (c.nvm) {
    // A prefix this user cannot write (→ the nvm path), and an nvm whose `use 22` puts its own npm/node first on PATH.
    const ro = join(home, "read-only-prefix"); mkdirSync(ro); chmodSync(ro, 0o555);
    const nvmBin = join(home, ".nvm", "versions", "node", `v${c.nvm.node}`, "bin"); mkdirSync(nvmBin, { recursive: true });
    mkdirSync(join(home, "nvm-prefix", "lib", "node_modules"), { recursive: true });
    const nvmView = join(home, "nvm-view.json");
    if (c.nvm.manifest) writeFileSync(nvmView, JSON.stringify(c.nvm.manifest));
    writeFileSync(join(nvmBin, "npm"), `#!/bin/sh
echo "nvm-npm $*" >> '${log}'
case "$*" in
  "view @songsid/agend@${next} version engines optionalDependencies --json") [ -f '${nvmView}' ] && cat '${nvmView}' && exit 0; exit 1;;
  "prefix -g"|"config get prefix") echo '${join(home, "nvm-prefix")}';;
  "root -g") echo '${join(home, "nvm-prefix", "lib", "node_modules")}';;
esac
exit 0
`);
    writeFileSync(join(nvmBin, "node"), `#!/bin/sh
case "$*" in *"process.versions.node + ' ' + process.execPath"*) echo "${c.nvm.node} $0"; exit 0;; esac
exec '${process.execPath}' "$@"
`);
    for (const f of ["npm", "node"]) chmodSync(join(nvmBin, f), 0o755);
    writeFileSync(join(home, ".nvm", "nvm.sh"), `nvm() { case "$1" in install) echo "nvm install $2" >> '${log}'; return 0;; use) PATH='${nvmBin}':"$PATH"; export PATH;; esac; }\n`);
  }
  const marker = join(agendHome, "update-in-progress.json");
  if (c.chat) writeFileSync(marker, JSON.stringify({ startedAt: Date.now(), pid: 1, progress: { stage: "starting", target: { adapterId: "tg", chatId: "c", messageId: "m" } } }));
  const r = spawnSync(process.execPath, [join(pkg, "dist", "cli.js"), "update"], {
    env: { ...process.env, AGEND_ALLOW_TEST_FLEET_CONTROL: "1", AGEND_INSTANCE_NAME: "", HOME: home, AGEND_HOME: agendHome, PATH: `${bin}:/usr/bin:/bin`, npm_config_prefix: home },
    encoding: "utf8", timeout: 60_000,
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return {
    r, calls, out: `${r.stdout}\n${r.stderr}\n${calls.join("\n")}`,
    installs: calls.filter(x => / install -g /.test(x)),
    marker: existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null,
  };
}
const pinsFor = (id: string | null) => (id ? { [`@songsid/agend-node-${id}`]: "22.23.3" } : {});

describe("#1441 B: cross-minor beta → next beta, decided before anything is touched (built CLI)", () => {
  it("the CLI under test is built", () => { expect(existsSync(cli), "build first").toBe(true); });

  it("a target whose bundled runtime covers this host: installed from @beta (Node 16 on PATH does not matter)", { timeout: 60_000 }, () => {
    const { installs, calls, out } = update({ manifest: { version: "2.3.0-beta.1", engines: { node: ENGINES }, optionalDependencies: pinsFor(HOST) }, pathNode: "16.20.2" });
    expect(installs, out).toEqual(["npm install -g @songsid/agend@2.3.0-beta.1"]);
    expect(calls).toContain("npm view @songsid/agend@beta version");          // the channel stayed beta
    expect(calls).not.toContain("npm view @songsid/agend@latest version");
  });

  it("a target with no runtime for this host and a range the PATH Node misses: refused — no install, no marker, exit 1", { timeout: 60_000 }, () => {
    const { r, installs, marker, out } = update({ manifest: { version: "2.3.0-beta.1", engines: { node: ">=24" }, optionalDependencies: pinsFor(null) }, pathNode: "22.14.0" });
    expect(r.status, out).toBe(1);
    expect(installs, out).toEqual([]);
    expect(marker, "no update-in-progress marker: the running fleet was never told an update is underway").toBeNull();
    expect(r.stderr).toContain("cannot run on this host's Node — AgEnD was not changed");
    expect(r.stderr).toContain(`ships no bundled Node for ${HOST}`);
    expect(r.stderr).toContain("it would run on the `node` on PATH (Node 22.14.0, ");
    expect(r.stderr).toContain("Install a Node that satisfies >=24");
  });

  it("a chat-started /update gets the reason as its failed stage, and nothing else moves", { timeout: 60_000 }, () => {
    const { r, installs, marker, out } = update({ manifest: { version: "2.3.0-beta.1", engines: { node: ">=24" }, optionalDependencies: {} }, pathNode: "20.19.0", chat: true });
    expect(r.status, out).toBe(1);
    expect(installs).toEqual([]);
    expect(marker.progress.stage).toBe("failed");
    expect(marker.progress.failedStage).toBe("starting");                     // it never reached "downloading"
    expect(marker.progress.error).toMatch(/^Not updated: v2\.3\.0-beta\.1 needs Node >=24; .*Nothing was changed\.$/);
  });

  it("the registry answers for another version than the one being installed: not a verdict — installs as before", { timeout: 60_000 }, () => {
    const { installs, r, out } = update({ manifest: { version: "2.2.0", engines: { node: ">=24" }, optionalDependencies: {} }, pathNode: "20.19.0" });
    expect(installs, out).toEqual(["npm install -g @songsid/agend@2.3.0-beta.1"]);
    expect(r.stdout).toContain("requirements could not be read");
  });

  it("a range this check cannot evaluate: not a refusal — installs as before", { timeout: 60_000 }, () => {
    const { installs, r, out } = update({ manifest: { version: "2.3.0-beta.1", engines: { node: "^24.0.0-0" }, optionalDependencies: {} }, pathNode: "20.19.0" });
    expect(installs, out).toEqual(["npm install -g @songsid/agend@2.3.0-beta.1"]);
    expect(r.stdout).toContain("which this check cannot evaluate");
  });

  it("nvm path: judged on the Node 22 nvm selected with ITS npm (the parent npm's answer is not read) — refused before npm", { timeout: 60_000 }, () => {
    // The parent npm would say the target fits (^22.14.0); nvm's npm, which installs it, says >=24.
    const { r, installs, calls, marker, out } = update({
      manifest: { version: "2.3.0-beta.1", engines: { node: "^22.14.0" }, optionalDependencies: {} }, pathNode: "22.14.0",
      nvm: { node: "22.23.3", manifest: { version: "2.3.0-beta.1", engines: { node: ">=24" }, optionalDependencies: {} } },
    });
    expect(r.status, out).toBe(1);
    expect(calls).toContain("nvm install 22");
    expect(calls).toContain("nvm-npm view @songsid/agend@2.3.0-beta.1 version engines optionalDependencies --json");
    expect(calls.some(l => l.startsWith("npm view @songsid/agend@2.3.0-beta.1 version engines"))).toBe(false);
    expect(installs, out).toEqual([]);
    expect(calls.some(l => l === "nvm-npm prefix -g"), "never reached the prefix lock").toBe(false);
    expect(r.stderr).toContain("it would run on the Node 22 nvm selected (Node 22.23.3, ");
    expect(r.stderr).toContain("Not updated: v2.3.0-beta.1 needs Node >=24; ");
    expect(marker, "the marker the update wrote is cleared again").toBeNull();
  });

  it("nvm path, the reverse: nvm's npm says ^22.14.0 (the parent npm says >=24) — nvm's npm installs it", { timeout: 60_000 }, () => {
    const { installs, out } = update({
      manifest: { version: "2.3.0-beta.1", engines: { node: ">=24" }, optionalDependencies: {} }, pathNode: "20.19.0",
      nvm: { node: "22.23.3", manifest: { version: "2.3.0-beta.1", engines: { node: "^22.14.0" }, optionalDependencies: {} } },
    });
    expect(installs, out).toEqual(["nvm-npm install -g @songsid/agend@2.3.0-beta.1"]);
  });

  it("requirements that cannot be read: installs as before (the target's own install check still applies)", { timeout: 60_000 }, () => {
    const { installs, r, out } = update({ manifest: null, pathNode: "20.19.0" });
    expect(installs, out).toEqual(["npm install -g @songsid/agend@2.3.0-beta.1"]);
    expect(r.stdout).toContain("requirements could not be read");
  });
});
