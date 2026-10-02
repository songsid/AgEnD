import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const filterUrl = new URL("../src/node-warnings.ts", import.meta.url).href;

function run(source: string, flags: string[] = [], extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-warnings-")); dirs.push(root);
  return spawnSync(process.execPath, [...flags, "--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(), encoding: "utf8", timeout: 8_000,
    env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "", AGEND_HOME: root, ...extraEnv },
  });
}

describe("targeted punycode warning filter", () => {
  it("suppresses DEP0040 in all warning forms and preserves other warning events and stderr", () => {
    const child = run(`
      await import(${JSON.stringify(filterUrl)});
      const seen = [];
      process.on("warning", warning => seen.push([warning.code, warning.name, warning.message]));
      // Real Node warning and all documented emitWarning overloads.
      await import("node:punycode");
      process.emitWarning("punycode legacy", "DeprecationWarning", "DEP0040");
      process.emitWarning("punycode options", { type: "DeprecationWarning", code: "DEP0040" });
      process.emitWarning(Object.assign(new Error("punycode error"), { name: "DeprecationWarning", code: "DEP0040" }));
      for (let i = 0; i < 2; i++) process.emitWarning("other deprecation", { type: "DeprecationWarning", code: "DEP_TEST", detail: "keep detail" });
      process.emitWarning("other warning", "ExperimentalWarning", "EXP_TEST");
      // An Error's own code/type take precedence over optional arguments.
      process.emitWarning(Object.assign(new Error("own error"), { code: "ERR_TEST" }), { type: "DeprecationWarning", code: "DEP0040" });
      function warningCtor() { process.emitWarning("ctor warning", warningCtor); }
      warningCtor();
      console.error("ordinary-error");
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify(seen));
    `);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).not.toContain("[DEP0040]");
    expect(child.stderr.match(/\[DEP_TEST\]/g)).toHaveLength(2);
    expect(child.stderr).toContain("keep detail");
    expect(child.stderr).toContain("[EXP_TEST] ExperimentalWarning: other warning");
    expect(child.stderr).toContain("[ERR_TEST] Error: own error");
    expect(child.stderr).toContain("Warning: ctor warning");
    expect(child.stderr).toContain("ordinary-error");
    expect(JSON.parse(child.stdout)).toEqual([
      ["DEP_TEST", "DeprecationWarning", "other deprecation"],
      ["DEP_TEST", "DeprecationWarning", "other deprecation"],
      ["EXP_TEST", "ExperimentalWarning", "other warning"],
      ["ERR_TEST", "Error", "own error"],
      [null, "Warning", "ctor warning"],
    ]);
  });

  it("preserves explicit --throw-deprecation exception behavior", () => {
    const child = run(`await import(${JSON.stringify(filterUrl)}); await import("node:punycode");`, ["--throw-deprecation"]);
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("code: 'DEP0040'");
  });

  it.each(["cli", "channel/mcp-server"])("installs the filter in the actual %s entry point", async entry => {
    const root = mkdtempSync(join(tmpdir(), "agend-warning-entry-")); dirs.push(root);
    writeFileSync(join(root, "daemon.log"), "log-viewer-probe\n");
    const entryUrl = new URL(`../src/${entry}.ts`, import.meta.url).href;
    const source = `
      process.execArgv = [];
      process.argv = [process.execPath, ${JSON.stringify(entryUrl)}, "logs"];
      await import(${JSON.stringify(entryUrl)});
      await import("node:punycode");
      process.emitWarning("entry-other-warning", { code: "ENTRY_TEST" });
      await new Promise(resolve => setImmediate(resolve));
      console.log("warning-entry-probe-done");
    `;
    // Keep MCP stdin open: EOF intentionally terminates that entry point.
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "", AGEND_HOME: root, AGEND_SOCKET_PATH: join(root, "missing.sock") },
    });
    const exited = once(child, "exit");
    let stdout = ""; let stderr = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`warning entry probe timed out: ${stdout}; ${stderr}`)), 7_000);
        const check = () => {
          if (stdout.includes("warning-entry-probe-done") && stderr.includes("[ENTRY_TEST]")) { clearTimeout(timer); resolve(); }
        };
        child.stdout.on("data", chunk => { stdout += chunk; check(); });
        child.stderr.on("data", chunk => { stderr += chunk; check(); });
        child.once("error", reject);
        child.once("exit", code => {
          clearTimeout(timer);
          if (!stdout.includes("warning-entry-probe-done")) reject(new Error(`entry exited ${code}: ${stderr}`));
        });
      });
      expect(stderr).not.toContain("[DEP0040]");
      expect(stderr).toContain("[ENTRY_TEST] Warning: entry-other-warning");
      if (entry === "cli") expect(stdout).toContain("log-viewer-probe");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    }
  });
});
