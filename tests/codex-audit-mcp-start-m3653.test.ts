/**
 * M-3653 (#4417 review): scripts/manual/codex-version-audit/mcp-start.sh must not read as a pass when it proved
 * nothing — a rig step that failed, an MCP server that did not start after a launch, or a turn that never reached
 * codex each make it exit 1, with the log (and the reason) still printed. Run against a fake rig (RIG), a fake pane
 * (CAPTURE) and no waits (WAIT=0): no codex, no tmux, no network.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "scripts", "manual", "codex-version-audit", "mcp-start.sh");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A rig that answers every step; a launch logs the server's start to GEN_MCP_MARK (as stub-mcp.mjs would) unless told not to. */
const FAKE_RIG = `#!/usr/bin/env bash
V="$1"; shift; step="$1"; shift
case "$step" in
  paths) echo "SOCK=fake-sock AH=/nonexistent SH=/nonexistent RUN=/nonexistent" ;;
  launch) [ "\${FAKE_LAUNCH_RC:-0}" = 0 ] || exit "$FAKE_LAUNCH_RC"
          [ -n "\${FAKE_NO_START:-}" ] || echo "$(date +%s%3N) 4242 start" >> "$GEN_MCP_MARK" ;;
  *) : ;;
esac
`;

function run(env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "mcp-start-")); dirs.push(d);
  const rig = join(d, "rig.sh"), mark = join(d, "mark.log");
  writeFileSync(rig, FAKE_RIG, { mode: 0o755 });
  const r = spawnSync("bash", [SCRIPT, "0.172.0"], { encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH ?? "", HOME: d, RIG: rig, MARK: mark, WAIT: "0",
      CAPTURE: "printf 'hello\\nagain\\nafter resume\\n'", ...env } });
  const log = readFileSync(mark, "utf8");
  // What a failing assertion shows: the exit, the script's log and its stderr (CI has no other view of the run).
  const why = `exit ${r.status} signal ${r.signal}\n--- log\n${log}--- stderr\n${r.stderr}${r.error ? `--- spawn error\n${r.error.message}` : ""}`;
  return { status: r.status, out: r.stdout, err: r.stderr, log, why };
}

describe("mcp-start.sh fails when it proved nothing", () => {
  it("control: every launch starts the server and every turn reaches codex — exit 0, PASS, the log printed", () => {
    const r = run();
    expect(r.status, r.why).toBe(0);
    expect(r.out, r.why).toContain("mcp-start: PASS");
    expect(r.log).toContain("--- reached: hello");
    expect(r.log).toContain("--- reached: after resume");
    expect(r.log).not.toContain("FAILED");
    expect(r.out).toContain("--- launch-resume @");                       // the log is printed
  });

  it("a launch that fails: exit 1, the step named, the log still printed", () => {
    const r = run({ FAKE_LAUNCH_RC: "2" });
    expect(r.status, r.why).toBe(1);
    expect(r.log).toContain("--- FAILED: rig launch main fresh trust");
    expect(r.err).toContain("mcp-start: FAIL");
    expect(r.out).toContain("--- launch-fresh @");
  });

  it("a launch after which the MCP server never starts: exit 1, said so for each launch", () => {
    const r = run({ FAKE_NO_START: "1" });
    expect(r.status, r.why).toBe(1);
    expect(r.log).toContain("--- FAILED: the MCP server did not start after launch-fresh");
    expect(r.log).toContain("--- FAILED: the MCP server did not start after launch-resume");
  });

  it("a turn that never reached codex: exit 1, NOT reached for that turn only", () => {
    const r = run({ CAPTURE: "printf 'hello\\nafter resume\\n'" });
    expect(r.status, r.why).toBe(1);
    expect(r.log).toContain("--- NOT reached: again");
    expect(r.log).toContain("--- reached: hello");
  });

  it("a pane whose writer is still writing after the turn's line: still reached (no SIGPIPE race, #4421 CI)", () => {
    // grep -q exits on "hello"; the writer's later output then meets a closed pipe. Before the fix that was exit 141,
    // pipefail made it NOT reached — on CI it depended on scheduling, here the pause makes it certain.
    const r = run({ CAPTURE: "printf 'hello\\n'; sleep 0.2; printf 'again\\nafter resume\\n'" });
    expect(r.status, r.why).toBe(0);
    expect(r.log).not.toContain("NOT reached");
  });

  it("a pane that can't be read: exit 1, every turn NOT reached", () => {
    const r = run({ CAPTURE: "exit 3" });
    expect(r.status, r.why).toBe(1);
    for (const t of ["hello", "again", "after resume"]) expect(r.log).toContain(`--- NOT reached: ${t}`);
  });
});
