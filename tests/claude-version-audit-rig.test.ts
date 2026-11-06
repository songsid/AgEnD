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
    // The API endpoint the call was made with is recorded too: gencmd passes it in the environment, not as an argument.
    writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s ' ${tool} "$@" >> "${log}"\necho "[base=\${ANTHROPIC_BASE_URL:-}]" >> "${log}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const audit = join(root, "audit"); mkdirSync(audit);
  const run = spawnSync("bash", ["-c", `set -u; . "${LIB}"; ${body}`], {
    env: { PATH: `${bin}:${process.env.PATH}`, AUDIT_DIR: audit, ...env }, encoding: "utf8",
  });
  let calls = "";
  try { calls = readFileSync(log, "utf8"); } catch { /* nothing called */ }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls, audit };
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
    // #1436 review: launch through the variables, not a hardcoded version, and check the pair they echo.
    const r = rig(`start k$NEW 2.1.$NEW "$A/h/k$NEW" "$A/w/k$NEW"; echo "$OLD $NEW $SOCK" >&2`, { OLD: "311", NEW: "312" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("311 312 cc312audit");
    expect(r.calls).toMatch(/^tmux -L cc312audit new-session -d -s k312 .*\/2\.1\.312 /m);
    expect(rig(`echo "$OLD $NEW $SOCK" >&2; false`).stderr).toContain("292 294 cc294audit");
  });

  it("step captures and diffs exactly the OLD and NEW panes, and frames files them per version", () => {
    const r = rig(`step p 23-busy 0; frames p err-E429 2 0; ls "$A/cap" "$A/cap/frames/err-E429"`, { OLD: "311", NEW: "312" });
    expect(r.status).toBe(0);
    for (const v of ["311", "312"]) expect(r.calls).toContain(`tmux -L cc312audit capture-pane -p -t p${v} `);
    expect(r.calls).not.toMatch(/-t p29[24] /);
    expect(r.stdout).toMatch(/311-23-busy\.txt[\s\S]*312-23-busy\.txt/);
    expect(r.stdout).toContain("diff-23-busy.txt");
    expect(r.calls.match(/capture-pane -p -t p31[12] /g)).toHaveLength(2 + 2 * 2);   // step's two + two frames each
  });

  it("the mock's PORT is the one every launch points Claude at (start and the production gencmd)", () => {
    const r = rig(`start k312 2.1.312 "$A/h/k312" "$A/w/k312"; gencmd 312 p`, { OLD: "311", NEW: "312", PORT: "18312" });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:18312 ");             // start: in the tmux command line
    expect(r.calls).toMatch(/^npx tsx \S+\/gen-cmd\.ts .*\[base=http:\/\/127\.0\.0\.1:18312\]$/m);   // gencmd: its environment
    expect(r.calls).not.toContain("127.0.0.1:18294");
    const pass1 = readFileSync(join(import.meta.dirname, "..", "scripts", "manual", "claude-version-audit", "pass1.sh"), "utf8");
    expect(pass1).toMatch(/mockapi\.py \$PORT /);
  });

  it("gencmd without its optional resume argument builds the command", () => {
    const r = rig(`gencmd 292 p`);
    expect(r.stderr).not.toContain("unbound variable");
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/^npx tsx \S+\/gen-cmd\.ts \S+\/inst\/p292 \S+\/w\/p292 \S+\/2\.1\.292 \[base=/m);
  });
});
