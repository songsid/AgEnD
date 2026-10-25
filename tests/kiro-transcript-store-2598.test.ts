/**
 * #2598 B1: the kiro transcript reads the store of the engine the instance runs on, and the conversation it owns.
 *
 * A classic (v1) conversation resumed under the TUI (v2) is copied to a session file and its sqlite row freezes. The
 * source read sqlite first and took any row as the answer, so after the move it returned "nothing new" forever and
 * the TUI conversation was never read. And both stores were read by "the directory's newest", so a sibling instance
 * in the same directory could be read in place of this one. Real sqlite and real session files, through the real
 * transcript worker lane.
 */
import Database from "better-sqlite3";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KiroBackend } from "../src/backend/kiro.js";
import { createTranscriptSource, KiroSessionSource, type KiroTranscriptLaunch } from "../src/transcript-sources.js";

const roots: string[] = [];
const sources: KiroSessionSource[] = [];
afterEach(() => {
  for (const s of sources.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiro-b1-")); roots.push(root);
  const cwd = join(root, "work"); mkdirSync(cwd);
  const sessionsDir = join(root, "sessions"); mkdirSync(sessionsDir);
  const dbPath = join(root, "data.sqlite3");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE conversations_v2 (
    key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id))`);
  const old = Date.now() - 60_000;
  const row = (id: string, texts: string[], updatedAt = old) => db.prepare(
    "INSERT OR REPLACE INTO conversations_v2 VALUES (?, ?, ?, ?, ?)",
  ).run(cwd, id, JSON.stringify({ history: texts.map(t => ({ user: { content: {} }, assistant: { Response: { message_id: t, content: t } } })) }), old, updatedAt);
  const session = (id: string, opts: { cwd?: string; updatedAt?: number } = {}) => {
    writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({
      session_id: id, cwd: opts.cwd ?? cwd,
      created_at: new Date(old).toISOString(), updated_at: new Date(opts.updatedAt ?? old).toISOString(),
    }));
    writeFileSync(join(sessionsDir, `${id}.jsonl`), line("history") + "\n");
    return (text: string) => appendFileSync(join(sessionsDir, `${id}.jsonl`), line(text) + "\n");
  };
  const source = (launch: KiroTranscriptLaunch | null) => {
    const s = new KiroSessionSource(cwd, sessionsDir, Date.now(), dbPath, undefined, () => launch);
    sources.push(s);
    return s;
  };
  return { db, row, session, source };
}
// The session files carry tool uses (what the source reports from them); the sqlite rows carry responses.
const line = (name: string) => JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "toolUse", data: { toolUseId: name, name, input: {} } }] } });

/** A few polls' worth of what the source reported: responses (sqlite) and tool names (session files). */
async function texts(source: KiroSessionSource, polls = 3): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < polls; i++) {
    const e = await source.poll();
    out.push(...e.assistantTexts, ...e.toolUses.map(t => t.name));
  }
  return out;
}

describe("the store follows the launch's engine (#2598 B1)", () => {
  it("unknown engine — the old behaviour, kept for older kiro: a frozen sqlite row hides the TUI session", async () => {
    const f = fixture();
    f.row("classic-1", ["classic history"]);
    const say = f.session("classic-1");
    const s = f.source(null);
    await s.initialize();
    await texts(s);
    say("tui reply");
    expect(await texts(s)).toEqual([]);
  });

  it("v2 launch: the TUI session is read even with the frozen classic row in sqlite", async () => {
    const f = fixture();
    f.row("classic-1", ["classic history"]);
    const say = f.session("classic-1");
    const s = f.source({ engine: "v2", sessionId: "classic-1" });
    await s.initialize();
    expect(await texts(s), "history is the baseline, not news").toEqual([]);
    say("tui reply");
    expect(await texts(s)).toEqual(["tui reply"]);
  });

  it("v1 launch: the sqlite store only — a stray session file in the directory is another engine's", async () => {
    const f = fixture();
    const say = f.session("tui-only");
    const s = f.source({ engine: "v1", sessionId: null });
    await s.initialize();
    await texts(s);
    say("not ours");
    expect(await texts(s)).toEqual([]);
  });
});

describe("the v2 session file is attached before work is admitted (#2617 review)", () => {
  // Production: the daemon awaits initialize(), admits work, and polls first on a 2 s timer. A reply written in that
  // gap is new, not history.
  it("progress written between initialize() and the first poll is reported, once", async () => {
    const f = fixture();
    const say = f.session("ours");
    const s = f.source({ engine: "v2", sessionId: "ours" });
    await s.initialize();
    say("first admitted reply");
    expect(await texts(s)).toEqual(["first admitted reply"]);
  });

  it("and the history already in the file is not replayed", async () => {
    const f = fixture();
    f.session("ours"); // holds "history"
    const s = f.source({ engine: "v2", sessionId: "ours" });
    await s.initialize();
    expect(await texts(s)).toEqual([]);
  });

  it("a fresh launch (no id) attaches the directory's newest at initialize too", async () => {
    const f = fixture();
    const say = f.session("newest", { updatedAt: Date.now() });
    const s = f.source({ engine: "v2", sessionId: null });
    await s.initialize();
    say("early reply");
    expect(await texts(s)).toEqual(["early reply"]);
  });

  it("reset() re-attaches at the boundary as of the reset", async () => {
    const f = fixture();
    const say = f.session("ours");
    const s = f.source({ engine: "v2", sessionId: "ours" });
    await s.initialize();
    say("before reset");
    s.reset();
    await s.initialize();
    say("after reset");
    expect(await texts(s)).toEqual(["after reset"]);
  });
});

describe("a resumed launch follows its own conversation, not the directory's newest", () => {
  it("v2: a newer sibling session in the same directory is not read", async () => {
    const f = fixture();
    const ours = f.session("ours");
    const sibling = f.session("sibling", { updatedAt: Date.now() });
    const s = f.source({ engine: "v2", sessionId: "ours" });
    await s.initialize();
    await texts(s);
    sibling("sibling's reply");
    ours("our reply");
    expect(await texts(s)).toEqual(["our reply"]);
  });

  it("v2 fresh launch (no id): the directory's newest, as before", async () => {
    const f = fixture();
    f.session("older");
    const newest = f.session("newest", { updatedAt: Date.now() });
    const s = f.source({ engine: "v2", sessionId: null });
    await s.initialize();
    await texts(s);
    newest("newest reply");
    expect(await texts(s)).toEqual(["newest reply"]);
  });

  it("v1: the pinned conversation's new turns, not a newer sibling row's", async () => {
    const f = fixture();
    f.row("ours", ["one"]);
    f.row("sibling", ["s1"], Date.now() - 1000);
    const s = f.source({ engine: "v1", sessionId: "ours" });
    await s.initialize();
    await texts(s);
    f.row("sibling", ["s1", "sibling's reply"], Date.now());
    f.row("ours", ["one", "our reply"], Date.now() - 500);
    expect(await texts(s)).toEqual(["our reply"]);
  });

  it("v1 without an id: the newest row, as before", async () => {
    const f = fixture();
    f.row("a", ["one"]);
    const s = f.source({ engine: "v1", sessionId: null });
    await s.initialize();
    await texts(s);
    f.row("a", ["one", "two"], Date.now());
    expect(await texts(s)).toEqual(["two"]);
  });
});

describe("what the backend reports, and the wiring", () => {
  const compat = {
    supportsLegacyUi: true, supportsTui: true, supportsV3: true, agentEngines: ["v2", "v1", "v3"],
    supportsEffortFlag: false, version: "2.30.0",
  } as never;

  it("KiroBackend.transcriptLaunch: null before a build; the engine and the resumed id after", () => {
    const b = new KiroBackend(mkdtempSync(join(tmpdir(), "kiro-b1-i-")), compat);
    expect(b.transcriptLaunch()).toBeNull();
    const internals = b as unknown as { builtLaunch: unknown; activePlan: unknown };
    internals.builtLaunch = { engine: "v2", mode: "resume", credentialProfile: null };
    internals.activePlan = { mode: "resume", id: "abc", engine: "v2" };
    expect(b.transcriptLaunch()).toEqual({ engine: "v2", sessionId: "abc" });
    internals.builtLaunch = { engine: "v1", mode: "fresh", credentialProfile: null };
    internals.activePlan = { mode: "fresh", engine: "v1" };
    expect(b.transcriptLaunch()).toEqual({ engine: "v1", sessionId: null });
  });

  it("createTranscriptSource hands the launch provider to the kiro source", () => {
    const launch = () => ({ engine: "v2" as const, sessionId: "x" });
    const s = createTranscriptSource("kiro-cli", "/w", undefined, launch) as KiroSessionSource;
    sources.push(s);
    expect((s as unknown as { launch: unknown }).launch).toBe(launch);
  });
});
