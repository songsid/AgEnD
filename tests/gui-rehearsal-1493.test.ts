/**
 * #1493 review: the Mac GUI-domain rehearsal (scripts/ci/runtime-acceptance/gui-rehearsal.sh) is a GATE on the
 * 2.1.12 → candidate hop. Its verdict comes right after the old updater, before anything else touches the service: the
 * updater must have installed the candidate, exited 0 and consumed the planned activation. An updater that installs but
 * fails its activation — exit 1, or exit 0 with the plan left behind — fails the rehearsal; nothing repairs it first.
 * The real script runs here with inert npm / launchctl / curl / agend stubs (no service, fleet or install).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "ci", "runtime-acceptance", "gui-rehearsal.sh");
const CAND = "2.2.0-acceptance.1";
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function rehearse(updater: { rc: number; leavesPlan: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "agend-gui-1493-"));
  roots.push(root);
  const bin = join(root, "bin"), home = join(root, "home"), pkgs = join(root, "packages"), temp = join(root, "temp");
  for (const d of [bin, home, pkgs, join(temp, "registry")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(pkgs, "candidate.json"), JSON.stringify({ version: CAND, pin: "22.23.3", tarballs: [] }));
  writeFileSync(join(temp, "registry", "npmrc"), "");
  const calls = join(root, "calls"), state = join(root, "installed");
  writeFileSync(state, "2.1.12");
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("npm", "exit 0");
  stub("curl", "printf 200");
  stub("launchctl", `[ "$1" = print ] && { printf '\\tstate = running\\n\\tpid = 4242\\n\\tprogram = /x/node\\n'; exit 0; }\nexit 0`);
  stub("agend", [
    `case "$1" in`,
    `  --version) cat '${state}' ;;`,
    `  install) exit 0 ;;`,
    // The old updater: installs the candidate, then its activation comes out as the case says.
    `  update) echo '${CAND}' > '${state}'; echo "  ✓ Installed: $3";`,
    updater.leavesPlan ? `    mkdir -p '${home}/.agend' && echo '{}' > '${home}/.agend/service-plan.json';` : "",
    `    exit ${updater.rc} ;;`,
    `  restart) exit 0 ;;`,
    `esac`,
  ].join("\n"));
  const r = spawnSync("bash", [SCRIPT, pkgs], {
    encoding: "utf8", timeout: 60_000,
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, RUNNER_TEMP: temp },
  });
  const log = existsSync(calls) ? readFileSync(calls, "utf8") : "";
  return { status: r.status, out: r.stdout + r.stderr, restarts: log.split("\n").filter(l => l.startsWith("agend restart")).length };
}

describe("gui-rehearsal.sh: the hop's verdict comes from the old updater alone", () => {
  // Each refusal is asserted by its own reason: a later check (a real install is missing here) must not stand in for it.
  it.each([[true], [false]])("the updater installs but exits 1 (plan left: %s) → refused for that exit, no restart repairs it", leavesPlan => {
    const r = rehearse({ rc: 1, leavesPlan });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`the old updater exited 1: it installed ${CAND} but did not complete the update`);
    expect(r.out).not.toContain("hop verdict:");
    expect(r.restarts).toBe(0);
  });
  it("the updater exits 0 but leaves the planned activation → the rehearsal fails, no restart repairs it first", () => {
    const r = rehearse({ rc: 0, leavesPlan: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("left the planned activation unconsumed");
    expect(r.out).not.toContain("hop verdict:");
    expect(r.restarts).toBe(0);
  });
  it("control: the updater installs, exits 0 and consumes the plan → the verdict passes (later checks need a real install)", () => {
    const r = rehearse({ rc: 0, leavesPlan: false });
    expect(r.out).toContain(`hop verdict: the old updater installed ${CAND}, exited 0 and consumed the planned activation`);
    expect(r.restarts).toBe(0);
  });
});
