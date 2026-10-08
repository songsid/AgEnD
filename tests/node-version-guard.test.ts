/**
 * Regression tests for the Node-API 10 runtime admission guard (#1420).
 *
 * Calls the production `isNodeCompatible` function from node-version-guard.ts.
 * If that function is removed or the boundaries change, these tests turn red.
 * The CI smoke step also imports and invokes this same export to prove the
 * installed binary's production path is exercised, not a copy.
 */
import { describe, it, expect } from "vitest";
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
