/**
 * #2910 / #2929 review (Prism): the web-only e2e rig (scripts/manual/web-only-e2e) reports failure as failure. A failed
 * driver check exits non-zero (drive.mjs), `run.sh drive` returns the driver's status after showing its log, and a build
 * or setup step that fails stops `run.sh` with a non-zero status instead of saying "started". Run against a `docker`
 * stand-in on PATH (no real Docker, no CLI): it records its arguments and answers with SHIM_RC; for the driver it
 * prints a RESULT line and exits with DRIVE_RC.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = join(process.cwd(), "scripts", "manual", "web-only-e2e", "run.sh");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function rig(shimRc: number, driveRc = 0) {
  const dir = mkdtempSync(join(tmpdir(), "agend-e2e-rig-")); dirs.push(dir);
  const calls = join(dir, "calls.log");
  writeFileSync(join(dir, "docker"), `#!/bin/bash
echo "$*" >> "${calls}"
if [ "$1" = exec ] && [[ "$*" == *drive.mjs* ]]; then
  if [ "${driveRc}" = 0 ]; then echo "RESULT PASS"; else echo "| 5. a check | FAIL | x |"; echo "RESULT FAIL"; fi
  exit ${driveRc}
fi
exit ${shimRc}
`);
  chmodSync(join(dir, "docker"), 0o755);
  for (const f of ["claude", "codex"]) writeFileSync(join(dir, f), "#!/bin/sh\n");
  const run = (...args: string[]) => spawnSync("bash", [RUN, ...args], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OUT: join(dir, "out"), IMAGE: "img", CLAUDE_BIN: join(dir, "claude"), CODEX_BIN: join(dir, "codex") } });
  const calledWith = () => { try { return readFileSync(calls, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return { dir, run, calledWith };
}

describe("#2929 review: the e2e rig fails loudly", () => {
  it("start: a Docker step that fails stops it — non-zero, never 'started'; all steps succeeding: started, in a private container", () => {
    const bad = rig(37);
    const r = bad.run("start", "x");
    expect([r.status, r.stdout.includes("started"), bad.calledWith().length]).toEqual([37, false, 2]);   // rm -f (tolerated), then run -d failed
    const ok = rig(0);
    const s = ok.run("start", "x");
    expect([s.status, s.stdout.trim()]).toEqual([0, "x: started"]);
    expect(ok.calledWith().find(c => c.startsWith("run -d"))).toBe("run -d --name agend-web-only-e2e-x --network none --memory=3g --entrypoint sleep img infinity");
  });
  it("start: a missing CLI path is refused before any Docker step", () => {
    const h = rig(0);
    const r = spawnSync("bash", [RUN, "start", "x"], { encoding: "utf8", env: { ...process.env, PATH: `${h.dir}:${process.env.PATH}`, OUT: join(h.dir, "out"), IMAGE: "img" } });
    expect([r.status !== 0, /CLAUDE_BIN/.test(r.stderr), h.calledWith()]).toEqual([true, true, []]);
  });
  it("drive: the driver's RESULT FAIL is the run's status (after its log); RESULT PASS is 0", () => {
    const failing = rig(0, 1);
    const f = failing.run("drive", "x");
    expect([f.status, f.stdout.includes("RESULT FAIL"), f.stdout.trim().endsWith("drive rc=1")]).toEqual([1, true, true]);
    const passing = rig(0, 0);
    const p = passing.run("drive", "x");
    expect([p.status, p.stdout.trim().endsWith("drive rc=0")]).toEqual([0, true]);
  });
  it("build: a failed build container stops it — non-zero, no 'built'", () => {
    const h = rig(9);
    const r = h.run("build", "HEAD", "x");
    expect([r.status, r.stdout.includes("built")]).toEqual([9, false]);
  });
  it("an unknown step is refused", () => {
    expect(rig(0).run("deploy", "x").status).toBe(2);
  });
  it("the driver's verdict is its exit status", () => {
    const drive = readFileSync(join(process.cwd(), "scripts", "manual", "web-only-e2e", "drive.mjs"), "utf8");
    expect(drive.trimEnd().endsWith("process.exitCode = pass ? 0 : 1;")).toBe(true);
  });
});
