import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import setupGlobalGuard from "./setup-process-guard-global.js";
import { checkTestProcess, processGuard, registerExecutableFixture } from "./support/process-guard.js";

const dirs: string[] = [];
function scratch(prefix = "agend-guard-boundary-") {
  const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir;
}
function inert(file: string, script = false) {
  mkdirSync(dirname(file), { recursive: true });
  const marker = `${file}.started`;
  writeFileSync(file, script
    ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`
    : `#!/bin/sh\nprintf started > '${marker}'\n`);
  chmodSync(file, 0o700);
  return marker;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("process guard child execution boundaries", () => {
  // The parent of the attempted launch must really be in A. A standalone Node
  // child supplies that cwd without changing Vitest's cwd. Both A and B are
  // inert files, so a reverse mutant can never run an installed backend.
  it.each(["sync", "async"] as const)("uses child cwd for a relative executable (%s)", api => {
    const root = scratch(), a = join(root, "A"), b = join(root, "B");
    const am = inert(join(a, "codex")), bm = inert(join(b, "codex"));
    registerExecutableFixture(join(a, "codex"));
    const source = `
      const assert = require('node:assert/strict'), cp = require('node:child_process');
      (async () => {
        const launch = cwd => ${api === "sync" ? "cp.execFileSync('./codex', [], {cwd})" : "cp.spawn('./codex', [], {cwd})"};
        assert.throws(() => launch(${JSON.stringify(b)}), /real backend CLI forbidden/);
        const child = launch(${JSON.stringify(a)});
        ${api === "async" ? "await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',code => code === 0 ? resolve() : reject(new Error('fixture exit'))); });" : ""}
        assert.equal(require('node:fs').existsSync(${JSON.stringify(bm)}), false);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ["-e", source], { cwd: a, encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(am)).toBe(true);
    expect(existsSync(bm)).toBe(false);
    expect(processGuard.takeViolations()).toEqual([expect.stringContaining("real backend CLI forbidden")]);
  });

  it.each(["sync", "async", "shell"] as const)("uses child cwd for relative PATH entries (%s)", api => {
    const root = scratch(), a = join(root, "A"), b = join(root, "B");
    const am = inert(join(a, "bin", "codex")), bm = inert(join(b, "bin", "codex"));
    registerExecutableFixture(join(a, "bin", "codex"));
    const call = api === "sync" ? "cp.execFileSync('codex', [], options)"
      : api === "async" ? "cp.spawn('codex', [], options)" : "cp.execSync('codex', options)";
    const source = `
      const assert = require('node:assert/strict'), cp = require('node:child_process');
      (async () => {
        const launch = cwd => { const options = {cwd, env:{...process.env, PATH:'bin'}}; return ${call}; };
        assert.throws(() => launch(${JSON.stringify(b)}), /real backend CLI forbidden/);
        const child = launch(${JSON.stringify(a)});
        ${api === "async" ? "await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',code => code === 0 ? resolve() : reject(new Error('fixture exit'))); });" : ""}
        assert.equal(require('node:fs').existsSync(${JSON.stringify(bm)}), false);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ["-e", source], { cwd: a, env: { ...process.env, PATH: "bin" }, encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(am)).toBe(true);
    expect(existsSync(bm)).toBe(false);
    expect(processGuard.takeViolations()).toEqual([expect.stringContaining("real backend CLI forbidden")]);
  });

  it.each(["sync", "async"] as const)("pins a Node entry script in the child's cwd (%s)", api => {
    const root = scratch(), a = join(root, "A"), b = join(root, "B");
    const am = inert(join(a, "codex.cjs"), true), bm = inert(join(b, "codex.cjs"), true);
    registerExecutableFixture(join(a, "codex.cjs"));
    const source = `
      const assert = require('node:assert/strict'), cp = require('node:child_process');
      (async () => {
        const launch = cwd => cp.${api === "sync" ? "execFileSync" : "spawn"}(process.execPath, ['codex.cjs'], {cwd});
        assert.throws(() => launch(${JSON.stringify(b)}), /real backend Node entry forbidden/);
        const child = launch(${JSON.stringify(a)});
        ${api === "async" ? "await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',code => code === 0 ? resolve() : reject(new Error('fixture exit'))); });" : ""}
        assert.equal(require('node:fs').existsSync(${JSON.stringify(bm)}), false);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ["-e", source], { cwd: a, encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(am)).toBe(true);
    expect(existsSync(bm)).toBe(false);
    expect(processGuard.takeViolations()).toEqual([expect.stringContaining("real backend Node entry forbidden")]);
  });

  // #1450 C5: AgEnD restarts itself as `<node> <repo>/dist/cli.js fleet start`, so a test can no longer stub an
  // `agend` on PATH; the guard must stop that spawn itself. Scratch HOME/AGEND_HOME as a second line of defence.
  it("a real `fleet start` of this repo's CLI is refused; with AGEND_TEST_SELF_SPAWN_LOG it is recorded and inert", () => {
    const guard = createRequire(import.meta.url)("./support/process-guard.cjs") as { selfFleetStart(file: string, argv: string[], cwd: string): string | null };
    const cli = resolve("dist/cli.js");
    expect(guard.selfFleetStart(process.execPath, [cli, "fleet", "start"], process.cwd())).toBe("fleet start");
    expect(guard.selfFleetStart(process.execPath, [cli, "fleet", "restart", "--reload"], process.cwd())).toBeNull();   // talks to a running fleet; tests drive it
    expect(guard.selfFleetStart(process.execPath, [cli, "backend", "doctor"], process.cwd())).toBeNull();
    expect(guard.selfFleetStart(process.execPath, [join(scratch(), "dist", "cli.js"), "fleet", "start"], process.cwd())).toBeNull();
    if (!existsSync(cli)) return;
    const root = scratch(), log = join(root, "self-spawn.log");
    // A Node child (guard preloaded) attempts the detached self-start, as cli.ts does.
    const attempt = (env: Record<string, string>) => spawnSync(process.execPath, ["-e", `
      const cp = require('node:child_process');
      try { cp.spawn(process.execPath, [${JSON.stringify(cli)}, 'fleet', 'start'], { detached: true, stdio: 'ignore' }).unref(); console.log('spawned'); }
      catch (e) { console.log('refused: ' + e.message); }`], { encoding: "utf8", env: { ...process.env, HOME: root, AGEND_HOME: join(root, ".agend"), ...env } });
    const refused = attempt({});
    expect(refused.stdout).toContain("refused: [test process guard] a real `agend fleet start` from a test is forbidden");
    expect(processGuard.drainJournal(process.env.AGEND_TEST_GUARD_LOG!)).toEqual([expect.stringContaining("agend fleet start")]);
    const recorded = attempt({ AGEND_TEST_SELF_SPAWN_LOG: log });
    expect(recorded.stdout.trim()).toBe("spawned");
    expect(readFileSync(log, "utf8")).toBe("agend fleet start\n");
    expect(existsSync(join(root, ".agend", "fleet.pid"))).toBe(false);
    // …and the old shell form never reaches whatever `agend` this host has installed.
    expect(() => execSync("agend fleet start", { stdio: "ignore", env: { ...process.env, HOME: root, AGEND_HOME: join(root, ".agend") } }))
      .toThrow("a real `agend fleet start` from a test is forbidden");
    expect(processGuard.takeViolations()).toEqual([expect.stringContaining("agend fleet start")]);
  });

  it("does not bootstrap a fixture from the parent cwd when child PATH is absent", () => {
    const dir = scratch(), file = join(dir, "codex"); inert(file); registerExecutableFixture(file);
    expect(() => checkTestProcess("codex", [], {}, dir)).toThrow(/real backend CLI forbidden/);
    expect(() => checkTestProcess(file, [], {}, dir)).not.toThrow();
  });

  it.each(["execSync", "execFileSync", "spawnSync"] as const)("checks the executable named by options.shell (%s)", api => {
    const shell = join(scratch(), "codex"), marker = inert(shell);
    const native = createRequire(import.meta.url)("node:child_process");
    const call = () => api === "execSync" ? native[api]("printf control", { shell }) : native[api]("printf", ["control"], { shell });
    expect(call).toThrow(/real backend CLI forbidden/);
    expect(existsSync(marker)).toBe(false);
    expect(processGuard.takeViolations()).toEqual([expect.stringContaining("real backend CLI forbidden")]);
    const control = api === "execSync" ? execSync("printf control", { shell: "/bin/sh" })
      : api === "execFileSync" ? execFileSync("printf", ["control"], { shell: "/bin/sh" })
        : spawnSync("printf", ["control"], { shell: "/bin/sh" }).stdout;
    expect(control.toString()).toBe("control");
    registerExecutableFixture(shell);
    call(); // a deliberately pinned inert shell remains permitted
    expect(existsSync(marker)).toBe(true);
  });

  it("checks the command as well as a permitted custom shell", () => {
    const dir = scratch(), shell = join(dir, "codex"), executable = join(dir, "other", "codex");
    const marker = inert(shell); inert(executable); registerExecutableFixture(shell);
    expect(() => execSync(executable, { shell })).toThrow(/real backend CLI forbidden/);
    expect(existsSync(marker)).toBe(false);
    expect(processGuard.takeViolations()).toEqual([expect.stringContaining("real backend CLI forbidden")]);
  });

  it("rejects socket and parent aliases while permitting a future genuine private socket", () => {
    const dir = scratch(), target = scratch("guard-other-server-");
    writeFileSync(join(target, "default"), "inert socket stand-in");
    symlinkSync(join(target, "default"), join(dir, "socket-alias"));
    symlinkSync(target, join(dir, "parent-alias"), "dir");
    symlinkSync(join(target, "missing"), join(dir, "dangling"));
    for (const socket of [join(dir, "socket-alias"), join(dir, "parent-alias", "sock"), join(dir, "dangling")]) {
      expect(() => checkTestProcess("tmux", ["-S", socket, "kill-server"])).toThrow(/private test socket/);
    }
    expect(() => checkTestProcess("tmux", ["-S", join(dir, "fresh", "sock"), "new-session", "sleep 5"])).not.toThrow();
  });
});

function appendDuringRead(log: string, message: string) {
  const native = createRequire(import.meta.url)("node:fs"), original = native.readFileSync;
  let injected = false;
  const spy = vi.spyOn(native, "readFileSync").mockImplementation((...args: unknown[]) => {
    const data = original(...args);
    if (args[0] === log && !injected) { injected = true; native.appendFileSync(log, `${message}\n`); }
    return data;
  });
  syncBuiltinESMExports();
  return () => { spy.mockRestore(); syncBuiltinESMExports(); };
}

describe("append-only process violation journal", () => {
  it("does not erase a child append between journal read and cursor update", () => {
    const log = join(scratch(), "worker-race.log"); writeFileSync(log, "first\n");
    const restore = appendDuringRead(log, "late child violation");
    try { expect(processGuard.drainJournal(log)).toEqual(["first"]); }
    finally { restore(); }
    expect(processGuard.drainJournal(log)).toEqual(["late child violation"]);
    expect(processGuard.drainJournal(log)).toEqual([]);
    expect(readFileSync(log, "utf8")).toBe("first\nlate child violation\n");
  });

  it("lets real global teardown see the unread append after a worker drain", () => {
    const directory = scratch(), log = join(directory, "worker-race.log"); writeFileSync(log, "");
    const restore = appendDuringRead(log, "late descendant violation");
    try { expect(processGuard.drainJournal(log)).toEqual([]); }
    finally { restore(); }
    const teardown = setupGlobalGuard({ config: { env: { AGEND_TEST_GUARD_DIR: directory } } });
    const saved = process.exitCode;
    try { expect(teardown).toThrow("late descendant violation"); }
    finally { process.exitCode = saved; }
    expect(processGuard.drainJournal(log)).toEqual([]);
  });
});

describe("deliberate Codex smoke runner separation", () => {
  const files = ["tests/codex-exact-cwd-resume-e2e.test.ts", "tests/codex-status-line-e2e.test.ts"];
  const source = readFileSync(resolve("vitest.config.codex-e2e.ts"), "utf8");
  function config(enabled: boolean) {
    const exports: { default?: any } = {};
    const env: Record<string, string> = { PATH: "/fixture", DISCORD_BOT_TOKEN: "fixture", AGEND_CODEX_E2E: enabled ? "1" : "0" };
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    runInNewContext(code, { exports, process: { env, once() {} }, require(name: string) {
      if (name === "vitest/config") return { defineConfig: (value: unknown) => value };
      if (name === "node:fs") return { mkdtempSync: () => "/tmp/agend-codex-fixture", rmSync() {} };
      if (name === "node:os") return { tmpdir: () => "/tmp" };
      if (name === "node:path") return { join };
      throw new Error(`Unexpected module in opt-in config: ${name}`);
    } });
    return { test: exports.default.test, env };
  }
  it("requires an explicit flag, selects only the two suites, and leaves the normal guard on", () => {
    expect(() => config(false)).toThrow("AGEND_CODEX_E2E=1");
    const { test, env } = config(true);
    expect([...test.include]).toEqual(files);
    expect(test.setupFiles).toBeUndefined();
    expect(test.globalSetup).toBeUndefined();
    expect(test.fileParallelism).toBe(false);
    expect(test.maxWorkers).toBe(1);
    expect(test.env.NOTIFY_SOCKET).toBe("");
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    const integration = readFileSync(resolve("vitest.config.integration.ts"), "utf8");
    const unit = readFileSync(resolve("vitest.config.ts"), "utf8");
    for (const file of files) {
      expect(integration.slice(0, integration.indexOf("exclude:"))).not.toContain(`"${file}"`);
      expect(integration.slice(integration.indexOf("exclude:"))).toContain(`"${file}"`);
      expect(unit).toContain(`"${file}"`);
    }
    expect(integration).toContain('setupFiles: ["./tests/setup-process-guard.ts"]');
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(pkg.scripts["test:codex-e2e"]).toBe("vitest run --config vitest.config.codex-e2e.ts");
  });
});
