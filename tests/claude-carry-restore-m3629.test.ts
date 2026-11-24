/**
 * M-3629: replacing another (older) history of the conversation, the target's own copy is moved aside first; if the
 * source then can't take its place, that copy is put back — the switch falls back to a fresh start, and neither
 * history is lost. The one rename that places the copy fails here (node:fs/promises mocked for that call only).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const SID = "38875b68-1cbc-4cb3-942c-9fe07036a6db";
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, rename: vi.fn(async (from: string, to: string) => {
    if (String(from).includes(".carry-") && String(to).endsWith(`${SID}.jsonl`)) throw Object.assign(new Error("EIO: placing the copy failed"), { code: "EIO" });
    return real.rename(from, to);
  }) };
});
const { carryClaudeConversation } = await import("../src/backend/claude-carry.js");
const { claudeProjectKey } = await import("../src/backend/claude-code.js");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const T0 = Date.parse("2026-11-24T08:00:00Z");
const turns = (n: number, from: number, tag: string) => Array.from({ length: n }, (_, i) =>
  JSON.stringify({ type: "user", sessionId: SID, uuid: `${tag}${from + i}`, timestamp: new Date(T0 + (from + i) * 60_000).toISOString() }) + "\n").join("");

it("the copy can't take the target's place: the target's own history is put back, unchanged, and the switch says why", async () => {
  const root = mkdtempSync(join(tmpdir(), "agend-3629-")); dirs.push(root);
  const work = join(root, "work"); mkdirSync(work);
  const from = join(root, "a"), to = join(root, "b"), key = claudeProjectKey(work);
  const fromProj = join(from, "projects", key), toProj = join(to, "projects", key);
  mkdirSync(fromProj, { recursive: true }); mkdirSync(toProj, { recursive: true });
  const ours = turns(2, 0, "a") + turns(2, 10, "b"), theirs = turns(2, 0, "a") + turns(1, 4, "c");
  writeFileSync(join(fromProj, `${SID}.jsonl`), ours);
  writeFileSync(join(toProj, `${SID}.jsonl`), theirs);
  const r = await carryClaudeConversation({ sessionId: SID, workingDirectory: work, fromConfigDir: from, toConfigDir: to, freeBytes: async () => 1e12 });
  expect(r).toEqual({ carried: false, reason: "copy failed: EIO: placing the copy failed" });
  expect(readFileSync(join(toProj, `${SID}.jsonl`), "utf8")).toBe(theirs);
  expect(readdirSync(toProj).sort()).toEqual([`${SID}.jsonl`]);                // no backup or temporary file left over
  expect(readFileSync(join(fromProj, `${SID}.jsonl`), "utf8")).toBe(ours);
});
