/**
 * Regression tests for the Node-API 10 runtime admission guard (#1420).
 *
 * Calls the production `isNodeCompatible` function from node-version-guard.ts.
 * If that function is removed or the boundaries change, these tests turn red.
 * The CI smoke step also imports and invokes this same export to prove the
 * installed binary's production path is exercised, not a copy.
 *
 * Bootstrap-wiring regression: the final describe block verifies that
 * cli.ts actually calls checkNodeVersion() at bootstrap — a narrow source
 * inspection combined with a functional subprocess check. Removing the call
 * turns both of those tests AssertionError-red while keeping the predicate
 * assertions syntactically and semantically valid.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isNodeCompatible } from "../src/node-version-guard.js";

describe("isNodeCompatible (Node-API 10 floor)", () => {
  // ── must reject (N-API 9 or earlier) ─────────────────────────────────────
  it.each([
    "20.0.0", "20.19.0",       // EOL Node 20 (N-API 8/9)
    "21.0.0", "21.7.0",        // Node 21 (N-API 9)
    "22.0.0", "22.13.0",       // early 22.x (N-API 9)
    "23.0.0", "23.5.9",        // early 23.x (N-API 9)
  ])("rejects Node %s", (v) => {
    expect(isNodeCompatible(v)).toBe(false);
  });

  // ── must accept (N-API 10+) ───────────────────────────────────────────────
  it.each([
    "22.14.0",                  // exact floor
    "22.15.0", "22.99.0",       // later 22.x
    "23.6.0", "23.7.0",         // floor of 23.x
    "24.0.0", "24.1.0",         // Node 24
    "26.0.0",                   // future
  ])("accepts Node %s", (v) => {
    expect(isNodeCompatible(v)).toBe(true);
  });

  it("defaults to the running process version", () => {
    // process.versions.node is always >=22.14 in CI (engines constraint).
    expect(isNodeCompatible()).toBe(true);
  });
});

const ROOT = join(import.meta.dirname ?? import.meta.url.replace(/\/[^/]+$/, ""), "..");

describe("cli.ts bootstrap wiring — functional reverse mutation", () => {
  it("cli.ts calls checkNodeVersion() at bootstrap, before Commander setup", () => {
    // Source-inspection: proves the wiring exists.
    // Removing the checkNodeVersion() call from cli.ts turns this red
    // while keeping the code syntactically/type-valid.
    const src = readFileSync(join(ROOT, "src/cli.ts"), "utf-8");
    const guardIdx = src.indexOf("checkNodeVersion()");
    const commanderIdx = src.indexOf("new Command()");
    expect(guardIdx, "cli.ts must call checkNodeVersion() at bootstrap").toBeGreaterThan(-1);
    expect(guardIdx, "checkNodeVersion() must appear before new Command()").toBeLessThan(commanderIdx);
  });

  it("dist/cli.js --version exits 1 when Node is spoofed to 22.0.0 (incompatible)", () => {
    // Functional subprocess check: runs dist/cli.js --version with a preload
    // module that overrides process.versions.node to an incompatible value.
    // If the checkNodeVersion() CALL is removed from cli.ts, the binary prints
    // a version and exits 0 — failing the expect(status).toBe(1) assertion.
    const { writeFileSync, unlinkSync, mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "agend-guard-"));
    const preload = join(tmp, "preload.cjs");
    writeFileSync(preload, `Object.defineProperty(process.versions,"node",{value:"22.0.0",configurable:true});\n`);
    try {
      const r = spawnSync(
        process.execPath,
        ["--require", preload, join(ROOT, "dist/cli.js"), "--version"],
        { encoding: "utf-8", timeout: 5000 },
      );
      // The guard must reject before printing version output.
      expect(r.status, "agend --version with Node 22.0.0 must exit 1").toBe(1);
      expect(r.stderr, "agend must print a rejection message").toMatch(/22\.14|not supported|upgrade/i);
    } finally {
      try { unlinkSync(preload); } catch {}
      try { require("node:fs").rmSync(tmp, { recursive: true }); } catch {}
    }
  });

  it("dist/cli.js --version exits 0 on compatible Node 22.14.0 (control)", () => {
    const { writeFileSync, unlinkSync, mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "agend-guard-"));
    const preload = join(tmp, "preload.cjs");
    writeFileSync(preload, `Object.defineProperty(process.versions,"node",{value:"22.14.0",configurable:true});\n`);
    try {
      const r = spawnSync(
        process.execPath,
        ["--require", preload, join(ROOT, "dist/cli.js"), "--version"],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(r.status, "agend --version with Node 22.14.0 must exit 0").toBe(0);
    } finally {
      try { unlinkSync(preload); } catch {}
      try { require("node:fs").rmSync(tmp, { recursive: true }); } catch {}
    }
  });
});
