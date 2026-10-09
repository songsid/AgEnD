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
    expect(w.logged()).toMatch(/service manager by (absolute )?path|sudo in a hop/);
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

describe("the hop's stubbed manager calls: argv kept, judged fail-closed (manager-activations.cjs)", () => {
  const { parseLog, refusal } = createRequire(import.meta.url)("../scripts/ci/runtime-acceptance/manager-activations.cjs") as {
    parseLog(buf: Buffer): Array<{ name: string; args: string[] }> | null; refusal(rec: { name: string; args: string[] }): string | null;
  };
  // The EXACT stub the hop writes (hop.sh), for each tool.
  const hop = readFileSync(join(process.cwd(), "scripts", "ci", "runtime-acceptance", "hop.sh"), "utf8");
  const template = hop.slice(hop.indexOf("<<STUB\n") + "<<STUB\n".length, hop.indexOf("\nSTUB\n"));
  function stubs() {
    const root = mkdtempSync(join(tmpdir(), "agend-stubs-"));
    roots.push(root);
    mkdirSync(join(root, "guard"));
    for (const tool of ["systemctl", "launchctl", "sudo"]) {
      // The heredoc is unquoted: $tool/$WORK expand at write time, \$ stays a literal $.
      const body = template.replace(/\$tool/g, tool).replace(/\$WORK/g, root).replace(/\\\$/g, "$").replace(/\\\\n/g, "\\n");
      writeFileSync(join(root, "guard", tool), body + "\n");
      chmodSync(join(root, "guard", tool), 0o755);
    }
    writeFileSync(join(root, "guard.log"), "");
    const call = (tool: string, ...args: string[]) => spawnSync(join(root, "guard", tool), args, { encoding: "utf8" });
    return { call, records: () => parseLog(readFileSync(join(root, "guard.log")))! };
  }
  it("argv boundaries survive the log: a quoted multi-word value is ONE argument", () => {
    const st = stubs();
    expect(st.call("systemctl", "-p", "two words", "--user", "show", "x").status).toBe(1);
    expect(st.records()).toEqual([{ name: "systemctl", args: ["-p", "two words", "--user", "show", "x"] }]);
  });
  it.each([
    ["sudo", ["--user", "root", "systemctl", "--user", "start", "x"]],
    ["sudo", ["--group", "operators", "systemctl", "--user", "start", "x"]],
    ["sudo", ["--chdir", "/tmp", "systemctl", "--user", "start", "x"]],
    ["sudo", ["-p", "multi word prompt", "systemctl", "--user", "start", "x"]],
    ["sudo", ["-n", "npm", "uninstall", "-g", "@songsid/agend"]],
    ["systemctl", ["--no-pager", "--user", "restart", "private-unit"]],
    ["systemctl", ["-p", "two words", "restart", "x"]],
    ["systemctl", ["--unknown-option", "show", "x"]],
    ["systemctl", ["--user"]],
    ["launchctl", ["kickstart", "-k", "gui/501/x"]],
    ["launchctl", ["bootstrap", "gui/501", "/p.plist"]],
  ])("refused: %s %j", (tool, args) => {
    const st = stubs();
    st.call(tool, ...args);
    const recs = st.records();
    expect(recs).toHaveLength(1);
    expect(refusal(recs[0]!)).not.toBeNull();
  });
  it.each([
    ["systemctl", ["--user", "is-active", "com.agend.fleet"]],
    ["systemctl", ["--user", "daemon-reload"]],
    ["systemctl", ["--user", "show", "-p", "KillMode", "--value", "com.agend.fleet"]],
    ["systemctl", ["is-active", "agend"]],
    ["systemctl", ["--user", "reset-failed", "com.agend.fleet"]],
    ["launchctl", ["print", "gui/501/com.agend.fleet"]],
    ["launchctl", ["getenv", "NODE_OPTIONS"]],
  ])("read-only, allowed: %s %j", (tool, args) => {
    const st = stubs();
    st.call(tool, ...args);
    expect(refusal(st.records()[0]!)).toBeNull();
  });
  it("a log that is not well-formed is refused as a whole", () => {
    expect(parseLog(Buffer.from("systemctl 9:short\n"))).toBeNull();
  });
});

describe("shell strings are judged as the shell splits them (boundary.cjs)", () => {
  const { shellViolation } = createRequire(import.meta.url)(BOUNDARY) as { shellViolation(text: string): string | null };
  it.each([
    ['"/tmp/a b/systemctl" --user restart x'],
    ['"/tmp/x"/systemctl --user restart x'],
    ["'/tmp/x'/launchctl kickstart -k gui/1/x"],
    ['M=/x/systemctl; "$M" --user restart x'],
    ["echo $(/usr/bin/systemctl restart x)"],
    ["env -i /usr/bin/systemctl restart x"],
    ["eval '/usr/bin/systemctl restart x'"],
    ['sh -c "/bin/launchctl kickstart -k gui/1/x"'],
    ["sudo -n npm uninstall -g @songsid/agend"],
    ["true && agend fleet start"],
    ["echo 'unterminated"],
  ])("refused: %s", (text) => { expect(shellViolation(text)).not.toBeNull(); });
  it.each([
    ["which agend"], ['readlink -f "/a b/agend"'], ["npm install -g @songsid/agend@2.2.0"], ["node scripts/preinstall-guard.cjs"],
    ["systemctl --user show -p KillMode --value com.agend.fleet"], ['sys"temctl" --user is-active x'], ["npm config get prefix"],
  ])("allowed (reaches PATH and its stubs): %s", (text) => { expect(shellViolation(text)).toBeNull(); });

  it.each([
    ['"%s" --user restart private-unit', "quoted absolute path with a space"],
    ['"%d"/systemctl --user restart private-unit', "quoted directory + basename"],
  ])("executed, with a private manager at a path with spaces: %s (%s) is refused and never runs", (form) => {
    const w = world();
    const dir = join(w.root, "a dir");
    mkdirSync(dir);
    const manager = join(dir, "systemctl");
    writeFileSync(manager, `#!/bin/sh\necho "$*" >> '${w.mark}'\n`);
    chmodSync(manager, 0o755);
    const command = form.replace("%s", manager).replace("%d", dir);
    const r = w.run(`require('child_process').execSync(${JSON.stringify(command)})`);
    expect(r.status).not.toBe(0);
    expect(w.logged()).not.toBe("");
    expect(existsSync(w.mark)).toBe(false);
  });
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
