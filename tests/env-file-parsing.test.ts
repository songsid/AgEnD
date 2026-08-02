import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * ~/.agend/.env is loaded at the very top of startAll(), before the web server,
 * adapters or instances exist — so every /api/ai-usage request, slash command
 * and MCP call runs with the env already in place. The gap found while
 * confirming that: `export KEY=value` (the shell-style form people paste from a
 * .bashrc) set process.env["export KEY"] and silently did nothing.
 */

const dirs: string[] = [];
const SET_KEYS = ["AGEND_TEST_PLAIN", "AGEND_TEST_EXPORTED", "AGEND_TEST_QUOTED"];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of SET_KEYS) delete process.env[k];
  delete process.env["export AGEND_TEST_EXPORTED"];
});

function loadEnv(content: string): void {
  const dir = mkdtempSync(join(tmpdir(), "agend-envfile-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".env"), content);
  const fm = new FleetManager(dir);
  (fm as unknown as { loadEnvFile(): void }).loadEnvFile();
}

describe("loadEnvFile", () => {
  it("accepts shell-style `export KEY=value` lines", () => {
    loadEnv([
      "AGEND_TEST_PLAIN=one",
      "export AGEND_TEST_EXPORTED=two",
      "export AGEND_TEST_QUOTED='three three'",
    ].join("\n"));

    expect(process.env.AGEND_TEST_PLAIN).toBe("one");
    expect(process.env.AGEND_TEST_EXPORTED).toBe("two");
    expect(process.env.AGEND_TEST_QUOTED).toBe("three three");
    // And no mangled key left behind.
    expect(process.env["export AGEND_TEST_EXPORTED"]).toBeUndefined();
  });

  it("still skips comments and blank lines", () => {
    loadEnv("# comment\n\nAGEND_TEST_PLAIN=kept\n");
    expect(process.env.AGEND_TEST_PLAIN).toBe("kept");
  });
});
