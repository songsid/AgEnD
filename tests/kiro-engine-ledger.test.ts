/**
 * kiro V1 → V3 migration, P0: every kiro launch is recorded (kiro-cli version,
 * AgEnD version, UI and pinned engine flags), and a V3 instance resumes its
 * own V3 session by id — never kiro's `--resume`, which on V3 converts the
 * newest classic conversation into a new copy on every launch.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KiroBackend, type KiroCliCompatibility } from "../src/backend/kiro.js";
import { agendVersion, kiroLedgerPath, readKiroLedger, recordKiroLaunch } from "../src/backend/kiro-engine-ledger.js";
import { kasBucket, listKasSessions } from "../src/backend/kiro-kas-store.js";
import type { CliBackendConfig } from "../src/backend/types.js";

const KIRO: KiroCliCompatibility = {
  version: "kiro-cli 2.27.1", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true, source: "help",
};

const dirs: string[] = [];
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
let saved: { AGEND_HOME?: string; KIRO_HOME?: string };
let agendHome: string;
let kiroHome: string;
let work: string;

beforeEach(() => {
  saved = { AGEND_HOME: process.env.AGEND_HOME, KIRO_HOME: process.env.KIRO_HOME };
  agendHome = scratch("agend-ledger-home-");
  kiroHome = scratch("agend-ledger-kiro-");
  work = scratch("agend-ledger-work-");
  process.env.AGEND_HOME = agendHome;
  process.env.KIRO_HOME = kiroHome;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A V3 session directory as kiro writes it. */
function kasSession(cwd: string, id: string, createdAt: string, lastModifiedAt = createdAt): void {
  const dir = join(kiroHome, "sessions", kasBucket(cwd), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ id, createdAt, lastModifiedAt, schemaVersion: "1.0.0" }));
  writeFileSync(join(dir, "messages.jsonl"), "");
}

const config = (over: Partial<CliBackendConfig> = {}): CliBackendConfig => ({
  workingDirectory: work, instanceDir: scratch("agend-ledger-inst-"), instanceName: "inst-a", mcpServers: {}, ...over,
});

describe("the engine ledger", () => {
  it("records each launch — kiro-cli version, AgEnD version, UI, pinned flags — owner-only, one history row per change", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 3, 12, m));
    const base = { instance: "a", workingDirectory: "/w", credentialProfile: null, kiroVersion: "kiro-cli 2.27.1", ui: "legacy" as const, flags: ["--legacy-ui", "--agent-engine=v1"] };
    expect(recordKiroLaunch({ ...base, now: at(0) })).toBe(true);
    expect(recordKiroLaunch({ ...base, now: at(1) })).toBe(true);
    expect(recordKiroLaunch({ ...base, kiroVersion: "kiro-cli 3.0.0", now: at(2) })).toBe(true);
    const entry = readKiroLedger().a;
    expect(entry.firstSeen).toBe(at(0).toISOString());
    expect(entry.lastLaunch).toMatchObject({ at: at(2).toISOString(), kiroVersion: "kiro-cli 3.0.0", agendVersion: agendVersion(), ui: "legacy", flags: base.flags });
    expect(entry.history.map(h => h.kiroVersion)).toEqual(["kiro-cli 2.27.1", "kiro-cli 3.0.0"]);
    expect(agendVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(statSync(kiroLedgerPath()).mode & 0o777).toBe(0o600);
  });

  it("keeps the last 20 changes", () => {
    for (let i = 0; i < 25; i++) recordKiroLaunch({ instance: "a", workingDirectory: "/w", credentialProfile: null, kiroVersion: `kiro-cli 2.${i}.0`, ui: "legacy", flags: [] });
    const history = readKiroLedger().a.history;
    expect(history).toHaveLength(20);
    expect(history[19].kiroVersion).toBe("kiro-cli 2.24.0");
  });

  it("a damaged ledger is started over; one that cannot be written is reported, never thrown", () => {
    writeFileSync(kiroLedgerPath(), "{not json");
    expect(recordKiroLaunch({ instance: "a", workingDirectory: "/w", credentialProfile: null, kiroVersion: null, ui: "tui", flags: [] })).toBe(true);
    expect(Object.keys(readKiroLedger())).toEqual(["a"]);
    chmodSync(agendHome, 0o500);
    try {
      expect(recordKiroLaunch({ instance: "b", workingDirectory: "/w", credentialProfile: null, kiroVersion: null, ui: "tui", flags: [] })).toBe(false);
    } finally { chmodSync(agendHome, 0o700); }
  });
});

describe("review round 1 (#1171): the ledger", () => {
  it("an entry it cannot read is dropped, not trusted, and recording goes on", () => {
    recordKiroLaunch({ instance: "valid", workingDirectory: "/w", credentialProfile: null, kiroVersion: null, ui: "tui", flags: [] });
    const good = readKiroLedger().valid;
    writeFileSync(kiroLedgerPath(), JSON.stringify({ valid: good, broken: null, half: { workingDirectory: "/w" }, list: [1] }));
    expect(Object.keys(readKiroLedger())).toEqual(["valid"]);
    expect(recordKiroLaunch({ instance: "next", workingDirectory: "/w", credentialProfile: null, kiroVersion: null, ui: "tui", flags: [] })).toBe(true);
    expect(Object.keys(readKiroLedger()).sort()).toEqual(["next", "valid"]);
  });

  it("a launch record it cannot read drops the entry, and recording that instance resumes", () => {
    recordKiroLaunch({ instance: "a", workingDirectory: "/w", credentialProfile: null, kiroVersion: "kiro-cli 2.27.1", ui: "tui", flags: ["--tui"] });
    const entry = readKiroLedger().a as unknown as Record<string, any>;
    delete entry.history[0].flags;
    writeFileSync(kiroLedgerPath(), JSON.stringify({ a: entry }));
    expect(readKiroLedger()).toEqual({});
    expect(recordKiroLaunch({ instance: "a", workingDirectory: "/w", credentialProfile: null, kiroVersion: "kiro-cli 2.27.1", ui: "tui", flags: ["--tui"] })).toBe(true);
    expect(readKiroLedger().a.history).toHaveLength(1);
  });

  it("a write that cannot be put in place leaves no temporary file behind", () => {
    mkdirSync(kiroLedgerPath());   // the rename onto it fails
    for (let i = 0; i < 3; i++) {
      expect(recordKiroLaunch({ instance: "a", workingDirectory: "/w", credentialProfile: null, kiroVersion: null, ui: "tui", flags: [] })).toBe(false);
    }
    expect(readdirSync(agendHome).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("kiro's V3 session store", () => {
  it("buckets a working directory by the first 16 hex of SHA-256 of its real path", () => {
    expect(kasBucket(work)).toBe(createHash("sha256").update(work).digest("hex").slice(0, 16));
    const link = join(scratch("agend-ledger-link-"), "w");
    symlinkSync(work, link);
    expect(kasBucket(link)).toBe(kasBucket(work));
  });

  it("lists a directory's sessions most recently active first, skipping what is not a session", () => {
    // Names sort the other way round from recency, so only the dates can order them.
    kasSession(work, "sess_a_old", "2026-10-01T00:00:00.000Z");
    kasSession(work, "sess_z_new", "2026-10-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z");
    kasSession(work, "sess_m_mid", "2026-10-02T00:00:00.000Z");
    mkdirSync(join(kiroHome, "sessions", kasBucket(work), "half-written"));
    expect(listKasSessions(work).map(s => s.id)).toEqual(["sess_z_new", "sess_m_mid", "sess_a_old"]);
    // Instants, not strings: 03:00+02:00 is 01:00Z, older than 02:30Z written as 23:30-03:00 the day before.
    const other = scratch("agend-ledger-tz-");
    kasSession(other, "sess_plus_two", "2026-10-03T03:00:00.000+02:00");
    kasSession(other, "sess_minus_three", "2026-10-02T23:30:00.000-03:00");
    kasSession(other, "sess_no_time", "not-a-time");
    expect(listKasSessions(other).map(s => s.id)).toEqual(["sess_minus_three", "sess_plus_two", "sess_no_time"]);
    expect(listKasSessions(scratch("agend-ledger-empty-"))).toEqual([]);
  });
});

describe("the kiro launch", () => {
  it("records the launch in the ledger", () => {
    new KiroBackend(scratch("agend-ledger-inst-"), KIRO).buildCommand(config());
    expect(readKiroLedger()["inst-a"]).toMatchObject({
      workingDirectory: work, credentialProfile: null,
      lastLaunch: { kiroVersion: "kiro-cli 2.27.1", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] },
    });
  });

  it("legacy and TUI still resume with --resume", () => {
    expect(new KiroBackend(scratch("i-"), KIRO).buildCommand(config())).toMatch(/ --resume(\s|$)/);
    expect(new KiroBackend(scratch("i-"), KIRO).buildCommand(config({ kiroUi: "tui" }))).toMatch(/ --resume(\s|$)/);
  });

  it("V3 starts fresh, then resumes the session that launch made by id — never kiro's --resume", () => {
    const build = (over: Partial<CliBackendConfig> = {}) => new KiroBackend(scratch("i-"), KIRO).buildCommand(config({ kiroUi: "v3", ...over }));
    const fresh = build();
    expect(fresh).toContain("chat --v3");
    expect(fresh).not.toMatch(/--resume/);
    kasSession(work, "sess_abc", new Date(Date.now() + 1000).toISOString());
    const resumed = build();
    expect(resumed).toContain("--resume-id 'sess_abc'");
    expect(resumed).not.toMatch(/--resume(\s|$)/);
  });

  it("a ledger that cannot be written never stops the launch", () => {
    chmodSync(agendHome, 0o500);
    try {
      expect(new KiroBackend(scratch("i-"), KIRO).buildCommand(config())).toContain("--agent-engine=v1");
    } finally { chmodSync(agendHome, 0o700); }
  });
});
