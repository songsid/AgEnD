import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";
import { transcriptDeltaHasRawText } from "../src/delivery-reconciliation.js";

it("#2287 recorded ready Codex turn can leave viewport proof unavailable despite a rollout entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "agend-codex-timing2287-"));
  vi.useFakeTimers();
  try {
    const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/silent-codex-2287", name), "utf8");
    const before = fixture("ready-before.pane.txt"), after = fixture("ready-at-5.pane.txt");
    const text = "[quiet-heartbeat-2287] Check the inert task board; if nothing changed, stay silent.";
    const backend = new CodexBackend(root);
    expect(backend.getReadyPattern().test(before)).toBe(true);
    expect(after).not.toContain(text);
    expect(transcriptDeltaHasRawText(fixture("ready-rollout.selected.jsonl"), "codex", text)).toBe(true);
    const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } };
    const d: any = new Daemon("inert", { working_directory: root, backend: "codex" } as any, root, false, backend, undefined, logger);
    const history = vi.fn(); d.tmux = { capturePane: async () => after, capturePaneWithHistory: history };
    const signature = d.submissionSignature(text); expect(signature.unique).toBe(false);
    const proof = d.lateCodexSubmissionProof(signature, d.paneEvidence(before, signature));
    await vi.advanceTimersByTimeAsync(6000);
    expect(await proof).toBe("unproven"); expect(history).not.toHaveBeenCalled();
    // #2301 owns the future session binding; same-cwd text alone stays insufficient.
  } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
});
