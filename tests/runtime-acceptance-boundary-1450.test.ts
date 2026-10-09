/**
 * #1450 runtime acceptance (#1460 review): the hop's fail-fast boundary, scripts/ci/runtime-acceptance/boundary.cjs.
 * Preloaded into a Node process, every way that process could start a fleet — or reach a service manager by absolute
 * path — fails at once and is logged for the job to gate on. Targets here are inert stand-ins that leave a marker.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
