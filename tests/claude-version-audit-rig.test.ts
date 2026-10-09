/**
 * The 2.1.294 audit's reproduction rig (scripts/manual/claude-version-audit) runs its passes under `set -u`. A
 * launch with no key (onboarding, not logged in) and a production command built without the resume argument must not
 * abort on an unset optional variable (#1427 review: `WITHKEY: unbound variable`, exit 127 before tmux was reached).
 * tmux and npx are stubs on PATH that record their arguments: nothing real is started.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LIB = join(import.meta.dirname, "..", "scripts", "manual", "claude-version-audit", "lib.sh");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function rig(body: string, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-audit-rig-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  const log = join(root, "calls.log");
  for (const tool of ["tmux", "npx"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s ' ${tool} "$@" >> "${log}"\necho >> "${log}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const audit = join(root, "audit"); mkdirSync(audit);
  const run = spawnSync("bash", ["-c", `set -u; . "${LIB}"; ${body}`], {
    env: { PATH: `${bin}:${process.env.PATH}`, AUDIT_DIR: audit, ...env }, encoding: "utf8",
  });
  let calls = "";
  try { calls = readFileSync(log, "utf8"); } catch { /* nothing called */ }
  return { status: run.status, stderr: run.stderr, calls, audit };
}

describe("the audit rig under set -u", () => {
  it("a no-key launch runs (no WITHKEY set) and passes no API key", () => {
    const r = rig(`start o292 2.1.292 "$A/h/o292" "$A/w/o292"`);
    expect(r.stderr).not.toContain("unbound variable");
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/^tmux -L cc294audit new-session -d -s o292 /m);
    expect(r.calls).not.toContain("ANTHROPIC_API_KEY");
  });

  it("WITHKEY=1 passes the run-time-built fake key", () => {
    const r = rig(`start k292 2.1.292 "$A/h/k292" "$A/w/k292"`, { WITHKEY: "1" });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`ANTHROPIC_API_KEY=sk-ant-api03-${"test".repeat(22)}-testtestAA`);
  });

  it("OLD/NEW pick the pair audited: its own socket, and the default stays the 2.1.294 audit's", () => {
    const r = rig(`start k295 2.1.295 "$A/h/k295" "$A/w/k295"; echo "$OLD $NEW $SOCK"`, { OLD: "294", NEW: "295" });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/^tmux -L cc295audit new-session -d -s k295 /m);
    expect(rig(`echo "$OLD $NEW $SOCK" >&2; false`).stderr).toContain("292 294 cc294audit");
  });

  it("gencmd without its optional resume argument builds the command", () => {
    const r = rig(`gencmd 292 p`);
    expect(r.stderr).not.toContain("unbound variable");
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/^npx tsx \S+\/gen-cmd\.ts \S+\/inst\/p292 \S+\/w\/p292 \S+\/2\.1\.292 $/m);
  });
});
