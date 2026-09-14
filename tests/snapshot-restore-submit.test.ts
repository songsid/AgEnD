import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";

/**
 * The session snapshot is a one-shot: buildSnapshotPrompt deletes
 * rotation-state.json as it renders the prompt, so if the paste is never
 * submitted the previous session's context is gone with nothing to retry from.
 * It used to go out through tmux.pasteText — one Enter, no verification — and
 * "snapshot_injected" was emitted regardless, which is exactly how a lost
 * context restore stays invisible.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeDaemon() {
  const dir = mkdtempSync(join(tmpdir(), "agend-snapshot-restore-"));
  dirs.push(dir);
  writeFileSync(join(dir, "rotation-state.json"), JSON.stringify({
    reason: "context_rotation",
    working_directory: "/tmp",
    recent_user_messages: ["carry on with the migration"],
  }));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("snapshot-test", {
    working_directory: "/tmp",
    backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new CodexBackend(dir) as any, undefined, { child: () => logger } as any) as any;

  let pane = "› Ask Codex to do anything\n  Context 100% left";
  const paste = vi.fn(async (text: string) => { pane = text; return true; });
  daemon.tmux = {
    pasteBuffer: paste,
    sendSpecialKey: vi.fn(async () => true),
    capturePane: async () => pane,
    getLastSendSpecialKeyError: () => null,
  };
  const events: string[] = [];
  for (const e of ["snapshot_injected", "snapshot_failed"]) daemon.on(e, () => events.push(e));
  return { daemon, events, setPane: (p: string) => { pane = p; }, paste };
}

describe("session snapshot restore", () => {
  it("reports snapshot_failed when the restore is left sitting in the input row", async () => {
    const h = makeDaemon();
    // Codex keeps the pasted text in its input row: the Enter was dropped.
    h.paste.mockImplementation(async (text: string) => {
      h.setPane(`› ${text}\n  Context 100% left`);
      return true;
    });

    await h.daemon.injectSnapshotMessage();

    expect(h.events, "a restore nobody submitted is not an injected restore").not.toContain("snapshot_injected");
    expect(h.events).toContain("snapshot_failed");
  }, 15_000);

  it("reports snapshot_injected once the restore is actually submitted", async () => {
    const h = makeDaemon();
    // The CLI echoes the submitted message into the transcript and clears the
    // input row — the pane GAINS the text outside the input area.
    h.paste.mockImplementation(async (text: string) => {
      h.setPane(`› ${text}\n• Working (1s)\n› Ask Codex to do anything\n  Context 100% left`);
      return true;
    });

    await h.daemon.injectSnapshotMessage();

    expect(h.events).toContain("snapshot_injected");
    expect(h.events).not.toContain("snapshot_failed");
  }, 15_000);
});
