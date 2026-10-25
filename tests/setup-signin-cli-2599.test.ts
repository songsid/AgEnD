/** Capability detection must never start setup or clear its completed marker. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { markSetupComplete, isSetupComplete } from "../src/setup-marker.js";
it("prints capabilities before --reset, with no listener, login child or marker mutation", () => {
  const home = mkdtempSync(join(tmpdir(), "agend-signin-cap-"));
  try {
    markSetupComplete(home); const before = readdirSync(home).sort();
    const result = execFileSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "src/cli.ts", "setup", "--reset", "--backend-signin-capabilities"],
      { encoding: "utf8", timeout: 15_000, env: { ...process.env, AGEND_HOME: home } });
    expect(JSON.parse(result)).toEqual({ version: 1, setup: true, dashboard: true, installer: true, backends: ["kiro-cli", "claude-code", "codex"], console: ["antigravity"] });
    expect(isSetupComplete(home)).toBe(true); expect(readdirSync(home).sort()).toEqual(before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
