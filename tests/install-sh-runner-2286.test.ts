/**
 * #2286 HOTFIX: install.sh's installer step for a target from before the installer (#2264) — the default `latest` while
 * that is 2.2.6, a version pinned, an older tag. #2286 had it borrow the newest installer (latest, else beta) with
 * --spec. But that installer holds the install lock while it installs, and a release from before #2264 refuses that in
 * its own postinstall unless the install presents the lock's token, which beta.18's installer does not: the default
 * install of 2.2.6 failed. So such a target gets the plain `npm install -g` again (it still fails ENOTEMPTY on what an
 * interrupted install left), until a release whose installer presents the token is both latest and beta.
 *
 * The step runs exactly as install.sh has it (the marked block, its helpers, `set -euo pipefail`) with a stub npm. The
 * stub's `exec` runs the REAL launcher/agend-install.cjs; its `install -g` fails ENOTEMPTY while a retired `.agend-*`
 * copy is in the way — what npm does — and otherwise writes the package and its bin.
 *
 * Prism r1: a release from before #2264 also refuses, in its own postinstall, every install into a prefix whose install
 * lock is live unless it presents that lock's token — and the installer holds that lock while it installs. So the last
 * block puts such a release behind REAL npm: a local tarball whose postinstall runs v2.3.0-beta.16's install-admission
 * (tests/fixtures, verbatim). npm is offline there (a tarball with no dependencies); the stub only answers view/root/
 * prefix and maps the version to the tarball.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const script = readFileSync(join(REPO, "install.sh"), "utf8");
const step = /# >>> agend-installer step[^\n]*\n([\s\S]*?)# <<< agend-installer step/.exec(script)?.[1] ?? "";
const helpers = script.split("\n").filter(l => /^(?:RED|GREEN|YELLOW|NC)=|^(?:info|warn|error)\(\)/.test(l)).join("\n");
const dirs: string[] = [];
/**
 * A `ps` that shows only the caller's own ancestors (as in agend-install-2264.test.ts): the installer repairs only while
 * no other npm runs on the host, and other test files run npm stubs at the same time.
 */
function ownPs(bin: string) {
  writeFileSync(join(bin, "ps"), `#!/bin/sh
/bin/ps -A -o pid=,ppid=,args= | awk -v start=$PPID '{ parent[$1] = $2; line[$1] = $0 } END { p = start; while (p > 1 && (p in line) && !(p in seen)) { seen[p] = 1; print line[p]; p = parent[p] } }'
`);
  chmodSync(join(bin, "ps"), 0o755);
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A host an update was cut off on: npm's retired copy of 2.3.0-beta.16, a half-written new one, no working agend. */
function brokenHost(o: { latestHasInstaller: boolean; betaHasInstaller: boolean }) {
  const d = mkdtempSync(join(tmpdir(), "agend-2286-")); dirs.push(d);
  const prefix = join(d, "prefix"), scope = join(prefix, "lib", "node_modules", "@songsid");
  mkdirSync(join(scope, ".agend-RmEK4vIL"), { recursive: true });
  writeFileSync(join(scope, ".agend-RmEK4vIL", "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.3.0-beta.16" }));
  mkdirSync(join(scope, "agend"));
  writeFileSync(join(scope, "agend", "partial.tmp"), "");
  mkdirSync(join(prefix, "bin"));
  const bin = join(d, "bin"); mkdirSync(bin);
  const withInstaller = JSON.stringify({ agend: "launcher/agend", "agend-install": "launcher/agend-install.cjs" });
  const without = JSON.stringify({ agend: "launcher/agend" });
  writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require("fs"), path = require("path"), cp = require("child_process");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(d, "npm.log"))}, "npm " + a.join(" ") + "\\n");
const prefix = ${JSON.stringify(prefix)}, scope = ${JSON.stringify(scope)};
const view = { "2.3.0-beta.16": [${JSON.stringify(without)}, "2.3.0-beta.16"], "beta": [${JSON.stringify(o.betaHasInstaller ? withInstaller : without)}, "2.3.0-beta.17"], "latest": [${JSON.stringify(o.latestHasInstaller ? withInstaller : without)}, "2.2.7"] };
if (a[0] === "view") { const v = view[a[1].split("@").pop()]; if (!v) process.exit(1); console.log(a[2] === "bin" ? v[0] : v[1]); process.exit(0); }
if (a[0] === "root") { console.log(path.join(prefix, "lib", "node_modules")); process.exit(0); }
if (a[0] === "prefix") { console.log(prefix); process.exit(0); }
if (a[0] === "exec") {
  const rest = a.slice(a.indexOf("--") + 2);
  const r = cp.spawnSync(process.execPath, [${JSON.stringify(join(REPO, "launcher", "agend-install.cjs"))}, ...rest], { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
if (a[0] === "install" && a[1] === "-g") {
  if (fs.readdirSync(scope).some((n) => n.startsWith(".agend-"))) { console.log("npm error code ENOTEMPTY"); process.exit(1); }
  const v = a[2].split("@").pop();
  fs.rmSync(path.join(scope, "agend"), { recursive: true, force: true });
  fs.mkdirSync(path.join(scope, "agend"));
  fs.writeFileSync(path.join(scope, "agend", "package.json"), JSON.stringify({ name: "@songsid/agend", version: v }));
  fs.writeFileSync(path.join(prefix, "bin", "agend"), "#!/bin/sh\\necho " + v + "\\n"); fs.chmodSync(path.join(prefix, "bin", "agend"), 0o755);
  process.exit(0);
}
console.error("unexpected npm " + a.join(" ")); process.exit(9);
`);
  chmodSync(join(bin, "npm"), 0o755);
  ownPs(bin);
  const run = (version: string) => spawnSync("bash", ["-c", `set -euo pipefail\n${helpers}\nSUDO=""\n${step}\necho "AFTER THE STEP"`], {
    encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(d, "home"), AGEND_HOME: join(d, "agend-home"), AGEND_VERSION: version, LANG: "C.UTF-8" },
  });
  const log = () => (existsSync(join(d, "npm.log")) ? readFileSync(join(d, "npm.log"), "utf8") : "");
  return { prefix, scope, run, log };
}

describe("#2286 HOTFIX install.sh: a target from before the installer gets the plain npm install, never a borrowed installer", () => {
  it.each([["today's registry: latest (2.2.6) without the installer, beta with it", false], ["latest and beta both with it", true]])("%s", (_n, latestHasInstaller) => {
    const h = brokenHost({ latestHasInstaller, betaHasInstaller: true });
    const r = h.run("2.3.0-beta.16");
    expect(h.log()).toMatch(/^npm install -g @songsid\/agend@2\.3\.0-beta\.16$/m);
    expect(h.log()).not.toMatch(/npm exec/);
    expect(r.stdout).toContain("npm error code ENOTEMPTY");                               // the known gap, as before #2286
  });
  it("no installer published anywhere: the same plain npm install", () => {
    const h = brokenHost({ latestHasInstaller: false, betaHasInstaller: false });
    const r = h.run("2.3.0-beta.16");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("npm error code ENOTEMPTY");
    expect(h.log()).not.toMatch(/npm exec/);
  });
  it("a target that has the installer runs its own, as before (no --spec)", () => {
    const h = brokenHost({ latestHasInstaller: true, betaHasInstaller: true });
    expect(h.run("beta").status).toBe(0);
    expect(h.log()).toMatch(/^npm exec --yes --package @songsid\/agend@beta -- agend-install$/m);
  });
});

/** v2.3.0-beta.16 as npm installs it: its own install-admission in a postinstall that refuses like that release's. */
function legacyTarball(d: string) {
  const pkg = join(d, "src", "package"); mkdirSync(join(pkg, "launcher"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.3.0-beta.16", bin: { agend: "launcher/agend" }, scripts: { postinstall: "node launcher/postinstall.cjs" } }));
  copyFileSync(join(REPO, "tests", "fixtures", "install-admission-2.3.0-beta.16.cjs"), join(pkg, "launcher", "install-admission.cjs"));
  // Its postinstall's admission step (launcher/postinstall.cjs:65–67 of that release); the rest of the CLI is inert.
  writeFileSync(join(pkg, "launcher", "postinstall.cjs"), `var a = require("./install-admission.cjs").admit(require("path").join(__dirname, ".."));
require("fs").appendFileSync(${JSON.stringify(join(d, "postinstall.log"))}, JSON.stringify(a) + "\\n");
if (!a.ok) { console.error("AgEnD install refused: " + a.reason); process.exit(1); }
`);
  writeFileSync(join(pkg, "launcher", "agend"), "#!/bin/sh\necho 2.3.0-beta.16\n"); chmodSync(join(pkg, "launcher", "agend"), 0o755);
  const tgz = join(d, "agend-2.3.0-beta.16.tgz");
  const t = spawnSync("tar", ["-czf", tgz, "-C", join(d, "src"), "package"], { encoding: "utf8" });
  if (t.status !== 0) throw new Error(t.stderr);
  return tgz;
}
const NPM = spawnSync("bash", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim();
const NODE_DIR = dirname(process.execPath);
/** Real npm, offline, into `prefix`, with the environment it was given (the installer's). */
const npmEnv = (d: string, prefix: string) => ({
  PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: join(d, "home"), npm_config_prefix: prefix, npm_config_cache: join(d, "npm-cache"),
  npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
});

/** A host whose AgEnD is v2.3.0-beta.16 behind real npm. `state`: an update cut off (npm's copy aside), or no runnable agend. */
function legacyHost(state: "interrupted" | "unrunnable" | "clean", o = { latestHasInstaller: true }) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "agend-2286-legacy-"))); dirs.push(d);
  const prefix = join(d, "prefix"), scope = join(prefix, "lib", "node_modules", "@songsid");
  const old = join(scope, state === "interrupted" ? ".agend-RmEK4vIL" : "agend");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  if (state !== "clean") {
    mkdirSync(join(old, "launcher"), { recursive: true });
    writeFileSync(join(old, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.3.0-beta.16", bin: { agend: "launcher/agend" } }));
    writeFileSync(join(old, "launcher", "agend"), "#!/bin/sh\necho 2.3.0-beta.16\n");   // whole; bin/agend not linked
  }
  if (state === "interrupted") { mkdirSync(join(scope, "agend")); writeFileSync(join(scope, "agend", "partial.tmp"), ""); }
  const tgz = legacyTarball(d);
  const bin = join(d, "bin"); mkdirSync(bin);
  const withInstaller = JSON.stringify({ agend: "launcher/agend", "agend-install": "launcher/agend-install.cjs" });
  writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require("fs"), path = require("path"), cp = require("child_process");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(d, "npm.log"))}, "npm " + a.join(" ") + "\\n");
const prefix = ${JSON.stringify(prefix)};
const view = { "2.3.0-beta.16": [${JSON.stringify(JSON.stringify({ agend: "launcher/agend" }))}, "2.3.0-beta.16"], "beta": [${JSON.stringify(withInstaller)}, "2.3.0-beta.17"], "latest": [${JSON.stringify(o.latestHasInstaller ? withInstaller : JSON.stringify({ agend: "launcher/agend" }))}, "2.2.7"] };
if (a[0] === "view") { const v = view[a[1].split("@").pop()]; if (!v) process.exit(1); console.log(a[2] === "bin" ? v[0] : v[1]); process.exit(0); }
if (a[0] === "root") { console.log(path.join(prefix, "lib", "node_modules")); process.exit(0); }
if (a[0] === "prefix") { console.log(prefix); process.exit(0); }
if (a[0] === "exec") {
  const rest = a.slice(a.indexOf("--") + 2);
  const r = cp.spawnSync(process.execPath, [${JSON.stringify(join(REPO, "launcher", "agend-install.cjs"))}, ...rest], { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
if (a[0] === "install" && a[1] === "-g") {
  // Only v2.3.0-beta.16 exists here (the tarball); real npm installs it with whatever environment the installer gave.
  if (a[2] !== "@songsid/agend@2.3.0-beta.16") { console.log("npm error 404 " + a[2]); process.exit(1); }
  const env = Object.assign({}, process.env, ${JSON.stringify(npmEnv(d, prefix))});
  const r = cp.spawnSync(${JSON.stringify(NPM)}, ["install", "-g", ${JSON.stringify(tgz)}], { stdio: "inherit", env });
  process.exit(r.status === null ? 1 : r.status);
}
console.error("unexpected npm " + a.join(" ")); process.exit(9);
`);
  chmodSync(join(bin, "npm"), 0o755);
  ownPs(bin);
  const run = (version: string) => spawnSync("bash", ["-c", `set -euo pipefail\n${helpers}\nSUDO=""\n${step}\necho "AFTER THE STEP"`], {
    encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(d, "home"), AGEND_HOME: join(d, "agend-home"), AGEND_VERSION: version, LANG: "C.UTF-8" },
  });
  // The installer as `npm exec --package <newest> -- agend-install --spec <older>` runs it (the stub's PATH: its npm, its ps).
  const runInstaller = (args: string[]) => spawnSync(process.execPath, [join(REPO, "launcher", "agend-install.cjs"), ...args], {
    encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(d, "home"), AGEND_HOME: join(d, "agend-home"), LANG: "C.UTF-8" },
  });
  const admissions = () => (existsSync(join(d, "postinstall.log")) ? readFileSync(join(d, "postinstall.log"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
  return { d, prefix, scope, tgz, run, runInstaller, admissions };
}

describe("#2286 Prism r1: a release from before #2264 behind real npm — its own postinstall admits the installer's install", () => {
  it("HOTFIX, the live failure: today's registry (latest without the installer, beta with one) on a clean host — install.sh's plain npm install, admitted as an external install", () => {
    const h = legacyHost("clean", { latestHasInstaller: false });
    const r = h.run("2.3.0-beta.16");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("AFTER THE STEP");
    expect(h.admissions()).toEqual([{ ok: true, why: "no lock: an external install" }]);
    expect(spawnSync(join(h.prefix, "bin", "agend"), [], { encoding: "utf8" }).stdout.trim()).toBe("2.3.0-beta.16");
  });

  it("the installer with --spec of that release, on the user's state: its postinstall sees the installer's live lock AND its token, so it installs", () => {
    const h = legacyHost("interrupted");
    const r = h.runInstaller(["--spec", "@songsid/agend@2.3.0-beta.16"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("put back AgEnD v2.3.0-beta.16 that an interrupted install had moved aside");
    expect(h.admissions()).toEqual([{ ok: true, why: "the updater's own install" }]);   // the lock was live: the token is what admitted it
    expect(spawnSync(join(h.prefix, "bin", "agend"), [], { encoding: "utf8" }).stdout.trim()).toBe("2.3.0-beta.16");
    expect(existsSync(join(h.prefix, ".agend-install.lock")), "the lock is released afterwards").toBe(false);
  });

  it("the previous version put back (the target fails, agend does not run): the old release's postinstall admits it too", () => {
    const h = legacyHost("unrunnable");
    const r = h.run("beta");   // beta has its own installer, whose own version npm does not have here
    expect(r.stdout + r.stderr).toMatch(/v2\.3\.0-beta\.16 was reinstalled and runs/);
    expect(h.admissions()).toEqual([{ ok: true, why: "the updater's own install" }]);
    expect(spawnSync(join(h.prefix, "bin", "agend"), [], { encoding: "utf8" }).stdout.trim()).toBe("2.3.0-beta.16");
  });

  describe("controls: that release's admission, with real npm, refuses what it should (so the cases above are not vacuous)", () => {
    const readers = createRequire(import.meta.url)("../launcher/install-admission.cjs") as { processStart(pid: number): string | null };
    const TOKEN = "a".repeat(32);
    const setup = () => {
      const d = realpathSync(mkdtempSync(join(tmpdir(), "agend-2286-ctl-"))); dirs.push(d);
      const prefix = join(d, "prefix"); mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
      const tgz = legacyTarball(d);
      const install = (extra: Record<string, string>) => spawnSync(NPM, ["install", "-g", tgz], { encoding: "utf8", env: { ...npmEnv(d, prefix), ...extra } });
      const hold = () => writeFileSync(join(prefix, ".agend-install.lock"), JSON.stringify({ pid: process.pid, processStart: readers.processStart(process.pid), prefix, targetSpec: "@songsid/agend@2.3.0-beta.16", agendHome: join(d, "h"), token: TOKEN, createdAt: new Date().toISOString() }) + "\n");
      return { d, install, hold };
    };
    it("no lock, no token: an external install proceeds", () => {
      expect(setup().install({}).status).toBe(0);
    });
    it.each([["no token", {}], ["a foreign token", { AGEND_INSTALL_TOKEN: "b".repeat(32) }]])("a live lock and %s: refused, naming the running update", (_n, env) => {
      const c = setup(); c.hold();
      const r = c.install(env as Record<string, string>);
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(new RegExp(`an \`agend update\` \\(pid ${process.pid}\\) is installing into`));
    });
    it("a live lock and its own token: admitted", () => {
      const c = setup(); c.hold();
      expect(c.install({ AGEND_INSTALL_TOKEN: TOKEN }).status).toBe(0);
    });
  });
});
