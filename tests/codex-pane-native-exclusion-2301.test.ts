import { expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";
it("native lifecycle cannot mint a coordinator-local Codex paste lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-native2301-"));
  try {
    const rows = readFileSync(new URL("./fixtures/codex-pane-owner-2301/rollout.selected.jsonl", import.meta.url), "utf8").trimEnd().split("\n");
    const meta = JSON.parse(rows[0]); meta.payload.cwd = root;
    mkdirSync(join(root, "sessions")); writeFileSync(join(root, "sessions", `rollout-${meta.payload.id}.jsonl`), JSON.stringify(meta) + "\n");
    const pane = readFileSync(new URL("./fixtures/codex-pane-owner-2301/after-ready-120.pane.txt", import.meta.url), "utf8");
    const backend: any = new CodexBackend(join(root, "instance")); backend.isolatedCodexHome = root;
    const d: any = Object.assign(Object.create(Daemon.prototype), {
      backend, nativePaneLifecycle: {}, config: { working_directory: root }, bootId: "native-proof", spawnGeneration: 1,
      launchAttempt: 1, launchFenceEpoch: 1, deliveryWritesStopping: false, ownSwitch: null,
      tmux: { getWindowId: () => "@owned", capturePane: async () => pane }, deliveryBlockingDialogs: () => [],
    });
    expect(await d.bindCodexRawPaste("@owned", () => true)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("native raw Codex retains the Runtime-owned checkpoint", async () => {
  const reference = { cursor: { offset: 42, sessionId: "runtime-session" } };
  const local = vi.fn(async () => null), runtime = vi.fn(async () => reference);
  const d: any = Object.assign(Object.create(Daemon.prototype), {
    config: { backend: "codex" },
    nativePaneLifecycle: { current: (candidate: unknown) => candidate === reference },
    transcriptMonitor: { reconciliationCheckpoint: local, reconciliationRuntimeCheckpoint: runtime },
  });
  const evidence = await d.durableAttemptEvidence("@native", false, false, true);
  expect(runtime).toHaveBeenCalledOnce();
  expect(local).not.toHaveBeenCalled();
  expect(evidence.runtimeTranscript).toBe(reference);
  expect(evidence.transcriptSessionId).toBe("runtime-session");
});
