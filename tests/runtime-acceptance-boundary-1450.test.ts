/**
 * #1450 runtime acceptance (#1460 review): the hop's fail-fast boundary, scripts/ci/runtime-acceptance/boundary.cjs.
 * Preloaded into a Node process, every way that process could start a fleet — or reach a service manager by absolute
 * path — fails at once and is logged for the job to gate on. Targets here are inert stand-ins that leave a marker.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { registerExecutableFixture } from "./support/process-guard.js";

const BOUNDARY = join(process.cwd(), "scripts", "ci", "runtime-acceptance", "boundary.cjs");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), "agend-boundary-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const mark = join(root, "ran");
  // An inert `agend` on PATH (registered, so the test-process guard lets the shell form reach the boundary).
  writeFileSync(join(bin, "agend"), `#!/bin/sh\necho "$*" >> '${mark}'\n`);
  chmodSync(join(bin, "agend"), 0o755);
  registerExecutableFixture(join(bin, "agend"));
  writeFileSync(join(root, "inert.js"), `require('fs').appendFileSync(${JSON.stringify(mark)}, process.argv.slice(2).join(' ') + '\\n');`);
  const log = join(root, "boundary.log");
  writeFileSync(log, "");
  const run = (script: string, argv: string[] = []) => spawnSync(process.execPath, ["-e", script, ...argv], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGEND_BOUNDARY_LOG: log, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${BOUNDARY}`.trim() },
  });
  return { root, mark, log, run, logged: () => readFileSync(log, "utf8") };
}

describe("the hop boundary refuses a fleet start in every form, before anything runs", () => {
  it.each([
    ["spawn: node <entry> fleet start", (w: ReturnType<typeof world>) => `require('child_process').spawn(process.execPath, [${JSON.stringify(join(w.root, "inert.js"))}, 'fleet', 'start'])`],
    ["spawnSync", (w: ReturnType<typeof world>) => `require('child_process').spawnSync(process.execPath, [${JSON.stringify(join(w.root, "inert.js"))}, 'fleet', 'start'])`],
    ["a shell string: sh -c 'agend fleet start'", () => `require('child_process').execSync("agend fleet start")`],
    ["sh -c with the command as positional data", () => `require('child_process').spawnSync('sh', ['-c', 'exec "$@"', 'sh', 'agend', 'fleet', 'start'])`],
    ["ESM named import (as AgEnD's own code imports it)", (w: ReturnType<typeof world>) => `import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, [${JSON.stringify(join(w.root, "inert.js"))}, 'fleet', 'start']))`],
    ["systemctl by absolute path", () => `require('child_process').spawnSync('/usr/bin/systemctl', ['--user', 'restart', 'com.agend.fleet'])`],
  ])("%s", (_name, script) => {
    const w = world();
    const r = w.run(script(w));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("[runtime-acceptance boundary]");
    expect(w.logged()).not.toBe("");
    expect(existsSync(w.mark)).toBe(false);
  });

  it.each([
    ["execSync", (m: string) => `require('child_process').execSync(${JSON.stringify(`${m} --user restart private-unit`)})`],
    ["sh -c", (m: string) => `require('child_process').spawnSync('sh', ['-c', ${JSON.stringify(`true && ${m} --user restart private-unit`)}])`],
    ["sudo inside sh -c", (m: string) => `require('child_process').spawnSync('sh', ['-c', ${JSON.stringify(`sudo -n ${m} kickstart -k gui/1/x`)}])`],
  ])("a service manager by absolute path inside a command string (%s) is refused; the private manager never runs", (_n, script) => {
    const w = world();
    const manager = join(w.root, "private", "systemctl");
    mkdirSync(join(w.root, "private"));
    writeFileSync(manager, `#!/bin/sh\necho "$*" >> '${w.mark}'\n`);
    chmodSync(manager, 0o755);
    const r = w.run(script(manager));
    expect(r.status).not.toBe(0);
    expect(w.logged()).toContain("service manager by absolute path");
    expect(existsSync(w.mark)).toBe(false);
  });

  it("a process that was itself started as a fleet start (e.g. by a shell the boundary never saw) stops at once", () => {
    const w = world();
    const r = spawnSync(process.execPath, [join(w.root, "inert.js"), "fleet", "start"], { encoding: "utf8", env: { ...process.env, AGEND_BOUNDARY_LOG: w.log, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${BOUNDARY}`.trim() } });
    expect(r.status).toBe(70);
    expect(w.logged()).toContain("(self) fleet start");
    expect(existsSync(w.mark)).toBe(false);
  });

  it("controls: other commands run, and without AGEND_BOUNDARY_LOG the preload does nothing", () => {
    const w = world();
    expect(w.run(`require('child_process').spawnSync(process.execPath, [${JSON.stringify(join(w.root, "inert.js"))}, 'fleet', 'restart'])`).status).toBe(0);
    expect(readFileSync(w.mark, "utf8")).toBe("fleet restart\n");
    expect(w.logged()).toBe("");
  });
});

describe("which stubbed manager calls would have activated something (manager-activations.cjs)", () => {
  const { activation } = createRequire(import.meta.url)("../scripts/ci/runtime-acceptance/manager-activations.cjs") as { activation(line: string): string | null };
  it.each([
    ["systemctl --no-pager --user restart private-unit", "restart"],
    ["sudo systemctl --user start private-unit", "start"],
    ["sudo -n -u root /bin/systemctl --user stop x", "stop"],
    ["launchctl kickstart -k gui/501/x", "kickstart"],
    ["launchctl bootstrap gui/501 /p.plist", "bootstrap"],
    ["systemctl -H host --user enable x", "enable"],
  ])("activating: %s", (line, verb) => { expect(activation(line)).toBe(verb); });
  it.each([
    ["systemctl --user is-active com.agend.fleet"], ["systemctl --user daemon-reload"], ["systemctl --user show -p KillMode --value com.agend.fleet"],
    ["systemctl -p ExecStart show x"], ["launchctl print gui/501/x"], ["launchctl getenv NODE_OPTIONS"], ["sudo -n npm uninstall -g @songsid/agend"],
  ])("not activating: %s", (line) => { expect(activation(line)).toBeNull(); });
});

describe("the acceptance DB probe (checks.sh) passes only a validated worker answer AND a clean worker exit", () => {
  // The exact probe the acceptance job runs, extracted from checks.sh.
  const checks = readFileSync(join(process.cwd(), "scripts", "ci", "runtime-acceptance", "checks.sh"), "utf8");
  const start = checks.indexOf('"$RT_NODE" -e \'\n') + '"$RT_NODE" -e \'\n'.length;
  const probe = checks.slice(start, checks.indexOf("\n  ' \"$pkg\"", start));
  /** A stand-in better-sqlite3: a file-backed row counter, plus what the worker does around its answer. */
  function pkg(worker: "normal" | "exit-before" | "exit0-before" | "exit-after" | "wrong-count") {
    const dir = mkdtempSync(join(tmpdir(), "agend-probe-"));
    roots.push(dir);
    mkdirSync(join(dir, "node_modules", "better-sqlite3"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "node_modules", "better-sqlite3", "package.json"), JSON.stringify({ name: "better-sqlite3", main: "index.js" }));
    writeFileSync(join(dir, "node_modules", "better-sqlite3", "index.js"), `
      const wt = require("node:worker_threads"), fs = require("fs");
      const mode = ${JSON.stringify(worker)};
      if (!wt.isMainThread && mode === "exit-before") process.exit(17);
      if (!wt.isMainThread && mode === "exit0-before") process.exit(0);
      if (!wt.isMainThread && mode === "exit-after") setTimeout(() => process.exit(17), 50);
      module.exports = class { constructor(f) { this.f = f; } exec() {} close() {}
        prepare() { return { run: () => fs.appendFileSync(this.f, "x"), get: () => ({ n: fs.readFileSync(this.f, "utf8").length + (!wt.isMainThread && mode === "wrong-count" ? 5 : 0) }) }; } };`);
    return dir;
  }
  it.each([["normal", 0], ["exit-before", 1], ["exit0-before", 1], ["exit-after", 1], ["wrong-count", 1]] as const)("worker %s → exit %i", (mode, want) => {
    const dir = pkg(mode);
    const r = spawnSync(process.execPath, ["-e", probe, dir, join(dir, "probe.db")], { encoding: "utf8", timeout: 40_000 });
    expect(r.status, r.stderr).toBe(want);
  });
});
