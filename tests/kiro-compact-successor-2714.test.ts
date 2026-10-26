/**
 * #2714 (hxhsandy): classic kiro's /compact goes on in a NEW conversation id, and the identity record kept the old one,
 * so a restart resumed the pre-compaction conversation. These pin the store links (real SQLite, rows captured offline
 * from kiro-cli 2.34.0: tests/fixtures/kiro-2.34.0-compact-2714), the resolver following them only on proof, the
 * take-up after a fresh start, and the log lines for "claim not held → fresh start". Every root is a scratch directory;
 * no kiro, fleet or tmux is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listKiroV1Sessions, resolveKiroIdentity, KiroIdentityError, type KiroStoreRead } from "../src/backend/kiro-identity.js";
import { KiroBackend, type KiroCliCompatibility } from "../src/backend/kiro.js";
import { t } from "../src/locale.js";

interface Row { key: string; conversation_id: string; created_at: number; updated_at: number; value: Record<string, unknown> }
const CAPTURED: Row[] = JSON.parse(readFileSync(join(__dirname, "fixtures", "kiro-2.34.0-compact-2714", "conversations_v2.json"), "utf-8"));
const [A, B, C] = CAPTURED.map(r => r.conversation_id) as [string, string, string];

let root: string, cwd: string, db: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-2714-"));
  cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  db = join(root, "xdg", "kiro-cli", "data.sqlite3");
  vi.stubEnv("AGEND_HOME", join(root, "agend"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
  vi.stubEnv("KIRO_HOME", join(root, "kiro-home"));
});
afterEach(() => { vi.unstubAllEnvs(); chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); });

/** kiro's schema and index; the captured rows (or the given ones) keyed on this test's directory. */
function store(rows: Row[] = CAPTURED, raw: Array<[string, string, number, number]> = []): void {
  mkdirSync(join(root, "xdg", "kiro-cli"), { recursive: true });
  const d = new Database(db);
  d.exec("CREATE TABLE IF NOT EXISTS conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX IF NOT EXISTS idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);");
  const ins = d.prepare("INSERT OR REPLACE INTO conversations_v2 VALUES (?, ?, ?, ?, ?)");
  for (const r of rows) ins.run(r.key === "/work/kiro-classic" ? cwd : r.key, r.conversation_id, JSON.stringify(r.value), r.created_at, r.updated_at);
  for (const [id, value, created, updated] of raw) ins.run(cwd, id, value, created, updated);
  d.close();
}
/** A captured row reshaped: another id, times, transcript or summary. */
function row(base: Row, over: { id?: string; created?: number; updated?: number; transcript?: string[]; summary?: unknown; key?: string }): Row {
  const value: Record<string, unknown> = { ...base.value, conversation_id: over.id ?? base.conversation_id };
  if (over.transcript) value.transcript = over.transcript;
  if ("summary" in over) value.latest_summary = over.summary;
  return { key: over.key ?? base.key, conversation_id: over.id ?? base.conversation_id, created_at: over.created ?? base.created_at, updated_at: over.updated ?? base.updated_at, value };
}
const transcriptOf = (r: Row) => r.value.transcript as string[];
const links = () => { const s = listKiroV1Sessions(cwd, db); if (s.kind !== "ok" || !s.compaction) throw new Error("no links"); return s.compaction; };

const home = () => join(root, "agend");
const claims = () => join(home(), "kiro-identity", "claims", "v1");
const claimFile = (id: string) => readFileSync(join(claims(), id), "utf-8");
const resolve = (instance = "worker", over: Partial<Parameters<typeof resolveKiroIdentity>[0]> = {}) => resolveKiroIdentity({
  instance, engine: "v1", workingDirectory: cwd, credentialProfile: null, agendHome: home(),
  readStore: () => listKiroV1Sessions(cwd, db), launchedBefore: () => true, ...over,
});
/** The instance owns `id` the way #906 records it: adopted as the only conversation in the directory. */
function own(id: string, instance = "worker"): void {
  const full = CAPTURED.find(r => r.conversation_id === id)!;
  store([full]);
  expect(resolve(instance)).toMatchObject({ mode: "resume", id });
  rmSync(db);
}

describe("the store's compaction links (v1, real SQLite, captured rows)", () => {
  it("the capture: A was compacted into B, B into C; C has none; each successor carries a summary", () => {
    store();
    const l = links();
    expect(l.successorsOf(A)).toEqual([B]);
    expect(l.successorsOf(B)).toEqual([C]);
    expect(l.successorsOf(C)).toEqual([]);
    expect([l.summarized(A), l.summarized(B), l.summarized(C)]).toEqual([false, true, true]);
    expect(l.successorsOf("nope")).toEqual([]);
  });

  const notSuccessors: Array<[string, (b: Row) => Row]> = [
    ["no summary (a plain conversation that happens to start the same)", b => row(b, { summary: null })],
    ["a summary but another transcript (a sibling's compaction)", b => row(b, { transcript: ["> other", "x", "> /compact"] })],
    ["a transcript that only shares a first entry", b => row(b, { transcript: [transcriptOf(CAPTURED[0]!)[0]!, "diverged"] })],
    ["the same transcript, not longer", b => row(b, { transcript: transcriptOf(CAPTURED[0]!) })],
    ["an extended last entry, not a new one", b => row(b, { transcript: [...transcriptOf(CAPTURED[0]!).slice(0, -1), transcriptOf(CAPTURED[0]!).at(-1)! + "more"] })],
    ["created before A's last write", b => row(b, { created: CAPTURED[0]!.updated_at - 1 })],
    ["another directory", b => row(b, { key: "/elsewhere" })],
  ];
  for (const [label, reshape] of notSuccessors) {
    it(`not a successor: ${label}`, () => {
      store([CAPTURED[0]!, reshape(CAPTURED[1]!)]);
      expect(links().successorsOf(A)).toEqual([]);
    });
  }

  it("a successor created (and last written) exactly at A's last write still counts (no earlier)", () => {
    store([CAPTURED[0]!, row(CAPTURED[1]!, { created: CAPTURED[0]!.updated_at, updated: CAPTURED[0]!.updated_at })]);
    expect(links().successorsOf(A)).toEqual([B]);
  });

  it("whole entries only: [.., 1] is not continued by [.., 12, ..] (the \",\" boundary, not a text prefix)", () => {
    store([row(CAPTURED[0]!, { transcript: ["> a", 1 as never] }), row(CAPTURED[1]!, { transcript: ["> a", 12 as never, "> /compact"] })]);
    expect(links().successorsOf(A)).toEqual([]);
    rmSync(db);
    store([row(CAPTURED[0]!, { transcript: ["> a", 1 as never] }), row(CAPTURED[1]!, { transcript: ["> a", 1 as never, "> /compact"] })]);
    expect(links().successorsOf(A)).toEqual([B]);
  });

  it("only transcript arrays: objects that happen to share a text prefix are not continued", () => {
    store([row(CAPTURED[0]!, { transcript: { a: 1 } as never }), row(CAPTURED[1]!, { transcript: { a: 1, b: 2 } as never })]);
    expect(links().successorsOf(A)).toEqual([]);
  });

  it("an empty transcript proves nothing: every non-empty one would extend it", () => {
    store([row(CAPTURED[0]!, { transcript: [] }), CAPTURED[1]!]);
    expect(links().successorsOf(A)).toEqual([]);
  });

  it("a malformed row is never a successor and does not make the store unreadable", () => {
    store([CAPTURED[0]!], [["bad", "{not json", CAPTURED[1]!.created_at, CAPTURED[1]!.updated_at]]);
    expect(links().successorsOf(A)).toEqual([]);
    expect(links().summarized("bad")).toBe(false);
  });

  it("two continuations of A are both listed", () => {
    store([CAPTURED[0]!, CAPTURED[1]!, row(CAPTURED[1]!, { id: "B2", transcript: [...transcriptOf(CAPTURED[0]!), "> /compact", "> elsewhere"] })]);
    expect((links().successorsOf(A) as string[]).sort()).toEqual([B, "B2"].sort());
  });

  it("a store removed after the listing is unreadable, never 'no successor'", () => {
    store();
    const l = links();
    rmSync(join(root, "xdg"), { recursive: true });
    expect(l.successorsOf(A)).toBe("unreadable");
    expect(l.summarized(B)).toBe("unreadable");
  });
});

describe("a restart after /compact resumes the compacted conversation (the issue's case)", () => {
  it("record A, kiro went on in B: resumes B, records it, holds B, gives A up", () => {
    own(A);
    store(CAPTURED.slice(0, 2));
    expect(resolve()).toEqual({ mode: "resume", id: B, agentConfirmed: false, followed: [A] });
    expect(claimFile(B)).toBe("worker\n");
    expect(claimFile(A)).toBe("worker\nabandoned\n");
    // Settled: the next restart resumes B, with no successor to follow.
    expect(resolve()).toEqual({ mode: "resume", id: B, agentConfirmed: false });
  });

  it("two compactions between restarts: followed hop by hop to C", () => {
    own(A);
    store();
    expect(resolve()).toEqual({ mode: "resume", id: C, agentConfirmed: false, followed: [A, B] });
    expect([claimFile(A), claimFile(B), claimFile(C)]).toEqual(["worker\nabandoned\n", "worker\nabandoned\n", "worker\n"]);
  });

  it("the issue's shapes: B (history 176, latest_summary) after A (history 1335), same directory — B", () => {
    const T = 1_790_000_000_000;
    const turns = (n: number) => Array.from({ length: n }, (_, i) => i % 2 ? `answer ${i}` : `> prompt ${i}`);
    const history = (n: number) => Array.from({ length: n }, (_, i) => ({ user: { content: { Prompt: { prompt: `p${i}` } } } }));
    const a = row(CAPTURED[0]!, { id: "A-1335", created: T - 86_400_000, updated: T, transcript: turns(1335), summary: null });
    a.value.history = history(1335);
    const b = row(CAPTURED[1]!, { id: "B-176", created: T + 60_000, updated: T + 1_800_000, transcript: [...turns(1335), "> /compact", ...turns(175)], summary: ["the summary", {}] });
    b.value.history = history(176);
    store([a]);
    expect(resolve()).toMatchObject({ mode: "resume", id: "A-1335" });
    rmSync(db);
    store([a, b]);
    expect(resolve()).toEqual({ mode: "resume", id: "B-176", agentConfirmed: false, followed: ["A-1335"] });
  });

  it("the agent confirmation carries over: the continuation runs in the same session, as the same agent", () => {
    own(A);
    store([CAPTURED[0]!]);
    const state = join(home(), "kiro-identity", "instances");
    const file = join(state, readdirName(state));
    const s = JSON.parse(readFileSync(file, "utf-8"));
    for (const k of Object.keys(s.keys)) s.keys[k].agentConfirmed = true;
    writeFileSync(file, JSON.stringify(s));
    rmSync(db);
    store(CAPTURED.slice(0, 2));
    expect(resolve()).toMatchObject({ id: B, agentConfirmed: true });
  });
});

function readdirName(dir: string): string {
  const names = readdirSync(dir).filter(n => n.endsWith(".json") && !n.endsWith(".adopting.json"));
  expect(names).toHaveLength(1);
  return names[0]!;
}

describe("without proof the recorded id is kept, and the decision says why", () => {
  it("two continuations: ambiguous, A kept, neither claimed", () => {
    own(A);
    store([...CAPTURED.slice(0, 2), row(CAPTURED[1]!, { id: "B2", transcript: [...transcriptOf(CAPTURED[0]!), "> /compact", "> fork"] })]);
    expect(resolve()).toEqual({ mode: "resume", id: A, agentConfirmed: false, kept: { reason: "ambiguous", from: A, candidates: [B, "B2"].sort() } });
    expect(existsSync(join(claims(), B))).toBe(false);
    expect(existsSync(join(claims(), "B2"))).toBe(false);
  });

  it("B claimed by a sibling: never taken, A kept", () => {
    own(A);
    store(CAPTURED.slice(0, 2));
    writeFileSync(join(claims(), B), "sibling\n");
    expect(resolve()).toEqual({ mode: "resume", id: A, agentConfirmed: false, kept: { reason: "not-ours", from: A, candidate: B } });
    expect(claimFile(B)).toBe("sibling\n");
    expect(claimFile(A)).toBe("worker\n");
  });

  it("B's claim incomplete (being written by someone): not taken", () => {
    own(A);
    store(CAPTURED.slice(0, 2));
    writeFileSync(join(claims(), B), "work");
    expect(resolve()).toMatchObject({ id: A, kept: { reason: "not-ours", candidate: B } });
  });

  it("B already given up by this instance: not taken back", () => {
    own(A);
    store(CAPTURED.slice(0, 2));
    writeFileSync(join(claims(), B), "worker\nabandoned\n");
    expect(resolve()).toMatchObject({ id: A, kept: { reason: "not-ours", candidate: B } });
  });

  it("B on this instance's given-up list (its claim mark lost): not taken back", () => {
    own(A);
    store(CAPTURED.slice(0, 2));
    const dir = join(home(), "kiro-identity", "instances");
    const file = join(dir, readdirName(dir));
    const state = JSON.parse(readFileSync(file, "utf-8"));
    for (const k of Object.keys(state.keys)) state.keys[k].abandoned = [B];
    writeFileSync(file, JSON.stringify(state));
    expect(resolve()).toMatchObject({ id: A, kept: { reason: "not-ours", candidate: B } });
    expect(existsSync(join(claims(), B))).toBe(false);
  });

  it("a proven hop is kept when the next one is not: B resumed, C (a sibling's) left alone", () => {
    own(A);
    store();
    writeFileSync(join(claims(), C), "sibling\n");
    expect(resolve()).toEqual({ mode: "resume", id: B, agentConfirmed: false, followed: [A], kept: { reason: "not-ours", from: B, candidate: C } });
  });

  it("an unreadable store: A resumed as recorded", () => {
    own(A);
    mkdirSync(join(root, "xdg", "kiro-cli"), { recursive: true });
    writeFileSync(db, "not a database");
    expect(resolve()).toEqual({ mode: "resume", id: A, agentConfirmed: false, kept: { reason: "unreadable" } });
  });

  it("links that turn unreadable mid-way keep what was proven", () => {
    own(A);
    store();
    const real = listKiroV1Sessions(cwd, db) as Extract<KiroStoreRead, { kind: "ok" }>;
    const readStore = (): KiroStoreRead => ({ ...real, compaction: { ...real.compaction!, successorsOf: id => id === B ? "unreadable" : real.compaction!.successorsOf(id) } });
    expect(resolve("worker", { readStore })).toEqual({ mode: "resume", id: B, agentConfirmed: false, followed: [A], kept: { reason: "unreadable" } });
  });

  it("a record that cannot be written refuses the launch; the retry follows the same way", () => {
    own(A);
    store(CAPTURED.slice(0, 2));
    const instances = join(home(), "kiro-identity", "instances");
    chmodSync(instances, 0o500);
    try { expect(() => resolve()).toThrow(KiroIdentityError); } finally { chmodSync(instances, 0o700); }
    expect(claimFile(B)).toBe("worker\n"); // held: the retry follows it again
    expect(claimFile(A)).toBe("worker\n"); // not given up before the record moved
    expect(resolve()).toEqual({ mode: "resume", id: B, agentConfirmed: false, followed: [A] });
  });

  it("the TUI's V2 keeps its id through a compaction: its store is never read on a resume", () => {
    const v2 = (readStore: () => KiroStoreRead) => resolve("worker", { engine: "v2", readStore });
    expect(v2(() => ({ kind: "ok", sessions: [{ id: "t1", updatedAt: 1 }], createdAt: () => 1 }))).toMatchObject({ id: "t1" });
    expect(v2(() => { throw new KiroIdentityError("v2 session discovery was not prepared for this launch"); })).toEqual({ mode: "resume", id: "t1", agentConfirmed: false });
  });
});

describe("a fresh start that compacted before its first restart (take-up)", () => {
  const fresh = () => expect(resolve("worker", { launchedBefore: () => false, now: () => 1_000 })).toEqual({ mode: "fresh" });
  const later = (r: Row, by: number): Row => row(r, { created: r.created_at - CAPTURED[0]!.created_at + 10_000 + by, updated: r.updated_at - CAPTURED[0]!.created_at + 10_000 + by });

  it("its conversation compacted twice: one chain, its newest taken up", () => {
    fresh();
    store(CAPTURED.map(r => later(r, 0)));
    expect(resolve()).toEqual({ mode: "resume", id: C, agentConfirmed: true, followed: [A, B] });
    expect([claimFile(A), claimFile(B), claimFile(C)]).toEqual(["worker\nabandoned\n", "worker\nabandoned\n", "worker\n"]);
  });

  it("a take-up whose record cannot be written refuses the launch, gives nothing up, and the retry takes the same chain", () => {
    fresh();
    store(CAPTURED.map(r => later(r, 0)));
    const instances = join(home(), "kiro-identity", "instances");
    chmodSync(instances, 0o500);
    try { expect(() => resolve()).toThrow(KiroIdentityError); } finally { chmodSync(instances, 0o700); }
    expect([claimFile(A), claimFile(B), claimFile(C)]).toEqual(["worker\n", "worker\n", "worker\n"]);
    expect(resolve()).toEqual({ mode: "resume", id: C, agentConfirmed: true, followed: [A, B] });
    expect([claimFile(A), claimFile(B), claimFile(C)]).toEqual(["worker\nabandoned\n", "worker\nabandoned\n", "worker\n"]);
  });

  it("another instance's compaction (its predecessor is from before the mark) is never taken: only the own one", () => {
    store([row(CAPTURED[0]!, { created: 10, updated: 20 })]); // X's A, before this fresh start
    fresh();
    rmSync(db);
    const own1 = row(CAPTURED[0]!, { id: "Y1", created: 2_000, updated: 2_500, transcript: ["> mine", "ok"] });
    store([row(CAPTURED[0]!, { created: 10, updated: 20 }), row(CAPTURED[1]!, { created: 3_000, updated: 4_000 }), own1]);
    expect(resolve()).toEqual({ mode: "resume", id: "Y1", agentConfirmed: true });
    expect(existsSync(join(claims(), B))).toBe(false);
  });

  it("only another instance's compaction appeared: nothing taken up", () => {
    store([row(CAPTURED[0]!, { created: 10, updated: 20 })]);
    fresh();
    rmSync(db);
    store([row(CAPTURED[0]!, { created: 10, updated: 20 }), row(CAPTURED[1]!, { created: 3_000, updated: 4_000 }), row(CAPTURED[2]!, { created: 5_000, updated: 6_000 })]);
    expect(resolve()).toEqual({ mode: "fresh" });
    expect(existsSync(join(claims(), B))).toBe(false);
    expect(existsSync(join(claims(), C))).toBe(false);
  });

  it("two own roots, or a fork, is still more than one: fresh", () => {
    fresh();
    store([...CAPTURED.slice(0, 2).map(r => later(r, 0)), row(CAPTURED[0]!, { id: "Y2", created: 50_000, updated: 50_000, transcript: ["> other"] })]);
    expect(resolve()).toEqual({ mode: "fresh" });
  });

  it("a fork of the own conversation is not a chain: fresh", () => {
    fresh();
    const b2 = later(row(CAPTURED[1]!, { id: "B2", transcript: [...transcriptOf(CAPTURED[0]!), "> /compact", "> fork"] }), 1);
    store([...CAPTURED.slice(0, 2).map(r => later(r, 0)), b2]);
    expect(resolve()).toEqual({ mode: "fresh" });
  });
});

describe("claim not held → fresh start: said, not silent (the issue's side note)", () => {
  const cases: Array<[string, string, "missing" | "incomplete" | "other-owner" | "abandoned"]> = [
    ["no trailing newline, as hand-written in the issue", "worker", "incomplete"],
    ["another owner", "sibling\n", "other-owner"],
    ["given up", "worker\nabandoned\n", "abandoned"],
  ];
  for (const [label, text, claim] of cases) {
    it(`${label}: fresh, and the decision names the id and why`, () => {
      own(A);
      writeFileSync(join(claims(), A), text);
      expect(resolve()).toEqual({ mode: "fresh", lost: { id: A, claim } });
    });
  }
  it("a missing claim file", () => {
    own(A);
    rmSync(join(claims(), A));
    expect(resolve()).toEqual({ mode: "fresh", lost: { id: A, claim: "missing" } });
  });
});

const COMPAT: KiroCliCompatibility = {
  version: "kiro-cli 2.34.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true, supportsInstanceAgent: true, source: "version",
};
describe("the backend: what the operator is told", () => {
  const launch = () => {
    const backend = new KiroBackend(join(root, "agend", "instances", "worker"), COMPAT);
    const cfg = { workingDirectory: cwd, instanceDir: join(root, "agend", "instances", "worker"), instanceName: "worker", kiroUi: "legacy",
      mcpServers: { agend: { command: "node", args: ["server.js"], env: {} } }, instructions: "hi" } as never;
    backend.writeConfig(cfg);
    return { backend, cmd: backend.buildCommand(cfg) };
  };
  beforeEach(() => mkdirSync(join(root, "agend", "instances", "worker"), { recursive: true }));

  it("a followed compaction: --resume-id B, and a quiet note for the Log tab (no chat warning)", () => {
    own(A);
    store(CAPTURED.slice(0, 2));
    const { backend, cmd } = launch();
    expect(cmd).toContain(`--resume-id '${B}'`);
    expect(backend.consumeQuietLaunchNotes()).toEqual([t("kiro.compaction_followed", A, B)]);
    expect(backend.consumeLaunchWarning()).toBeNull();
    expect(backend.consumeQuietLaunchNotes()).toEqual([]);
  });

  it("a direct buildCommand (no writeConfig before it) says the same", () => {
    own(A);
    store(CAPTURED.slice(0, 2));
    const backend = new KiroBackend(join(root, "agend", "instances", "worker"), COMPAT);
    const cmd = backend.buildCommand({ workingDirectory: cwd, instanceDir: join(root, "agend", "instances", "worker"), instanceName: "worker", kiroUi: "legacy",
      mcpServers: { agend: { command: "node", args: ["server.js"], env: {} } }, instructions: "hi" } as never);
    expect(cmd).toContain(`--resume-id '${B}'`);
    expect(backend.consumeQuietLaunchNotes()).toEqual([t("kiro.compaction_followed", A, B)]);
  });

  it("kept for a reason: --resume-id A, and the reason as a quiet note", () => {
    own(A);
    store(CAPTURED.slice(0, 2));
    writeFileSync(join(claims(), B), "sibling\n");
    const { backend, cmd } = launch();
    expect(cmd).toContain(`--resume-id '${A}'`);
    expect(backend.consumeQuietLaunchNotes()).toEqual([t("kiro.compaction_kept_not_ours", A, A, B)]);
  });

  it("an incomplete claim: a fresh start, with a launch warning saying which conversation and why", () => {
    own(A);
    writeFileSync(join(claims(), A), "worker");
    const { backend, cmd } = launch();
    expect(cmd).not.toContain("--resume-id");
    expect(backend.consumeLaunchWarning()).toBe(t("kiro.claim_lost", A, t("kiro.claim_lost_incomplete")));
  });
});
