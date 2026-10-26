/**
 * #2714 follow-up: migrate_kiro_instance carries where a classic conversation went on after /compact. Classic kiro
 * continues a compacted conversation under a new id, and the identity record follows it only on the next classic launch;
 * a compacted instance not restarted since used to carry its pre-compaction copy into the TUI — and the move is one-way.
 * Real identity files and a real SQLite store seeded from kiro-cli 2.34.0's captured rows
 * (tests/fixtures/kiro-2.34.0-compact-2714); kiro, the fleet and tmux are never run.
 */
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kiroRecordedConversation, listKiroV1Sessions, resolveKiroIdentity, type KiroStoreRead } from "../src/backend/kiro-identity.js";
import { applyKiroMigration, kiroMigrationPrompt, planKiroMigration, type KiroMigrateDeps } from "../src/kiro-migrate.js";
import { t } from "../src/locale.js";
import type { FleetConfig } from "../src/types.js";

interface Row { key: string; conversation_id: string; created_at: number; updated_at: number; value: Record<string, unknown> }
const CAPTURED: Row[] = JSON.parse(readFileSync(join(__dirname, "fixtures", "kiro-2.34.0-compact-2714", "conversations_v2.json"), "utf-8"));
const [A, B, C] = CAPTURED.map(r => r.conversation_id) as [string, string, string];

let root: string, home: string, cwd: string, db: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kiro-mig-2714-"));
  home = join(root, "agend"); cwd = join(root, "work"); db = join(root, "kiro-cli", "data.sqlite3");
  mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true });
  vi.stubEnv("AGEND_HOME", home);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function store(rows: Row[]): void {
  rmSync(db, { force: true });
  mkdirSync(join(root, "kiro-cli"), { recursive: true });
  const d = new Database(db);
  d.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);");
  const ins = d.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)");
  for (const r of rows) ins.run(cwd, r.conversation_id, JSON.stringify(r.value), r.created_at, r.updated_at);
  d.close();
}
const fork = (): Row => ({ ...CAPTURED[1]!, conversation_id: "B2",
  value: { ...CAPTURED[1]!.value, conversation_id: "B2", transcript: [...(CAPTURED[0]!.value.transcript as string[]), "> /compact", "> fork"] } });

const claims = () => join(home, "kiro-identity", "claims", "v1");
const claimFile = (id: string) => readFileSync(join(claims(), id), "utf-8");
const classicLaunch = () => resolveKiroIdentity({ instance: "wiki", engine: "v1", workingDirectory: cwd, credentialProfile: null, agendHome: home,
  readStore: () => listKiroV1Sessions(cwd, db), launchedBefore: () => true });
/** wiki owns A (its classic launch recorded it), then compacted twice without a restart: kiro now writes C. */
function compactedSinceLaunch(rows: Row[] = CAPTURED): void {
  store([CAPTURED[0]!]);
  expect(classicLaunch()).toMatchObject({ mode: "resume", id: A });
  store(rows);
}

function deps(over: Partial<KiroMigrateDeps> = {}) {
  const fleet = { defaults: {}, instances: { wiki: { backend: "kiro-cli", working_directory: cwd } } } as unknown as FleetConfig;
  const d: KiroMigrateDeps = {
    agendHome: home, fleetConfig: () => fleet, saveFleetConfig: () => {}, status: () => "running",
    restart: vi.fn(async () => {}), reserve: () => ({ current: () => true, release: () => {} }),
    preflight: vi.fn(async () => "claude-sonnet-4.6"), verify: vi.fn(async () => ({ forensic: "clean" })), stop: vi.fn(async () => {}),
    readClassicStore: (dir: string) => listKiroV1Sessions(dir, db),
    ...over,
  };
  return { d, fleet };
}
const v2Pending = () => kiroRecordedConversation({ agendHome: home, instance: "wiki", engine: "v2", workingDirectory: cwd, credentialProfile: null });

describe("judging the move: the conversation carried is where the classic one went on", () => {
  it("compacted twice since its launch: the plan carries C, says so, and writes nothing", () => {
    compactedSinceLaunch();
    const judged = planKiroMigration(deps().d, "wiki", false);
    expect(judged).toEqual({ ok: true, plan: { name: "wiki", workingDirectory: cwd, credentialProfile: null, classicId: C, compactedFrom: [A, B] } });
    if (!judged.ok) throw new Error(judged.error);
    expect(kiroMigrationPrompt(judged.plan, true)).toContain(t("kiro_migrate.prompt_compacted", A, C));
    expect(existsSync(join(claims(), B))).toBe(false);
    expect(existsSync(join(claims(), C))).toBe(false);
    expect(claimFile(A)).toBe("wiki\n");
  });

  it("not compacted: unchanged, the recorded conversation and no compaction line", () => {
    compactedSinceLaunch([CAPTURED[0]!]);
    const judged = planKiroMigration(deps().d, "wiki", false);
    expect(judged).toEqual({ ok: true, plan: { name: "wiki", workingDirectory: cwd, credentialProfile: null, classicId: A } });
  });

  const refused: Array<[string, () => void, (d: KiroMigrateDeps) => void, string]> = [
    ["two continuations of A", () => compactedSinceLaunch([...CAPTURED.slice(0, 2), fork()]), () => {},
      t("kiro_migrate.compaction_ambiguous", A, [B, "B2"].sort().join(", "))],
    ["its continuation claimed by another instance", () => { compactedSinceLaunch(CAPTURED.slice(0, 2)); writeFileSync(join(claims(), B), "sibling\n"); }, () => {},
      t("kiro_migrate.compaction_not_ours", A, B)],
    ["the store unreadable", () => compactedSinceLaunch(), d => { d.readClassicStore = (): KiroStoreRead => ({ kind: "unreadable", detail: "locked" }); },
      t("kiro_migrate.compaction_unreadable")],
  ];
  for (const [label, arrange, tweak, reason] of refused) {
    it(`unproven — ${label}: refused, nothing changed`, () => {
      arrange();
      const { d } = deps(); tweak(d);
      expect(planKiroMigration(d, "wiki", false)).toEqual({ ok: false, error: t("kiro_migrate.refused_compaction", "wiki", A, reason) });
    });
  }

  it("a proven hop and an unproven next one still refuses: carrying B could leave C's work behind", () => {
    compactedSinceLaunch();
    writeFileSync(join(claims(), C), "sibling\n");
    expect(planKiroMigration(deps().d, "wiki", false)).toEqual({ ok: false, error: t("kiro_migrate.refused_compaction", "wiki", B, t("kiro_migrate.compaction_not_ours", B, C)) });
  });
});

describe("a long chain is followed to its end (#2721 review: no hop budget)", () => {
  /** A conversation and `n` compactions of it, each continuing the one before. */
  const chain = (n: number): Row[] => {
    const base = CAPTURED[0]!;
    return Array.from({ length: n + 1 }, (_, i) => ({
      key: base.key, conversation_id: i ? `hop-${i}` : A, created_at: base.created_at + i * 1000, updated_at: base.created_at + i * 1000 + 500,
      value: { ...base.value, conversation_id: i ? `hop-${i}` : A, latest_summary: i ? ["summary", {}] : null,
        transcript: Array.from({ length: i + 2 }, (_, k) => k ? `> turn ${k}` : "> start") },
    }));
  };
  for (const n of [64, 65, 80]) {
    it(`${n} compactions since the launch: the plan carries hop-${n}, and applying arms it`, async () => {
      compactedSinceLaunch(chain(n));
      const { d } = deps();
      const judged = planKiroMigration(d, "wiki", false);
      if (!judged.ok) throw new Error(judged.error);
      expect(judged.plan.classicId).toBe(`hop-${n}`);
      expect(judged.plan.compactedFrom).toHaveLength(n);
      expect((await applyKiroMigration(d, judged.plan)).ok).toBe(true);
      expect(v2Pending()).toBe(`hop-${n}`);
    });
  }
  it("links that loop back (never kiro's, but no budget stops it) end at the revisit, refused as not this instance's", () => {
    compactedSinceLaunch([CAPTURED[0]!]);
    const real = listKiroV1Sessions(cwd, db) as Extract<KiroStoreRead, { kind: "ok" }>;
    const loop: Record<string, string> = { [A]: "L1", L1: "L2", L2: A };
    const readClassicStore = (): KiroStoreRead => ({ ...real, compaction: { successorsOf: id => [loop[id]!], summarized: () => true } });
    expect(planKiroMigration(deps({ readClassicStore }).d, "wiki", false))
      .toEqual({ ok: false, error: t("kiro_migrate.refused_compaction", "wiki", "L2", t("kiro_migrate.compaction_not_ours", "L2", A)) });
  });
  it("the classic launch follows the same long chain", () => {
    compactedSinceLaunch(chain(65));
    expect(classicLaunch()).toMatchObject({ mode: "resume", id: "hop-65" });
  });
});

describe("applying the move", () => {
  it("records the walk as a classic launch would, then arms C: the TUI launch resumes C", async () => {
    compactedSinceLaunch();
    const { d, fleet } = deps();
    const judged = planKiroMigration(d, "wiki", false);
    if (!judged.ok) throw new Error(judged.error);
    const outcome = await applyKiroMigration(d, judged.plan);
    expect(outcome.ok).toBe(true);
    expect(fleet.instances.wiki.kiro_ui).toBe("tui");
    expect(v2Pending()).toBe(C);
    expect([claimFile(A), claimFile(B), claimFile(C)]).toEqual(["wiki\nabandoned\n", "wiki\nabandoned\n", "wiki\n"]);
    expect(d.verify).toHaveBeenCalledWith("wiki", C, "claude-sonnet-4.6", false);
    // The real TUI resolver takes the armed id.
    expect(resolveKiroIdentity({ instance: "wiki", engine: "v2", workingDirectory: cwd, credentialProfile: null, agendHome: home,
      readStore: () => ({ kind: "ok", sessions: [], createdAt: () => null }), launchedBefore: () => false })).toMatchObject({ mode: "resume", id: C });
  });

  it("compacted after the plan was asked for: the carried id changed, so it asks again and changes nothing", async () => {
    compactedSinceLaunch(CAPTURED.slice(0, 2));
    const { d, fleet } = deps();
    const judged = planKiroMigration(d, "wiki", false);
    if (!judged.ok) throw new Error(judged.error);
    expect(judged.plan.classicId).toBe(B);
    store(CAPTURED); // the instance compacted again while the prompt waited
    expect(await applyKiroMigration(d, judged.plan)).toEqual({ ok: false, text: t("kiro_migrate.changed", "wiki") });
    expect(d.preflight).not.toHaveBeenCalled(); // judged again before anything else runs
    expect(fleet.instances.wiki.kiro_ui).toBeUndefined();
    expect(v2Pending()).toBeNull();
    expect(existsSync(join(claims(), B))).toBe(false);
  });

  it("taken by another instance during the checks: refused before anything is armed or saved", async () => {
    compactedSinceLaunch();
    const saveFleetConfig = vi.fn();
    const { d, fleet } = deps({ saveFleetConfig, preflight: vi.fn(async () => { writeFileSync(join(claims(), C), "sibling\n"); return "claude-sonnet-4.6"; }) });
    const judged = planKiroMigration(d, "wiki", false);
    if (!judged.ok) throw new Error(judged.error);
    const outcome = await applyKiroMigration(d, judged.plan);
    expect(outcome).toEqual({ ok: false, text: t("kiro_migrate.failed", "wiki", t("kiro_migrate.refused_compaction", "wiki", B, t("kiro_migrate.compaction_not_ours", B, C))) });
    expect(saveFleetConfig).not.toHaveBeenCalled();
    expect(fleet.instances.wiki.kiro_ui).toBeUndefined();
    expect(v2Pending()).toBeNull();
    expect(d.stop).not.toHaveBeenCalled();
  });

  it("a classic record that cannot be written: refused before anything is armed; the claims it took stay its own", async () => {
    compactedSinceLaunch();
    const instances = join(home, "kiro-identity", "instances");
    const { d, fleet } = deps({ preflight: vi.fn(async () => { chmodSync(instances, 0o500); return "claude-sonnet-4.6"; }) });
    const judged = planKiroMigration(d, "wiki", false);
    if (!judged.ok) throw new Error(judged.error);
    let outcome: { ok: boolean; text: string };
    try { outcome = await applyKiroMigration(d, judged.plan); } finally { chmodSync(instances, 0o700); }
    expect(outcome.ok).toBe(false);
    expect(fleet.instances.wiki.kiro_ui).toBeUndefined();
    expect(readdirSync(instances).some(n => n.endsWith(".adopting.json"))).toBe(false);
    expect(v2Pending()).toBeNull();
    expect([claimFile(A), claimFile(B), claimFile(C)]).toEqual(["wiki\n", "wiki\n", "wiki\n"]);
    // The classic launch (or the asked-again move) follows the same chain.
    expect(classicLaunch()).toMatchObject({ mode: "resume", id: C, followed: [A, B] });
  });
});
