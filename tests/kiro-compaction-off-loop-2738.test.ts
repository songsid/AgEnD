/**
 * #2738: the 2.3.2-beta.13 update rolled back — the fleet missed systemd's 60 s watchdog while it launched a classic
 * kiro instance (the coordinator). Its recorded conversation had been compacted 33 times (each restart on beta.10
 * resumed the pre-compaction one, #2714), and #2719's successor query parsed every ~26 MB transcript again for every
 * pair, synchronously on the fleet loop: 287 s on a copy of that store. These pin the fix: the links are worked out on
 * a worker lane in prepareLaunch, in one pass, within a time and size budget; writeConfig only looks them up; over
 * budget the launch stays on the recorded conversation and says so. Scratch directories only: no kiro, fleet or tmux.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kiroDirectoryKeys, listKiroV1Sessions, readKiroClassicLinks, resolveKiroIdentity } from "../src/backend/kiro-identity.js";
import { computeKiroClassicLinks } from "../src/backend/kiro-classic-links.js";
import { KiroV2StoreLane, sharedKiroClassicLinksLane, sharedKiroV2StoreLane } from "../src/backend/kiro-v2-store.js";
import { KiroBackend, type KiroCliCompatibility } from "../src/backend/kiro.js";
import { t } from "../src/locale.js";
import { classicLinks } from "./support/kiro-classic-links.js";

interface Row { key: string; conversation_id: string; created_at: number; updated_at: number; value: Record<string, unknown> }
const CAPTURED: Row[] = JSON.parse(readFileSync(join(__dirname, "fixtures", "kiro-2.34.0-compact-2714", "conversations_v2.json"), "utf-8"));
const BASE = CAPTURED[0]!;
const A = BASE.conversation_id;

let root: string, cwd: string, db: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-2738-"));
  cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "agend", "instances", "coordinator"), { recursive: true });
  db = join(root, "xdg", "kiro-cli", "data.sqlite3");
  vi.stubEnv("AGEND_HOME", join(root, "agend"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
  vi.stubEnv("KIRO_HOME", join(root, "kiro-home"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); });

/**
 * The coordinator's shape, scaled down: A (its transcript `prefixBytes` long) and `siblings` compactions of it, each
 * A's whole transcript, "> /compact", and its own `ownBytes` — none continues another. Rows written as kiro does.
 */
function siblingsStore(siblings: number, prefixBytes: number, ownBytes: number): string[] {
  mkdirSync(join(root, "xdg", "kiro-cli"), { recursive: true });
  const d = new Database(db);
  d.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);");
  const ins = d.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)");
  const transcript = [...(BASE.value.transcript as string[]), "x".repeat(prefixBytes)];
  ins.run(cwd, A, JSON.stringify({ ...BASE.value, transcript }), BASE.created_at, BASE.updated_at);
  const ids: string[] = [];
  for (let i = 0; i < siblings; i++) {
    const id = `5${String(i).padStart(7, "0")}-0000-4000-8000-000000002738`;
    const at = BASE.updated_at + 60_000 * (i + 1);
    ins.run(cwd, id, JSON.stringify({ ...BASE.value, conversation_id: id, latest_summary: `summary ${i}`,
      transcript: [...transcript, "> /compact", `${i} `.repeat(ownBytes / 2)] }), at, at + 30_000);
    ids.push(id);
  }
  d.close();
  return ids.sort();
}

/** The coordinator holds A, recorded the way #906 adopts it (the only conversation in its directory). */
function holdA(): void {
  const keep = db + ".full";
  mkdirSync(join(root, "xdg", "kiro-cli"), { recursive: true });
  rmSync(keep, { force: true });
  const d = new Database(db);
  d.exec(`VACUUM INTO '${keep}'`);
  d.prepare("DELETE FROM conversations_v2 WHERE conversation_id != ?").run(A);
  d.close();
  expect(resolveKiroIdentity({ instance: "coordinator", engine: "v1", workingDirectory: cwd, credentialProfile: null, agendHome: join(root, "agend"),
    readStore: () => listKiroV1Sessions(cwd, db, classicLinks(cwd, db)), launchedBefore: () => true })).toMatchObject({ mode: "resume", id: A });
  rmSync(db);
  const back = new Database(keep);
  back.exec(`VACUUM INTO '${db}'`);
  back.close();
  rmSync(keep);
}

const COMPAT: KiroCliCompatibility = {
  version: "kiro-cli 2.34.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true, supportsInstanceAgent: true, source: "version",
};
const config = () => ({ workingDirectory: cwd, instanceDir: join(root, "agend", "instances", "coordinator"), instanceName: "coordinator", kiroUi: "legacy",
  mcpServers: { agend: { command: "node", args: ["server.js"], env: {} } }, instructions: "hi" }) as never;

/** The longest the loop went without running a 20 ms interval (what the systemd watchdog ping is) while `work` ran. */
async function longestStall(work: () => Promise<void> | void): Promise<number> {
  let last = performance.now(), longest = 0;
  const probe = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 20);
  try {
    await work();
    await new Promise(r => setTimeout(r, 40)); // a stall that ends with `work` is measured by the next tick
  } finally { clearInterval(probe); }
  return longest;
}

describe("the launch never works out compaction links on the fleet loop", () => {
  it("the coordinator's shape: prepareLaunch + writeConfig keep the loop turning, and it stays on A (ambiguous)", async () => {
    const siblings = siblingsStore(24, 1_000_000, 400_000);
    holdA();
    const backend = new KiroBackend(join(root, "agend", "instances", "coordinator"), COMPAT);
    let cmd = "";
    const stall = await longestStall(async () => {
      await backend.prepareLaunch(config());
      backend.writeConfig(config());
      cmd = backend.buildCommand(config());
    });
    // Before #2738 writeConfig ran the pairwise query here, seconds without a tick (287 s on the real store).
    expect(stall, "the loop stalled while the launch read the store").toBeLessThan(1_500);
    expect(cmd).toContain(`--resume-id '${A}'`);
    expect(backend.consumeQuietLaunchNotes()).toEqual([t("kiro.compaction_kept_ambiguous", A, A, siblings.join(", "))]);
  }, 120_000);

  it("writeConfig without prepareLaunch reads no transcript: it stays on A, unproven, at once", async () => {
    siblingsStore(24, 1_000_000, 400_000);
    holdA();
    const backend = new KiroBackend(join(root, "agend", "instances", "coordinator"), COMPAT);
    const started = performance.now();
    backend.writeConfig(config());
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(backend.buildCommand(config())).toContain(`--resume-id '${A}'`);
    expect(backend.consumeQuietLaunchNotes()).toEqual([t("kiro.compaction_kept_unreadable", A)]);
  }, 60_000);

  it("links prepared for another launch are not this one's: unproven, it stays on A", async () => {
    const [B] = siblingsStore(1, 10, 10);
    holdA();
    const backend = new KiroBackend(join(root, "agend", "instances", "coordinator"), COMPAT);
    await backend.prepareLaunch({ ...(config() as object), instanceName: "someone-else" } as never);
    backend.writeConfig(config());
    expect(backend.buildCommand(config())).toContain(`--resume-id '${A}'`);
    expect(backend.consumeQuietLaunchNotes()).toEqual([t("kiro.compaction_kept_unreadable", A)]);
    // Prepared for this launch, the same store is followed: what the line above is not.
    await backend.prepareLaunch(config());
    backend.writeConfig(config());
    expect(backend.buildCommand(config())).toContain(`--resume-id '${B}'`);
  });

  it("a prepared launch whose store answer was over budget stays on A and says so on the Log tab, not in chat", async () => {
    siblingsStore(2, 10, 10);
    holdA();
    vi.spyOn(sharedKiroClassicLinksLane, "read").mockResolvedValue({ kind: "unreadable", detail: sharedKiroClassicLinksLane.timedOut });
    const backend = new KiroBackend(join(root, "agend", "instances", "coordinator"), COMPAT);
    await backend.prepareLaunch(config());
    backend.writeConfig(config());
    expect(backend.buildCommand(config())).toContain(`--resume-id '${A}'`);
    expect(backend.consumeQuietLaunchNotes()).toEqual([t("kiro.compaction_kept_over_budget", A)]);
    expect(backend.consumeLaunchWarning()).toBeNull();
  });

  it("the classic links have their own lane: a long classic read never spends a v2 launch's budget", () => {
    expect(sharedKiroClassicLinksLane).not.toBe(sharedKiroV2StoreLane);
  });
});

/** Rows as given: [id, transcript, summary or null, created, updated, extra value bytes]. */
function rawStore(rows: Array<[string, unknown[], string | null, number, number, number]>): void {
  mkdirSync(join(root, "xdg", "kiro-cli"), { recursive: true });
  const d = new Database(db);
  d.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);");
  const ins = d.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)");
  for (const [id, transcript, summary, created, updated, pad] of rows) {
    ins.run(cwd, id, JSON.stringify({ conversation_id: id, transcript, ...(summary === null ? {} : { latest_summary: summary }), pad: "p".repeat(pad) }), created, updated);
  }
  d.close();
}
const linksHere = () => computeKiroClassicLinks({ dbPath: db, keys: kiroDirectoryKeys(cwd) }, () => false);

describe("the one-pass proof matches the SQL it replaced (#2739 review)", () => {
  it("a cut inside a surrogate pair: an unrelated shorter transcript never hides a continuation", () => {
    // X's cut (3) falls between the halves of P's "😀": hashed as separately encoded UTF-8 chunks, that broke P's hash.
    rawStore([["X", [""], null, 1, 1, 0], ["P", ["😀"], null, 2, 2, 0], ["B", ["😀", "next"], "s", 3, 3, 0]]);
    expect(linksHere()).toMatchObject({ kind: "ok", successors: { P: ["B"] } });
  });

  it("all four timestamps equal and the predecessor's value the bigger: still found (a tie never means 'no successor')", () => {
    rawStore([["P", ["a"], null, 1, 1, 1000], ["B", ["a", "next"], "s", 1, 1, 0]]);
    expect(linksHere()).toMatchObject({ kind: "ok", successors: { P: ["B"] } });
  });

  it("a tie inside a chain keeps first hops: P → B → C, all timestamps equal, sizes reversed", () => {
    rawStore([["P", ["a"], null, 1, 1, 2000], ["B", ["a", "b"], "s", 1, 1, 1000], ["C", ["a", "b", "c"], "s", 1, 1, 0]]);
    const links = linksHere();
    expect(links.kind === "ok" && [links.successors.P, links.successors.B, links.successors.C]).toEqual([["B"], ["C"], undefined]);
  });
});

describe("the budget: over it is unproven, never a guess", () => {
  it("out of time on the lane: over-budget", async () => {
    siblingsStore(2, 10, 10);
    const lane = new KiroV2StoreLane(undefined, undefined, 1, "classic compaction links");
    try {
      expect(await readKiroClassicLinks(cwd, db, lane)).toEqual({ kind: "over-budget", detail: lane.timedOut });
    } finally { lane.close(); }
  });

  it("over the size budget: over-budget before any transcript is read", () => {
    siblingsStore(2, 10, 10);
    const late = vi.fn(() => false);
    expect(computeKiroClassicLinks({ dbPath: db, keys: kiroDirectoryKeys(cwd), maxBytes: 1 }, late)).toMatchObject({ kind: "over-budget" });
    expect(late).not.toHaveBeenCalled();
  });

  it("the clock is asked before each transcript: late after the first is over-budget", () => {
    siblingsStore(3, 10, 10);
    let asked = 0;
    expect(computeKiroClassicLinks({ dbPath: db, keys: kiroDirectoryKeys(cwd) }, () => ++asked > 1)).toMatchObject({ kind: "over-budget" });
    expect(asked).toBe(2);
  });

  it("within budget the lane gives the same links as in-process (the siblings: all first hops of A)", async () => {
    const siblings = siblingsStore(3, 10, 10);
    const links = await readKiroClassicLinks(cwd, db);
    expect(links).toEqual(classicLinks(cwd, db));
    expect(links.kind === "ok" && links.successors[A]).toEqual(siblings);
  });

  it("over budget, the resolver resumes the recorded conversation with the reason", () => {
    siblingsStore(2, 10, 10);
    holdA();
    expect(resolveKiroIdentity({ instance: "coordinator", engine: "v1", workingDirectory: cwd, credentialProfile: null, agendHome: join(root, "agend"),
      readStore: () => listKiroV1Sessions(cwd, db, { kind: "over-budget", detail: "slow" }), launchedBefore: () => true }))
      .toEqual({ mode: "resume", id: A, agentConfirmed: false, kept: { reason: "over-budget" } });
  });
});
