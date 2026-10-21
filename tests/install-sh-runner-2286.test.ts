/**
 * #2286 review: install.sh's installer step for a target from before the installer (#2264) — a version pinned to repair a
 * host, an older tag. A plain `npm install -g` there is the very install that fails on what an interrupted one left
 * (npm's retired copy beside the package: ENOTEMPTY). So the step borrows the newest installer (latest, else beta),
 * which repairs first and then installs exactly that version (--spec) and proves it.
 *
 * The step runs exactly as install.sh has it (the marked block, its helpers, `set -euo pipefail`) with a stub npm. The
 * stub's `exec` runs the REAL launcher/agend-install.cjs; its `install -g` fails ENOTEMPTY while a retired `.agend-*`
 * copy is in the way — what npm does — and otherwise writes the package and its bin.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const script = readFileSync(join(REPO, "install.sh"), "utf8");
const step = /# >>> agend-installer step[^\n]*\n([\s\S]*?)# <<< agend-installer step/.exec(script)?.[1] ?? "";
const helpers = script.split("\n").filter(l => /^(?:RED|GREEN|YELLOW|NC)=|^(?:info|warn|error)\(\)/.test(l)).join("\n");
const dirs: string[] = [];
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
  const run = (version: string) => spawnSync("bash", ["-c", `set -euo pipefail\n${helpers}\nSUDO=""\n${step}\necho "AFTER THE STEP"`], {
    encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(d, "home"), AGEND_HOME: join(d, "agend-home"), AGEND_VERSION: version, LANG: "C.UTF-8" },
  });
  const log = () => (existsSync(join(d, "npm.log")) ? readFileSync(join(d, "npm.log"), "utf8") : "");
  return { prefix, scope, run, log };
}

describe("#2286 install.sh: a target from before the installer is installed by the newest installer", () => {
  it("the user's state, a pre-installer version pinned: latest's installer repairs (npm's copy out of the way), then installs and proves exactly that version", () => {
    const h = brokenHost({ latestHasInstaller: true, betaHasInstaller: true });
    const r = h.run("2.3.0-beta.16");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("AFTER THE STEP");
    expect(h.log()).toMatch(/^npm exec --yes --package @songsid\/agend@latest -- agend-install --spec @songsid\/agend@2\.3\.0-beta\.16$/m);
    expect(h.log()).toMatch(/^npm install -g @songsid\/agend@2\.3\.0-beta\.16$/m);
    expect(readdirSync(h.scope).filter((n) => n.startsWith(".agend-"))).toEqual([]);     // nothing left in npm's way
    expect(JSON.parse(readFileSync(join(h.scope, "agend", "package.json"), "utf8")).version).toBe("2.3.0-beta.16");
    expect(spawnSync(join(h.prefix, "bin", "agend"), ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("2.3.0-beta.16");
  });
  it("latest from before the installer too: beta's installer does it", () => {
    const h = brokenHost({ latestHasInstaller: false, betaHasInstaller: true });
    expect(h.run("2.3.0-beta.16").status).toBe(0);
    expect(h.log()).toMatch(/^npm exec --yes --package @songsid\/agend@beta -- agend-install --spec @songsid\/agend@2\.3\.0-beta\.16$/m);
  });
  it("control — no installer published anywhere: the plain npm install, which fails on npm's own leftover (the gap this closes)", () => {
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
