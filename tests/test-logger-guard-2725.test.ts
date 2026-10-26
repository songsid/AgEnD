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

/** Comments out, string and template contents kept as they are (good enough for these few files' mock calls). */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/** The text of the call whose "(" is at `open`, through its matching ")". Unbalanced: the rest of the file. */
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { const end = src.indexOf(c, i + 1); if (end < 0) break; i = end; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/**
 * Whether a test file's logger is the real one again. Fail closed (#2727 review): any vi.mock / vi.doMock / vi.unmock /
 * vi.doUnmock / vi.importActual / importOriginal-like target naming logger.js — a quoted path or `import("…")` — counts
 * as real unless it is a mock whose factory itself sets createLogger after its last spread (comments ignored). An
 * unmock or importActual of it is always real.
 */
function keepsRealLogger(source: string): boolean {
  const src = code(source);
  const target = /vi\s*\.\s*(mock|doMock|unmock|doUnmock|importActual)\s*(?:<[^>]*>)?\s*\(\s*(?:import\s*\(\s*)?["'`][^"'`]*logger(?:\.[cm]?[jt]s)?["'`]/g;
  for (const m of src.matchAll(target)) {
    if (m[1] !== "mock" && m[1] !== "doMock") return true;
    const call = callText(src, src.indexOf("(", m.index! + m[0].indexOf(m[1]!)));
    const override = [...call.matchAll(/\bcreateLogger\s*[:(]/g)].at(-1)?.index ?? -1;
    const spread = [...call.matchAll(/\.\.\./g)].at(-1)?.index ?? -1;
    if (override < 0 || spread > override) return true;
  }
  return false;
}

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
  }, 60_000); // a cold import of the whole fleet after resetModules
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
    const real = files.filter(file => keepsRealLogger(readFileSync(join(root, file), "utf8")));
    expect(real.sort(), "a file with the real logger must be listed in REAL_LOGGER, with why").toEqual(Object.keys(REAL_LOGGER).sort());
    for (const file of real) {
      expect(readFileSync(join(root, file), "utf8"), `${file} has the real logger: it must not move AGEND_HOME`)
        .not.toMatch(/stubEnv\(\s*["']AGEND_HOME["']|process\.env\.AGEND_HOME\s*=(?!=)|AGEND_HOME:/);
    }
  });
});

describe("the scan reads every way a file can get the real logger back (#2727 review)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["the shared sink, untouched", `import { createLogger } from "../src/logger.js";`, false],
    ["vi.unmock", `vi.unmock("../src/logger.js");`, true],
    ["vi.doUnmock", `vi.doUnmock("../src/logger.js");`, true],
    ["vi.importActual", `const real = await vi.importActual<typeof import("../src/logger.js")>("../src/logger.js");`, true],
    ["a passthrough mock, quoted", `vi.mock("../src/logger.js", async original => ({ ...await original() }));`, true],
    ["a passthrough mock, import() form", `vi.mock(import("../src/logger.js"), async original => ({ ...await original() }));`, true],
    ["a passthrough mock, deeper path", `vi.mock("../../src/logger.js", async o => ({ ...await o() }));`, true],
    ["createLogger only in a comment", `vi.mock("../src/logger.js", async o => ({ ...await o() /* createLogger: kept */ }));`, true],
    ["createLogger only used later in the file", `vi.mock("../src/logger.js", async o => ({ ...await o() }));\nconst l = createLogger("x");`, true],
    ["createLogger set, then a spread over it", `vi.mock("../src/logger.js", async o => ({ createLogger: () => sink, ...await o() }));`, true],
    ["createLogger set after the spread", `vi.mock("../src/logger.js", async o => ({ ...await o(), createLogger: () => sink }));`, false],
    ["import() form, createLogger set after the spread", `vi.mock(import("../src/logger.js"), async o => ({ ...await o(), createLogger: () => sink }));`, false],
    ["a full replacement with createLogger", `vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn() }) }));`, false],
    ["another module's mock", `vi.mock("../src/fleet-manager.js", async o => ({ ...await o() }));`, false],
  ];
  for (const [label, src, real] of cases) it(`${label}: ${real ? "real" : "sink"}`, () => expect(keepsRealLogger(src)).toBe(real));
});
