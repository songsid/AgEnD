/**
 * #2725: the guard on tests/setup-test-logger.ts — no test's logger lets a late writer into a scratch home.
 *
 *  - A FleetManager built on a scratch AGEND_HOME, logging, leaves the scratch tree as it was 300 ms later (pino's
 *    transport worker used to open <scratch>/daemon.log then, while the test's afterEach removed it: ENOTEMPTY).
 *  - Both vitest configs load the setup.
 *  - A file whose logger is real again — `vi.unmock`/`vi.doUnmock` of logger.js, or its own logger.js mock that leaves
 *    createLogger out (importOriginal hands it the real one) — is an explicit, listed opt-in, and never points
 *    AGEND_HOME anywhere: its transport writes into the run's own test home, which outlives every test.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Files that test the logger's real transport, and why. */
const REAL_LOGGER: Record<string, string> = {
  "tests/logger-shared-transport.test.ts": "the shared transport itself: one worker, no exit-listener leak",
};

let dir: string;
afterEach(() => { vi.unstubAllEnvs(); if (dir) rmSync(dir, { recursive: true, force: true }); });
const tree = (d: string): string[] => readdirSync(d, { recursive: true }).map(String).sort();

describe("a scratch-home fleet writes nothing after its work", () => {
  it("a FleetManager on a scratch AGEND_HOME logs, and 300 ms later the scratch tree is unchanged (no daemon.log)", async () => {
    dir = mkdtempSync(join(tmpdir(), "agend-2725-"));
    vi.stubEnv("AGEND_HOME", dir);
    vi.resetModules(); // logger.ts as a test that stubs AGEND_HOME first and imports the fleet after loads it
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir) as unknown as { logger: { info(o: object, m: string): void; warn(o: object, m: string): void } };
    fm.logger.info({ probe: 2725 }, "guard probe");
    fm.logger.warn({ probe: 2725 }, "guard probe");
    const after = tree(dir);
    await new Promise(r => setTimeout(r, 300));
    expect(tree(dir), "a late writer reached the scratch home").toEqual(after);
    expect(after).not.toContain("daemon.log");
  });
});

describe("every test runs on the shared silent logger unless it is a listed opt-in", () => {
  const root = process.cwd();
  it("both vitest configs load tests/setup-test-logger.ts", () => {
    for (const config of ["vitest.config.ts", "vitest.config.integration.ts"]) {
      expect(readFileSync(join(root, config), "utf8"), config).toMatch(/setupFiles:\s*\[[^\]]*"\.\/tests\/setup-test-logger\.ts"/);
    }
  });

  it("a real logger only where listed, and never with a moved AGEND_HOME", () => {
    const files = readdirSync(join(root, "tests"), { recursive: true }).map(String)
      .filter(f => /\.(?:test\.)?[cm]?ts$/.test(f) && !f.startsWith("fixtures")).map(f => `tests/${f}`)
      .filter(f => f !== "tests/setup-test-logger.ts" && f !== relative(root, __filename));
    const real: string[] = [];
    for (const file of files) {
      const src = readFileSync(join(root, file), "utf8");
      const unmocked = /vi\.(?:unmock|doUnmock)\(\s*["'](?:\.\.\/)+src\/logger\.js["']/.test(src);
      const ownMockKeepsReal = [...src.matchAll(/vi\.(?:mock|doMock)\(\s*["'](?:\.\.\/)+src\/logger\.js["']/g)]
        .some(m => !/\bcreateLogger\b/.test(src.slice(m.index!, m.index! + 800)));
      if (unmocked || ownMockKeepsReal) real.push(file);
    }
    expect(real.sort(), "a file with the real logger must be listed in REAL_LOGGER, with why").toEqual(Object.keys(REAL_LOGGER).sort());
    for (const file of real) {
      expect(readFileSync(join(root, file), "utf8"), `${file} has the real logger: it must not move AGEND_HOME`)
        .not.toMatch(/stubEnv\(\s*["']AGEND_HOME["']|process\.env\.AGEND_HOME\s*=(?!=)|AGEND_HOME:/);
    }
  });
});
