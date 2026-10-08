import { spawn, spawnSync, exec, execSync, execFile, execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTestProcess, processGuard, registerExecutableFixture, scrubTestEnvironment } from "./support/process-guard.js";

const dirs: string[] = [];
function fake(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-process-guard-")); dirs.push(dir);
  const file = join(dir, name), marker = join(dir, "started");
  // Even reverse mutants can only start this inert fixture, never real tmux/CLI.
  writeFileSync(file, `#!/bin/sh\nprintf started > '${marker}'\n`); chmodSync(file, 0o700);
  return { file, marker };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function blocked(action: () => unknown, marker: string, message: RegExp) {
  expect(action).toThrow(message);
  expect(existsSync(marker)).toBe(false);
  expect(processGuard.takeViolations()).toEqual([expect.stringMatching(message)]);
}

describe("global native process guard", () => {
  it.each(["claude", "codex", "kiro-cli", "grok", "muse", "agy", "opencode"])("blocks real %s before any spawn, even on an absolute path", name => {
    const { file, marker } = fake(name);
    blocked(() => execFileSync(file), marker, /real backend CLI forbidden/);
  });
  it.each(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"])("covers %s, both builtin spellings, and swallowed errors", api => {
    const { file, marker } = fake("codex");
    const cp = createRequire(import.meta.url)("child_process");
    const action = () => api === "exec" || api === "execSync" ? cp[api](`exec '${file}'`) : cp[api](file, []);
    blocked(action, marker, /real backend CLI forbidden/);
    vi.restoreAllMocks();
    blocked(action, marker, /real backend CLI forbidden/);
  });
  it("blocks socketless tmux even when the caller catches the exception", () => {
    const { file, marker } = fake("tmux");
    try { execFileSync(file, ["new-session", "-d"]); } catch { /* production often catches */ }
    expect(existsSync(marker)).toBe(false);
    expect(processGuard.takeViolations()).toEqual([expect.stringContaining("private test socket")]);
  });
  it("requires a test socket and rejects backend launch payloads on private sockets", () => {
    for (const args of [[], ["-L", "agend"], ["-L", "default"], ["-S", "/tmp/tmux-1000/default"], ["-L", "agend-test-x", "-S", "/tmp/tmux-1000/default"]]) {
      expect(() => checkTestProcess("tmux", args)).toThrow(/private test socket/);
    }
    expect(() => checkTestProcess("tmux", ["-L", "agend-test-x", "new-session", "sleep 5"])).not.toThrow();
    expect(() => checkTestProcess("tmux", ["-L", "agend-test-x", "capture-pane", "-S", "-60"])).not.toThrow();
    expect(() => checkTestProcess("tmux", ["capture-pane", "-L", "agend-test-x"])).toThrow(/private test socket/);
    expect(() => checkTestProcess("tmux", ["-S", join(tmpdir(), "agend-fixture-ab", "sock"), "kill-server"])).not.toThrow();
    for (const args of [["new-window", "codex --dangerously-bypass-approvals-and-sandbox"], ["send-keys", "claude", "Enter"]]) {
      expect(() => checkTestProcess("tmux", ["-L", "agend-test-x", ...args])).toThrow(/real backend CLI forbidden/);
    }
  });
  it("blocks shell and Node-entry wrappers, allowing binary discovery without execution", () => {
    for (const [file, args] of [["bash", ["-lc", "HOME=/tmp exec /usr/bin/kiro-cli chat"]], ["sh", ["-c", "true; env codex"]], ["bash", ["-lc", "exec -a agent /bin/codex"]], ["sh", ["-c", "timeout 5 codex"]], ["node", ["/usr/local/lib/codex/bin/codex", "--version"]]] as const) {
      expect(() => checkTestProcess(file, [...args])).toThrow(/real backend/);
    }
    expect(() => checkTestProcess("bash", ["-lc", "command -v codex"])).not.toThrow();
    expect(() => checkTestProcess("which", ["codex"])).not.toThrow();
  });
  it("guards a Node descendant even if its env explicitly clears NODE_OPTIONS", () => {
    const { file, marker } = fake("codex");
    const child = spawnSync(process.execPath, ["-e", `require('child_process').execFileSync(${JSON.stringify(file)})`], {
      encoding: "utf8", env: { PATH: process.env.PATH, NODE_OPTIONS: "" }, timeout: 5000,
    });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("real backend CLI forbidden");
    expect(existsSync(marker)).toBe(false);
    expect(processGuard.takeViolations()).toEqual([expect.stringContaining("real backend CLI forbidden")]);
  });
  it("guards native worker realms with explicitly overridden execArgv", async () => {
    const { file, marker } = fake("codex");
    const worker = new Worker(`require('child_process').execFileSync(${JSON.stringify(file)})`, { eval: true, execArgv: [] });
    let error: Error | undefined;
    worker.once("error", value => { error = value as Error; });
    const status = await new Promise<number>(resolve => worker.once("exit", resolve));
    expect(status).not.toBe(0);
    expect(error?.message).toContain("real backend CLI forbidden");
    expect(existsSync(marker)).toBe(false);
    expect(processGuard.takeViolations()).toEqual([expect.stringContaining("real backend CLI forbidden")]);
  });
  it.each([false, true])("fails a nested runner for a caught unsafe call (collection-only=%s)", collectionOnly => {
    const { file, marker } = fake("codex");
    const directory = dirname(file);
    const config = join(directory, "vitest.config.mjs");
    const setup = resolve("tests/setup-process-guard.ts");
    const globalSetup = resolve("tests/setup-process-guard-global.ts");
    const fixture = join(directory, "guard.test.ts");
    const attempt = `try { execFileSync(${JSON.stringify(file)}); } catch {}`;
    writeFileSync(fixture, `import {it} from 'vitest';\nimport {execFileSync} from 'node:child_process';\n${collectionOnly ? `${attempt}; it.skip('collection guard', () => {});` : `it('caught call', () => { ${attempt} });`}`);
    writeFileSync(config, `export default {test:{root:${JSON.stringify(directory)},include:['guard.test.ts'],setupFiles:[${JSON.stringify(setup)}],globalSetup:[${JSON.stringify(globalSetup)}],env:{AGEND_TEST_GUARD_DIR:${JSON.stringify(directory)}}}};`);
    // Use the installed test runner, with an entirely private fixture/journal.
    // Even a disabled guard can only launch the inert fake above.
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
    const child = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config, "--maxWorkers=1"], {
      encoding: "utf8", timeout: 20_000, env: { ...process.env, AGEND_TEST_GUARD_LOG: "" },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).not.toBe(0);
    expect(child.stdout + child.stderr).toContain("real backend CLI forbidden");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
  it("only permits explicitly registered immutable fixture bytes", () => {
    const { file, marker } = fake("codex");
    registerExecutableFixture(file);
    execFileSync(file);
    expect(existsSync(marker)).toBe(true);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    blocked(() => execFileSync(file), marker + "-never", /real backend CLI forbidden/);
  });
  it("scrubs inherited tokens before imports, preserving explicitly injected test fixtures", () => {
    const env = { DISCORD_BOT_TOKEN: "private", AGEND_BOT_ALPHA: "private", api_TOKEN: "private", PATH: "/bin", TOKENIZER: "keep" };
    scrubTestEnvironment(env);
    expect(env).toEqual({ PATH: "/bin", TOKENIZER: "keep" });
    // The config scrubs the parent; setup does not continuously erase synthetic tokens.
    process.env.SYNTHETIC_BOT_TOKEN = "fixture";
    expect(process.env.SYNTHETIC_BOT_TOKEN).toBe("fixture");
    delete process.env.SYNTHETIC_BOT_TOKEN;
  });
});
