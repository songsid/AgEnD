/**
 * #1490 row 49: an unreadable or malformed kiro identity state file is never written back. Before the fix, one
 * malformed entry made the whole file read as "bad", the resolver started this key fresh and saved a file holding only
 * this key — every other key's valid record was lost. Scratch AGEND_HOME only; no kiro, fleet or tmux.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kiroIdentityNeedsStore, resolveKiroIdentity, type KiroStoreRead } from "../src/backend/kiro-identity.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-1490r49-")); mkdirSync(join(root, "work")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const home = () => join(root, "agend");
const fileName = (i: string) => createHash("sha256").update(i).digest("hex").slice(0, 32);
const statePath = () => join(home(), "kiro-identity", "instances", `${fileName("a")}.json`);
const pendingPath = () => join(home(), "kiro-identity", "instances", `${fileName("a")}.adopting.json`);
const claimPath = (id: string) => join(home(), "kiro-identity", "claims", "v1", id);
const store = (ids: string[]): KiroStoreRead => ({ kind: "ok", sessions: ids.map((id, i) => ({ id, updatedAt: 10 + i })), createdAt: () => 10 });
const resolve = (profile: string | null, over: Record<string, unknown> = {}) => resolveKiroIdentity({
  instance: "a", engine: "v1", workingDirectory: join(root, "work"), credentialProfile: profile, agendHome: home(),
  readStore: () => store(["X"]), launchedBefore: () => true, now: () => 1_000, ...over,
});

/** A valid record for profile null (resuming X, claim held), plus one malformed entry for another key. */
function validPlusMalformed(): string {
  expect(resolve(null)).toMatchObject({ mode: "resume", id: "X" });
  const state = JSON.parse(readFileSync(statePath(), "utf-8")) as { keys: Record<string, unknown> };
  state.keys["[\"v1\",\"/elsewhere\",\"broken\"]"] = { engine: "v1", workingDirectory: 42 };
  const text = JSON.stringify(state) + "\n";
  writeFileSync(statePath(), text);
  return text;
}

describe("#1490 row 49: a bad identity read never overwrites the other keys", () => {
  it("another key's launch keeps the file byte for byte and starts fresh, unrecorded", () => {
    const before = validPlusMalformed();
    const decision = resolve("p2");
    expect(decision).toMatchObject({ mode: "fresh", unrecorded: statePath() });
    expect(readFileSync(statePath(), "utf-8")).toBe(before);
    expect(readFileSync(claimPath("X"), "utf-8")).toBe("a\n"); // still held, never marked abandoned
  });

  it("an explicit fresh start (skipResume) does not rewrite it either", () => {
    const before = validPlusMalformed();
    expect(resolve("p2", { skipResume: true })).toEqual({ mode: "fresh", unrecorded: statePath() });
    expect(resolve(null, { skipResume: true })).toEqual({ mode: "fresh", unrecorded: statePath() });
    expect(readFileSync(statePath(), "utf-8")).toBe(before);
    expect(readFileSync(claimPath("X"), "utf-8")).toBe("a\n");
  });

  it("once the malformed entry is repaired, the valid key resumes its conversation", () => {
    validPlusMalformed();
    resolve("p2");
    const state = JSON.parse(readFileSync(statePath(), "utf-8")) as { keys: Record<string, unknown> };
    delete state.keys["[\"v1\",\"/elsewhere\",\"broken\"]"];
    writeFileSync(statePath(), JSON.stringify(state));
    expect(resolve(null)).toEqual({ mode: "resume", id: "X", agentConfirmed: false });
  });

  it("a pending adoption under a bad state file is kept, not given up", () => {
    mkdirSync(join(home(), "kiro-identity", "instances"), { recursive: true });
    writeFileSync(statePath(), "{ corrupt");
    const key = JSON.stringify(["v1", join(root, "work"), null]);
    writeFileSync(pendingPath(), JSON.stringify({ [key]: "P" }) + "\n");
    mkdirSync(join(home(), "kiro-identity", "claims", "v1"), { recursive: true });
    writeFileSync(claimPath("P"), "a\n");
    expect(resolve(null)).toEqual({ mode: "fresh", unrecorded: statePath() });
    expect(readFileSync(statePath(), "utf-8")).toBe("{ corrupt");
    expect(JSON.parse(readFileSync(pendingPath(), "utf-8"))).toEqual({ [key]: "P" });
    expect(readFileSync(claimPath("P"), "utf-8")).toBe("a\n");
  });

  it("an unknown version is not 'no state' either: fresh unrecorded, never an adoption, never rewritten", () => {
    mkdirSync(join(home(), "kiro-identity", "instances"), { recursive: true });
    const text = JSON.stringify({ version: 99, instance: "a", keys: {} });
    writeFileSync(statePath(), text);
    expect(resolve(null)).toEqual({ mode: "fresh", unrecorded: statePath() });
    expect(readFileSync(statePath(), "utf-8")).toBe(text);
    expect(existsSync(claimPath("X"))).toBe(false);
  });

  it("no store read is asked for ahead of a launch that will run unrecorded", () => {
    validPlusMalformed();
    expect(kiroIdentityNeedsStore({ instance: "a", engine: "v1", workingDirectory: join(root, "work"), credentialProfile: "p2", agendHome: home() })).toBe(false);
  });
});
