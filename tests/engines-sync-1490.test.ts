/**
 * #1490 P3: ENGINES string must not drift between package.json and the files
 * that hard-code it.
 *
 * package.json is the single source of truth. The same version constraint
 * appears in three places:
 *   1. package.json                   engines.node  (source of truth)
 *   2. scripts/preinstall-guard.cjs   var ENGINES = "…"
 *   3. src/node-version-guard.ts      isNodeCompatible() boundary checks
 *
 * Changing any one of them without the others should make this test fail.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isNodeCompatible } from "../src/node-version-guard.js";

const ROOT = join(import.meta.dirname, "..");

// ── helpers ──────────────────────────────────────────────────────────────────

function packageEngines(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const v = pkg.engines?.node;
  if (!v) throw new Error("package.json missing engines.node");
  return v;
}

/**
 * Parse each disjunction from "^22.14.0 || ^23.6.0 || >=24" into
 * { major, minor, patch } tuples.
 */
function parseEnginesBoundaries(engines: string): Array<{ major: number; minor: number; patch: number }> {
  return engines.split(/\s*\|\|\s*/).map(part => {
    const clean = part.replace(/^[\^>=~]+/, "").trim();
    const [maj = "0", min = "0", patch = "0"] = clean.split(".");
    return { major: parseInt(maj, 10), minor: parseInt(min, 10), patch: parseInt(patch, 10) };
  });
}

/**
 * Return the version string for a boundary: "major.minor.patch".
 */
function versionStr({ major, minor, patch }: { major: number; minor: number; patch: number }): string {
  return `${major}.${minor}.${patch}`;
}

/**
 * Return a version string that is below ALL disjunctions simultaneously.
 * For each boundary b, the universal "just below" is the version with the
 * lowest minor or patch that none of the disjunctions accept.
 *
 * Strategy: for each boundary, compute "just below that specific major.minor":
 * - For >=24 (minor=0): major-1 with a very old minor (e.g. "23.5.0")
 *   — only if major-1.minor is also below all other disjunctions
 * - For ^22.14.0: "22.13.9" is below this one AND not covered by >=24 / ^23.6.0
 * - For ^23.6.0: "23.5.0" is below this one AND not covered by >=24 / ^22.14.0
 *
 * We directly compute: the "just below" for boundary b is:
 *   minor > 0 → major.minor-1.9  (lower minor of same major)
 *   minor = 0 → major-1.0.0      (lower major)
 *
 * Then we verify that this version is indeed rejected by isNodeCompatible
 * (which respects ALL disjunctions together).
 */
function justBelowOneOnly(b: { major: number; minor: number; patch: number }): string | null {
  if (b.minor > 0) {
    // e.g. 22.14 → 22.13.9   (rejected by all: not >=22.14, not >=23.6, not >=24)
    return `${b.major}.${b.minor - 1}.9`;
  }
  // e.g. >=24 (minor=0): the "just below" would be 23.x.x, but 23.6+ is accepted.
  // We can't make a version that's just below >=24 while also below ^23.6.0,
  // without being very specific. Return null to skip this case.
  return null;
}

// ── 1. preinstall-guard.cjs ENGINES constant matches package.json ──────────
//
// Reverse mutation: changing var ENGINES = "…" in preinstall-guard.cjs to any
// other string makes this test fail because the comparison is exact.

describe("ENGINES constant sync (#1490 P3)", () => {
  it("scripts/preinstall-guard.cjs ENGINES matches package.json engines.node exactly", () => {
    const expected = packageEngines();

    const guardSrc = readFileSync(join(ROOT, "scripts", "preinstall-guard.cjs"), "utf8");
    const match = guardSrc.match(/var\s+ENGINES\s*=\s*"([^"]+)"/);
    expect(match, "ENGINES constant not found in preinstall-guard.cjs").toBeTruthy();

    expect(match![1]).toBe(expected);
  });

  // ── 2. isNodeCompatible() boundary matches package.json engines.node ──────
  //
  // We call the real isNodeCompatible() with exactly the minimum acceptable
  // version from each engines.node disjunction.
  // The function must return true at each boundary.
  // For each boundary where a "just below" is unambiguous, we also verify false.
  //
  // Reverse mutation: changing `min >= 14` to `min >= 15` in isNodeCompatible()
  // makes isNodeCompatible("22.14.0") return false, failing this test.

  it("isNodeCompatible() accepts exactly each minimum version from package.json engines.node", () => {
    const engines = packageEngines();
    const boundaries = parseEnginesBoundaries(engines);

    for (const b of boundaries) {
      const atBoundary = versionStr(b);

      expect(
        isNodeCompatible(atBoundary),
        `isNodeCompatible("${atBoundary}") should be true (boundary from engines "${engines}")`,
      ).toBe(true);

      const below = justBelowOneOnly(b);
      if (below !== null) {
        expect(
          isNodeCompatible(below),
          `isNodeCompatible("${below}") should be false (just below boundary for ${atBoundary})`,
        ).toBe(false);
      }
    }
  });
});
