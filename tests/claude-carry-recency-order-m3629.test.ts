/**
 * M-3629 (#4408 review): the target is judged as it was BEFORE it was read. A turn written to the target while the
 * carry reads its last turn (the new profile in use at that moment) must stop the carry — not be taken as the version
 * compared, letting an older source replace a newer target. node:fs/promises.open is wrapped: the read of the target's
 * last turn (its third opening), as it closes, appends a later turn to it — after that read saw the older last turn.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const SID = "38875b68-1cbc-4cb3-942c-9fe07036a6db";
/** `at`: which opening of the target fires it (1-based): the older-copy check opens it twice (start, end), then lastTurnAt. */
const hook: { target: string | null; late: string; fired: boolean; at: number; opens: number } = { target: null, late: "", fired: false, at: 3, opens: 0 };
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, open: vi.fn(async (path: string, flags?: string) => {
    const fh = await real.open(path, flags);
    if (hook.target && String(path) === hook.target && !hook.fired && ++hook.opens === hook.at) {
      const close = fh.close.bind(fh);
      fh.close = async () => { await close(); if (!hook.fired) { hook.fired = true; appendFileSync(hook.target!, hook.late); } };
    }
    return fh;
  }) };
});
const { carryClaudeConversation } = await import("../src/backend/claude-carry.js");
const { claudeProjectKey } = await import("../src/backend/claude-code.js");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); hook.target = null; hook.fired = false; hook.opens = 0; });
const T0 = Date.parse("2026-11-24T08:00:00Z");
const turns = (n: number, from: number, tag: string) => Array.from({ length: n }, (_, i) =>
  JSON.stringify({ type: "user", sessionId: SID, uuid: `${tag}${from + i}`, timestamp: new Date(T0 + (from + i) * 60_000).toISOString() }) + "\n").join("");

it("a later turn written to the target while it is being read: the carry stops, and the target keeps that turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "agend-3629o-")); dirs.push(root);
  const work = join(root, "work"); mkdirSync(work);
  const from = join(root, "a"), to = join(root, "b"), key = claudeProjectKey(work);
  const fromProj = join(from, "projects", key), toProj = join(to, "projects", key);
  mkdirSync(fromProj, { recursive: true }); mkdirSync(toProj, { recursive: true });
  const ours = turns(2, 0, "a") + turns(2, 10, "b");                    // the source: last turn at +11 min
  const theirs = turns(2, 0, "a") + turns(1, 4, "c");                   // the target as first read: last turn at +4 min
  const late = turns(1, 30, "c");                                       // written while it is read: +30 min, newer than the source
  writeFileSync(join(fromProj, `${SID}.jsonl`), ours);
  writeFileSync(join(toProj, `${SID}.jsonl`), theirs);
  hook.target = join(toProj, `${SID}.jsonl`); hook.late = late;
  const r = await carryClaudeConversation({ sessionId: SID, workingDirectory: work, fromConfigDir: from, toConfigDir: to, freeBytes: async () => 1e12 });
  expect(hook.fired).toBe(true);                                         // the turn was written during the read: what this is about
  expect(r).toEqual({ carried: false, reason: "the new profile's copy of this conversation changed while it was being compared" });
  expect(readFileSync(join(toProj, `${SID}.jsonl`), "utf8")).toBe(theirs + late);
  expect(readdirSync(toProj).filter((n) => n.includes("agend-backup") || n.startsWith("."))).toEqual([]);
});
