/**
 * #2725: the guard on tests/setup-test-logger.ts — no test's logger lets a late writer into a scratch home.
 *
 *  - The shared sink: a FleetManager built on a scratch AGEND_HOME, logging, leaves the scratch tree as it was 300 ms
 *    later (pino's transport worker used to open <scratch>/daemon.log then, while the test's afterEach removed it).
 *  - The tripwire: whatever brings the real logger back — the forms a reviewer found a text scan could not tell apart
 *    (#2727 review) are run here for real — a transport writing outside this run's test home throws when it is built,
 *    and nothing lands in the scratch home. A real transport into the run's own test home is still allowed.
 *  - Both vitest configs load the setup.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTransportTripwire, strayTransportFiles } from "./support/test-logger-tripwire.js";

let dir: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const tree = (d: string): string[] => readdirSync(d, { recursive: true }).map(String).sort();
const settle = () => new Promise(r => setTimeout(r, 300));
/** A scratch AGEND_HOME, as the flaky tests stub it before the fleet's modules load. */
function scratchHome(): string {
  dir = mkdtempSync(join(tmpdir(), "agend-2725-"));
  vi.stubEnv("AGEND_HOME", dir);
  vi.resetModules();
  return dir;
}

describe("the shared sink: a scratch-home fleet writes nothing after its work", () => {
  it("a FleetManager on a scratch AGEND_HOME logs, and 300 ms later the scratch tree is unchanged (no daemon.log)", async () => {
    const home = scratchHome();
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(home) as unknown as { logger: { info(o: object, m: string): void; warn(o: object, m: string): void } };
    fm.logger.info({ probe: 2725 }, "guard probe");
    fm.logger.warn({ probe: 2725 }, "guard probe");
    const after = tree(home);
    await settle();
    expect(tree(home), "a late writer reached the scratch home").toEqual(after);
    expect(after).not.toContain("daemon.log");
  }, 60_000); // a cold import of the whole fleet after resetModules
});

describe("the tripwire: the real logger back by any means, on a scratch home, never writes there", () => {
  /** Each a way a test file can end up with logger.ts's own createLogger (the #2727 review's forms among them). */
  const forms: Array<[string, () => Promise<{ createLogger: (level?: string) => unknown }>]> = [
    ["vi.importActual", () => vi.importActual<typeof import("../src/logger.js")>("../src/logger.js")],
    ["a passthrough factory's spread (import() form)", async () => {
      const original = () => vi.importActual<typeof import("../src/logger.js")>("../src/logger.js");
      return { ...await original() };
    }],
    ["a passthrough factory that calls createLogger after its spread", async () => {
      const exposed = { ...await vi.importActual<typeof import("../src/logger.js")>("../src/logger.js") };
      return exposed;
    }],
  ];
  for (const [label, real] of forms) {
    it(`${label}: building its transport throws, and the scratch home stays as it was`, async () => {
      const home = scratchHome();
      const { createLogger } = await real();
      const before = tree(home);
      expect(() => createLogger("silent")).toThrow(/#2725: a test built a real logger transport writing .*daemon\.log/);
      await settle();
      expect(tree(home)).toEqual(before);
      expect(tree(home)).not.toContain("daemon.log");
    });
  }

  it("a scratch home made INSIDE the run's test home (#2727 review r3) is still a scratch home: refused", async () => {
    dir = mkdtempSync(join(process.env.AGEND_TEST_GUARD_DIR!, "scratch-"));
    vi.stubEnv("AGEND_HOME", dir);
    vi.resetModules();
    const { createLogger } = await vi.importActual<typeof import("../src/logger.js")>("../src/logger.js");
    expect(() => createLogger("silent")).toThrow(/#2725: a test built a real logger transport writing .*scratch-.*daemon\.log/);
    await settle();
    expect(tree(dir)).not.toContain("daemon.log");
  });

  it("the real transport into this run's own test home is still built (the opt-in logger-shared-transport uses it)", async () => {
    vi.resetModules();
    const { createLogger } = await vi.importActual<typeof import("../src/logger.js")>("../src/logger.js");
    const logger = createLogger("silent") as unknown as Record<symbol, { constructor: { name: string } }>;
    expect(logger[pino.symbols.streamSym]!.constructor.name).toBe("ThreadStream");
  });

  it("which files count as stray: outside the test home, through `..`, or through a symlink out of it", () => {
    const home = mkdtempSync(join(tmpdir(), "agend-2725-home-"));
    const outside = mkdtempSync(join(tmpdir(), "agend-2725-out-"));
    try {
      symlinkSync(outside, join(home, "link"));
      const t = (destination: string) => ({ targets: [{ options: { destination } }, { options: { destination: 1 } }] });
      expect(strayTransportFiles(t(join(home, "daemon.log")), home)).toEqual([]);
      expect(strayTransportFiles(t(join(home, "sub", "daemon.log")), home), "inside the home is not enough: a test may remove sub/").toHaveLength(1);
      expect(strayTransportFiles(t(join(home, "other.log")), home), "only the run's daemon.log").toHaveLength(1);
      expect(strayTransportFiles(t(join(home, ".", "daemon.log")), home), "the same file, spelled differently").toEqual([]);
      symlinkSync(home, join(outside, "home-link"));
      expect(strayTransportFiles(t(join(outside, "home-link", "daemon.log")), home), "the same file through a symlink to the home").toEqual([]);
      expect(strayTransportFiles(t(join(outside, "daemon.log")), home)).toEqual([join(outside, "daemon.log")]);
      expect(strayTransportFiles(t(join(home, "..", "x", "daemon.log")), home)).toHaveLength(1);
      expect(strayTransportFiles(t(join(home, "link", "daemon.log")), home), "a symlink out of the home is out").toHaveLength(1);
      expect(strayTransportFiles({ target: "pino-pretty", options: { destination: join(outside, "d.log") } }, home)).toHaveLength(1);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it("the wrapper is pino's own transport function, wrapped once per worker", () => {
    const wrapped = pino.transport;
    expect((wrapped as unknown as Record<symbol, unknown>)[Symbol.for("agend.test.transportTripwire")]).toBe(true);
    installTransportTripwire(); // every test file's setup runs it again in the same worker
    expect(pino.transport, "a second install must not wrap the wrapper").toBe(wrapped);
  });
});

describe("both vitest configs load the setup", () => {
  it("vitest.config.ts and vitest.config.integration.ts list tests/setup-test-logger.ts", () => {
    for (const config of ["vitest.config.ts", "vitest.config.integration.ts"]) {
      expect(readFileSync(join(process.cwd(), config), "utf8"), config).toMatch(/setupFiles:\s*\[[^\]]*"\.\/tests\/setup-test-logger\.ts"/);
    }
  });
});
