/**
 * #3898: a queued message the CLI merged into ONE user entry with others was judged "not taken" (❌ + "please resend")
 * although the agent had it. The marker check wanted it at the start of an entry.
 *
 * Real captures, message text redacted (ids, timestamps and the CLI's own framing kept):
 * - Claude Code 2.1.325 (the leader, 2026-11-14 10:57Z): a turn was submitted for one message; a second, queued before
 *   the request had any answer, made Claude Code re-send the turn as one user entry — the first message, then
 *   `\n\n` and the second (tests/fixtures/claude-2.1.325-queued-merged-into-resent-turn.transcript.jsonl). Its hand-off
 *   record ended "not-taken" at 11:03:50Z.
 * - Codex 0.16x (2026-11-03): two queued deliveries submitted as one input_text, back to back
 *   (tests/fixtures/codex-0.16x-queued-merged-into-one-input.rollout.jsonl); the second never got consumed_at.
 *
 * Nothing here starts a CLI, a fleet or a tmux server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptDeltaMarkerKind } from "../src/transcript-needles.js";
import { scanTranscriptForDeliveryMarker } from "../src/delivery-reconciliation.js";
import { ConsumedWatch, type ConsumedWatchTarget } from "../src/delivery-consumed-watch.js";

const FIX = join(__dirname, "fixtures");
const CLAUDE = readFileSync(join(FIX, "claude-2.1.325-queued-merged-into-resent-turn.transcript.jsonl"), "utf8");
const CODEX = readFileSync(join(FIX, "codex-0.16x-queued-merged-into-one-input.rollout.jsonl"), "utf8");

/** The text of the entry's piece that starts at `marker`, to the end of the entry: what AgEnD pasted for it. */
function pieceFrom(transcript: string, marker: string): string {
  for (const line of transcript.split("\n").filter(Boolean)) {
    const o = JSON.parse(line);
    const text: string | undefined = typeof o.message?.content === "string" ? o.message.content : o.payload?.content?.[0]?.text;
    const at = text?.indexOf(marker) ?? -1;
    if (text && at > 0) return text.slice(at);
  }
  throw new Error(`no merged piece for ${marker}`);
}
const MERGED = "[hid:hmsg-45646434-8e33-4996-8e8c-9169e79a445d]";
const MERGED_WIRE = pieceFrom(CLAUDE, MERGED);
const FIRST = "[hid:hmsg-8df6dadf-218f-415b-b58d-e1d7a310d2c6]";
const CX_FIRST = "[agend-delivery-id:730dc19b-e25c-4186-a46e-738893988be8]";
const CX_SECOND = "[agend-delivery-id:4adaf4b2-778d-4e9a-aa03-71e1782243ff]";
// The Codex piece runs to the end of the input: the second of the two.
const CX_SECOND_WIRE = pieceFrom(CODEX, CX_SECOND);

const claudeUser = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

const roots: string[] = [];
const scratch = () => { const r = mkdtempSync(join(tmpdir(), "agend-3898-")); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("a message merged into one user entry with others is taken", () => {
  it("Claude Code's re-sent turn: the second message's exact text, whole, after the first — user (was: no match)", () => {
    expect(MERGED_WIRE.startsWith(`${MERGED}\n[user:`)).toBe(true);
    expect(transcriptDeltaMarkerKind(CLAUDE, "claude-code", MERGED)).toBeNull();            // the #3898 miss
    expect(transcriptDeltaMarkerKind(CLAUDE, "claude-code", MERGED, MERGED_WIRE)).toBe("user");
    // A trailing newline on what was pasted does not matter: the CLI keeps the text, not its last line break.
    expect(transcriptDeltaMarkerKind(CLAUDE, "claude-code", MERGED, `${MERGED_WIRE}\n`)).toBe("user");
    // The first message still leads its own entries, wire or not.
    expect(transcriptDeltaMarkerKind(CLAUDE, "claude-code", FIRST)).toBe("user");
  });

  it("Codex's one input of two deliveries back to back: the second's exact text — user (was: no match)", () => {
    expect(transcriptDeltaMarkerKind(CODEX, "codex", CX_SECOND)).toBeNull();
    expect(transcriptDeltaMarkerKind(CODEX, "codex", CX_SECOND, CX_SECOND_WIRE)).toBe("user");
    expect(transcriptDeltaMarkerKind(CODEX, "codex", CX_FIRST)).toBe("user");
  });

  it("controls: a marker alone, a different text, a quote inside longer text, or an entry that is not AgEnD's — no match", () => {
    // Only the marker of the pasted text (not the text itself) inside an entry: a mention, not this message.
    const mention = claudeUser(`${FIRST}\n[user:x] see\n\n${MERGED}\nsomething else`);
    expect(transcriptDeltaMarkerKind(mention, "claude-code", MERGED, MERGED_WIRE)).toBeNull();
    // The whole text, but one byte different.
    expect(transcriptDeltaMarkerKind(CLAUDE, "claude-code", MERGED, MERGED_WIRE.replace("(redacted)", "(redacted!)"))).toBeNull();
    // The whole text continued by more words: part of a longer message (a quote), not a piece of its own.
    const quoted = claudeUser(`${FIRST}\n[user:x] look:\n\n${MERGED_WIRE}and more`);
    expect(transcriptDeltaMarkerKind(quoted, "claude-code", MERGED, MERGED_WIRE)).toBeNull();
    // A typed entry (not led by an AgEnD marker) that holds the whole text: not a merge of AgEnD's pastes.
    const typed = claudeUser(`please look at this:\n\n${MERGED_WIRE}`);
    expect(transcriptDeltaMarkerKind(typed, "claude-code", MERGED, MERGED_WIRE)).toBeNull();
    // A wire that does not start with its own marker proves nothing.
    expect(transcriptDeltaMarkerKind(CLAUDE, "claude-code", MERGED, MERGED_WIRE.slice(1))).toBeNull();
    // Only queued (an enqueue of the merged text) is still not taken.
    const enqueued = JSON.stringify({ type: "queue-operation", operation: "enqueue", content: `${FIRST}\nx\n\n${MERGED_WIRE}` }) + "\n";
    expect(transcriptDeltaMarkerKind(enqueued, "claude-code", MERGED, MERGED_WIRE)).toBeNull();
  });

  it("the restart reading (scanTranscriptForDeliveryMarker) takes the wire too", async () => {
    const path = join(scratch(), "t.jsonl");
    writeFileSync(path, CLAUDE);
    expect(await scanTranscriptForDeliveryMarker(path, 0, "claude-code", { marker: MERGED })).toBe("no-match");
    expect(await scanTranscriptForDeliveryMarker(path, 0, "claude-code", { marker: MERGED, wire: MERGED_WIRE })).toBe("user");
  });
});

describe("the hand-off watch on the real Claude capture, CLI idle afterwards", () => {
  function watch(path: string, over: Partial<ConsumedWatchTarget> = {}) {
    const consumed = vi.fn(), notTaken = vi.fn(), ended = vi.fn();
    const w = new ConsumedWatch({ deliveryId: "handoff:h1", attemptNo: 0, backend: "claude-code", path, offset: 0, marker: MERGED,
      current: () => true, consumed, notTaken, idleForMs: () => 600_000, ...over } as ConsumedWatchTarget, ended);
    return { w, consumed, notTaken, ended };
  }

  it("with the pasted text: taken, no not-taken (was: not-taken → ❌ + resend notice)", async () => {
    const path = join(scratch(), "t.jsonl");
    writeFileSync(path, CLAUDE);
    const before = watch(path);                                   // the record as it was: marker only
    await before.w.look();
    expect(before.consumed).not.toHaveBeenCalled();
    expect(before.notTaken).toHaveBeenCalledTimes(1);
    const fixed = watch(path, { wire: MERGED_WIRE });
    await fixed.w.look();
    expect(fixed.consumed).toHaveBeenCalledWith("turn", "transcript-consumed:user-entry");
    expect(fixed.ended).toHaveBeenCalledWith("consumed");
    expect(fixed.notTaken).not.toHaveBeenCalled();
  });

  it("a message the CLI never took, even with its text: still not taken (❌ + notice stay for a real miss)", async () => {
    const path = join(scratch(), "t.jsonl");
    writeFileSync(path, CLAUDE);
    const other = "[hid:hmsg-00000000-0000-4000-8000-000000000000]";
    const w = watch(path, { marker: other, wire: `${other}\n[user:person@dc#1] (redacted)` });
    await w.w.look();
    expect(w.consumed).not.toHaveBeenCalled();
    expect(w.notTaken).toHaveBeenCalledTimes(1);
    expect(w.ended).toHaveBeenCalledWith("not-taken");
  });
});
