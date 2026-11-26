// M-3770 2.5: what the recovery runner will call — the home restore, fleet.lock's record functions, the writers'
// proof — bundles the way recover.cjs does (scripts/build-recover.mjs: node built-ins external, nothing else) and
// LOADS from outside the repository: no native module (SQLite), no launcher file read at module load.
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const out = mkdtempSync(join(tmpdir(), "closure-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("M-3770 2.5: the runner's modules bundle closed and load alone", () => {
  it("update-restore, fleet-lock, update-writers, the rollback and abandon drivers, and recover.ts with its runner: built-ins only, and the bundle loads and runs from a temp dir", async () => {
    const src = join(process.cwd(), "src");
    const entry = join(out, "entry.ts");
    writeFileSync(entry, [
      `export { restoreHome } from ${JSON.stringify(join(src, "update-restore.ts"))};`,
      `export { readFleetLockRecord, retakeDeadFleetLock, setFleetLockHandoff } from ${JSON.stringify(join(src, "fleet-lock.ts"))};`,
      `export { proveWritersGone } from ${JSON.stringify(join(src, "update-writers.ts"))};`,
      `export { rollBack } from ${JSON.stringify(join(src, "update-rollback.ts"))};`,
      `export { abandonAttempt } from ${JSON.stringify(join(src, "update-abandon.ts"))};`,
      `export { realHands } from ${JSON.stringify(join(src, "update-recovery", "recover.ts"))};`,
    ].join("\n"));
    const bundle = join(out, "bundle.cjs");
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs", target: "node22",
      external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)], logLevel: "silent" });
    const text = readFileSync(bundle, "utf8");
    const required = [...text.matchAll(/require\(["']([^"']+)["']\)/g)].map(m => m[1]!);
    for (const name of required) expect(name, `bundle requires ${name}`).toMatch(/^(node:)?[a-z_]+(\/[a-z_]+)?$/);
    expect(text).not.toMatch(/better-sqlite3|\.node["']/);
    const home = mkdtempSync(join(out, "home-"));
    writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid: 42, nonce: "a".repeat(32), createdAt: "2026-11-26T00:00:00Z", role: "fleet" }) + "\n");
    const run = spawnSync(process.execPath, ["-e", `const m = require(${JSON.stringify(bundle)}); console.log(JSON.stringify(m.readFleetLockRecord(${JSON.stringify(home)})))`],
      { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ pid: 42, role: "fleet" });
  }, 60_000);
});
