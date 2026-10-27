/**
 * #2787: a change to an instance's instructions is never announced in its pane.
 *
 * Before, a backend that does not re-read its instructions on resume (kiro, codex, …) got
 * "[system] Your AgEnD instructions have been updated. Reload only …" pasted at warmup or ahead of
 * its next real message, every time the built instructions differed from the recorded ones — 92 times
 * in a week on the main host, mostly because the active-decisions list is part of them.
 *
 * Driven through the real launch preparation (trySpawnInsideGate up to writeConfig) and the real
 * delivery lock, so a call site that comes back is caught, not just a helper.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { TmuxManager } from "../src/tmux-manager.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const STOP = "stop after writeConfig";
function daemon(binaryName: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2787-")); dirs.push(dir);
  const infos: string[] = [];
  const logger = { child: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: (...a: unknown[]) => { infos.push(String(a[a.length - 1])); } }) };
  const d = new Daemon("silent-test", {
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as never, dir, true, undefined, undefined, logger as never) as any;
  d["tmux"] = { pasteBuffer: async () => true, sendSpecialKey: async () => true, capturePane: async () => "", getLastSendSpecialKeyError: () => null } as unknown as TmuxManager;
  // A launch that ends right after its instructions were built and compared: everything this test
  // is about happens before writeConfig.
  d["backend"] = { binaryName, prepareLaunch: async () => {}, writeConfig: () => { throw new Error(STOP); } };
  d["buildBackendConfig"] = () => ({ instructions: "INSTRUCTIONS v2 (a new decision was posted)", skipResume: false, workingDirectory: dir, instanceDir: dir, instanceName: "silent-test" });
  const pastes: string[] = [];
  d["deliverMessage"] = vi.fn(async (text: string) => { pastes.push(text); return true; });
  const deliver = async (text: string) => { d.pushChannelMessage(text, { chat_id: "", user: "peer", from_instance: "peer" }); await d["pasteLock"]; };
  return { d, dir, infos, pastes, deliver };
}

describe("#2787: changed instructions apply silently", () => {
  it.each(["kiro-cli", "codex", "grok", "muse", "agy"])("%s: no reload notice at launch or ahead of the next message", async binary => {
    const t = daemon(binary);
    writeFileSync(join(t.dir, "prev-instructions"), "INSTRUCTIONS v1");
    await expect(t.d["trySpawnInsideGate"]()).rejects.toThrow(STOP);
    expect(t.infos.filter(m => m.includes("Instructions changed"))).toEqual([]);
    // What this launch wrote is recorded; nothing is left waiting to be told.
    expect(readFileSync(join(t.dir, "prev-instructions"), "utf-8")).toBe("INSTRUCTIONS v2 (a new decision was posted)");
    await t.deliver("hello");
    expect(t.pastes).toHaveLength(1); expect(t.pastes[0]).toContain("hello");
    expect(t.pastes.join("\n")).not.toContain("instructions have been updated");
  });
  it("a first launch records its instructions (the 'launched before' marker what's-new reads) and says nothing", async () => {
    const t = daemon("kiro-cli");
    await expect(t.d["trySpawnInsideGate"]()).rejects.toThrow(STOP);
    expect(readFileSync(join(t.dir, "prev-instructions"), "utf-8")).toBe("INSTRUCTIONS v2 (a new decision was posted)");
    await t.deliver("hello");
    expect(t.pastes).toHaveLength(1); expect(t.pastes[0]).toContain("hello");
  });
});
