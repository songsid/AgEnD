/**
 * #1228: muse session discovery reads a bounded 64KB head, never the whole log.
 *
 * `museFingerprint` (session-signals.ts) and `MuseBackend.getSessionId`
 * (muse.ts) only need the `route_facts` record near the top of
 * session.jsonl, but both used to `readFileSync` the entire file before
 * slicing the head. Session logs grow past hundreds of KB, so discovery now
 * goes through the shared bounded `readFileHeadSync` (open + read at most
 * 64KB + close).
 *
 * Boundedness is enforced structurally: in this file `readFileSync` of any
 * session.jsonl throws, so a revert to the full read fails discovery (red),
 * while the bounded implementation stays green. Equivalence against the old
 * full-read-then-slice is asserted on an ASCII fixture (byte head == char
 * head, no multibyte boundary split) much larger than 64KB.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((...args: [unknown, ...unknown[]]) => {
      const p = args[0];
      if (typeof p === "string" && p.endsWith(`${sep}session.jsonl`)) {
        throw new Error(`#1228: full readFileSync of session.jsonl is forbidden: ${p}`);
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    }),
  };
});

const { fakeHome } = vi.hoisted(() => ({ fakeHome: { dir: "" } }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome.dir };
});

import { MuseBackend, museSessionCwd, readFileHeadSync } from "../src/backend/muse.js";
import { museFingerprint } from "../src/backend/session-signals.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = "agend-1228-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const UUID = "01a10ee8-5e75-7990-9c91-f5ea5e202d3d";
const T0 = Date.parse("2026-10-06T00:00:00.000Z");
const HEAD_BYTES = 65_536;

/** A session.jsonl much larger than 64KB: route_facts head, ASCII padding, turn tail. */
function bigSessionContent(cwd: string): string {
  const frame = (sequence: number, recordedAtMicros: number, payloadType: string, kind?: string) => JSON.stringify({
    schema_version: 1, id: `e-${sequence}`, stream: { kind: "session", id: UUID }, sequence,
    recorded_at: recordedAtMicros, record_type: "event", payload_type: payloadType,
    payload: kind ? { kind } : {},
  });
  const lines = [
    JSON.stringify({ retained_frame: "session_permission_transaction", transaction_id: "t-1" }),
    JSON.stringify({ schema_version: 1, route_facts: { cwd } }),
  ];
  // ASCII padding: not JSON, so the tail reader skips it; byte head == char head.
  for (let i = 0; lines.join("\n").length < HEAD_BYTES * 3; i++) {
    lines.push(`pad-${i} ` + "x".repeat(200));
  }
  lines.push(frame(1001, T0 * 1000, "runtime.session", "task"));
  lines.push(frame(1002, (T0 + 4_000) * 1000, "runtime.session", "task"));
  return lines.join("\n") + "\n";
}

function writeBigSession(dir: string, cwd: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  writeFileSync(path, bigSessionContent(cwd));
  return path;
}

describe("readFileHeadSync (#1228)", () => {
  it("matches full-read-then-slice on a file much larger than 64KB", () => {
    const root = tempDir();
    const content = bigSessionContent("/w");
    expect(content.length).toBeGreaterThan(HEAD_BYTES * 2);
    const path = join(root, "session.jsonl");
    writeFileSync(path, content);
    expect(statSync(path).size).toBeGreaterThan(HEAD_BYTES * 2);
    // Oracle: the old full-read-then-slice behavior on ASCII content
    // (byte head == char head, no multibyte boundary split).
    expect(readFileHeadSync(path, HEAD_BYTES)).toBe(content.slice(0, HEAD_BYTES));
  });

  it("preserves discovery coverage when the head is mostly multibyte text (#1281)", () => {
    // Prism's probe: 23,000 CJK chars before route_facts is only ~23K code
    // units but ~69KB bytes. A byte-truncating head loses the cwd; the
    // character-bounded head must match the old full decode + slice exactly.
    const root = tempDir();
    const content = JSON.stringify({ retained_frame: "session_permission_transaction",
      detail: "中".repeat(23_000) }) + "\n"
      + JSON.stringify({ schema_version: 1, route_facts: { cwd: "/w" } }) + "\n";
    expect(content.length).toBeLessThan(HEAD_BYTES);
    expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(HEAD_BYTES);
    const path = join(root, "session.jsonl");
    writeFileSync(path, content);
    expect(readFileHeadSync(path, HEAD_BYTES)).toBe(content.slice(0, HEAD_BYTES));
    expect(museSessionCwd(readFileHeadSync(path, HEAD_BYTES)!)).toBe("/w");
  });

  it("decodes a multibyte character split across a chunk boundary intact (#1281)", () => {
    // A 3-byte char straddling byte 65,536: byte truncation yields U+FFFD,
    // the old full decode (and the streaming head) keeps the intact char.
    const root = tempDir();
    const content = "a".repeat(HEAD_BYTES - 1) + "中" + "b".repeat(100);
    const path = join(root, "session.jsonl");
    writeFileSync(path, content);
    const head = readFileHeadSync(path, HEAD_BYTES)!;
    expect(head).toBe(content.slice(0, HEAD_BYTES));
    expect(head.endsWith("中")).toBe(true);
    expect(head).not.toContain("�");
  });

  it("keeps a leading BOM like the old full read (#1281 P3)", () => {
    const root = tempDir();
    const content = "﻿" + bigSessionContent("/w");
    const path = join(root, "session.jsonl");
    writeFileSync(path, content);
    // Old behavior: full decode keeps U+FEFF, then slice. The streaming
    // head must match it exactly (TextDecoder strips BOM by default).
    expect(readFileHeadSync(path, HEAD_BYTES)).toBe(content.slice(0, HEAD_BYTES));
    expect(readFileHeadSync(path, HEAD_BYTES)!.startsWith("﻿")).toBe(true);
  });

  it("returns null for a missing file instead of throwing", () => {
    expect(readFileHeadSync(join(tempDir(), "nope.jsonl"), HEAD_BYTES)).toBeNull();
  });
});

describe("bounded discovery (#1228)", () => {
  it("museFingerprint finds a >64KB session without a full read", () => {
    const root = tempDir();
    writeBigSession(join(root, "2026", "10", "06", UUID), "/w");
    const got = museFingerprint({ sessionsRoot: root, cwd: "/w" });
    expect(got).toMatchObject({ sessionId: UUID, tailTimestampMs: T0 + 4_000 });
    expect(museFingerprint({ sessionsRoot: root, cwd: "/elsewhere" })).toBeNull();
  });

  it("MuseBackend.getSessionId finds a >64KB session without a full read", () => {
    const home = tempDir("agend-1228-home-");
    fakeHome.dir = home;
    try {
      writeBigSession(join(home, ".local", "share", "muse", "sessions", "2026", "10", "06", UUID), "/w");
      const instanceDir = mkdtempSync(join(tmpdir(), "agend-1228-inst-"));
      dirs.push(instanceDir);
      const backend = new MuseBackend(instanceDir);
      backend.buildCommand({
        workingDirectory: "/w",
        instanceDir,
        instanceName: "alpha",
        mcpServers: {},
      });
      expect(backend.getSessionId()).toBe(UUID);
    } finally {
      fakeHome.dir = "";
    }
  });
});
