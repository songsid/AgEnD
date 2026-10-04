/**
 * Which V3 session a V3 kiro instance owns (#1171). It resumes only a session
 * it owns — by an exclusive claim — or, after a fresh start, the one session
 * that fresh launch certainly made. Anything less certain starts fresh.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kasBucket } from "../src/backend/kiro-kas-store.js";
import { KiroV3IdentityError, resolveKiroV3Resume } from "../src/backend/kiro-v3-identity.js";

const dirs: string[] = [];
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
let agendHome: string;
let kiroHome: string;
let work: string;
beforeEach(() => {
  agendHome = scratch("agend-v3id-home-");
  kiroHome = scratch("agend-v3id-kiro-");
  work = scratch("agend-v3id-work-");
});
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const T0 = new Date("2026-10-03T02:00:00.000Z");
const at = (iso: string) => new Date(iso);
function kasSession(cwd: string, id: string, meta: Record<string, unknown>): void {
  const dir = join(kiroHome, "sessions", kasBucket(cwd), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ id, ...meta }));
}
const created = (iso: string) => ({ createdAt: iso, lastModifiedAt: iso });
const resolve = (instance: string, o: { now?: Date; skipResume?: boolean; profile?: string | null; cwd?: string } = {}) =>
  resolveKiroV3Resume(instance, o.cwd ?? work, o.profile ?? null, { agendHome, env: { KIRO_HOME: kiroHome }, now: o.now, skipResume: o.skipResume });
const claimsDir = () => join(agendHome, "kiro-v3", "claims");

describe("a V3 instance's own session", () => {
  it("a first launch starts fresh; the session it made is taken up by the next launch, then kept", () => {
    kasSession(work, "sess_before", created("2026-10-01T00:00:00.000Z"));
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_mine", created("2026-10-03T02:00:05.000Z"));
    expect(resolve("a")).toBe("sess_mine");
    expect(readFileSync(join(claimsDir(), "sess_mine"), "utf8")).toBe("a\n");
    kasSession(work, "sess_later", created("2026-10-04T00:00:00.000Z"));
    expect(resolve("a")).toBe("sess_mine");
  });

  it("a skipped resume gives the session up: the next launch takes up the new one, never the old (P1-1)", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_old", created("2026-10-03T02:00:05.000Z"));
    expect(resolve("a")).toBe("sess_old");
    expect(resolve("a", { skipResume: true, now: at("2026-10-03T03:00:00.000Z") })).toBeNull();
    expect(existsSync(join(claimsDir(), "sess_old"))).toBe(false);
    kasSession(work, "sess_fresh", created("2026-10-03T03:00:05.000Z"));
    expect(resolve("a")).toBe("sess_fresh");
  });

  it("its session is gone, or it moved directory or credential profile: a fresh start", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_mine", created("2026-10-03T02:00:05.000Z"));
    expect(resolve("a")).toBe("sess_mine");
    expect(resolve("a", { profile: "work", now: at("2026-10-03T04:00:00.000Z") })).toBeNull();
    expect(resolve("a", { profile: "work" })).toBeNull();     // nothing made since: still fresh, never the other account's
  });
});

describe("only the session that fresh launch certainly made", () => {
  it("two new sessions since the fresh start: not certain which, so fresh again", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_1", created("2026-10-03T02:00:05.000Z"));
    kasSession(work, "sess_2", created("2026-10-03T02:00:06.000Z"));
    expect(resolve("a")).toBeNull();
  });

  it("one of them already someone else's: the other is this one's", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_1", created("2026-10-03T02:00:05.000Z"));
    kasSession(work, "sess_2", created("2026-10-03T02:00:06.000Z"));
    mkdirSync(claimsDir(), { recursive: true });
    writeFileSync(join(claimsDir(), "sess_1"), "b\n");
    expect(resolve("a")).toBe("sess_2");
  });

  it("a session that already existed at the fresh start is not taken, whatever its clock says", () => {
    kasSession(work, "sess_skewed", created("2026-10-03T02:00:30.000Z"));
    expect(resolve("a", { now: T0 })).toBeNull();
    expect(resolve("a")).toBeNull();
  });

  it("moved to another working directory: fresh there, the old session is not carried along", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_mine", created("2026-10-03T02:00:05.000Z"));
    expect(resolve("a")).toBe("sess_mine");
    const elsewhere = scratch("agend-v3id-moved-");
    expect(resolve("a", { cwd: elsewhere, now: at("2026-10-03T03:00:00.000Z") })).toBeNull();
  });

  it("a fresh start waiting in one directory takes up nothing in another", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    const elsewhere = scratch("agend-v3id-moved-");
    // Someone's session there, made after this instance's fresh start — but not by it.
    kasSession(elsewhere, "sess_theirs", created("2026-10-03T02:00:05.000Z"));
    expect(resolve("a", { cwd: elsewhere })).toBeNull();
  });
});

describe("never someone else's session (P1-2)", () => {
  it("(a) a sibling in the same directory is never handed a running instance's conversation", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_a_running", created("2026-10-03T02:00:05.000Z"));
    // B's first launch: nothing of its own yet.
    expect(resolve("b", { now: at("2026-10-03T02:00:10.000Z") })).toBeNull();
    // A sibling is waiting to take up its own session: neither can be sure which is whose.
    kasSession(work, "sess_b_running", created("2026-10-03T02:00:15.000Z"));
    expect(resolve("a")).toBeNull();
    expect(resolve("b")).toBeNull();
    expect(existsSync(claimsDir()) ? readdirSync(claimsDir()) : []).toEqual([]);
  });

  it("(b) a claim that cannot be written takes up nothing", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_shared", created("2026-10-03T02:00:05.000Z"));
    mkdirSync(claimsDir(), { recursive: true });
    chmodSync(claimsDir(), 0o500);
    try {
      expect(resolve("a")).toBeNull();
      expect(resolve("b")).toBeNull();
    } finally { chmodSync(claimsDir(), 0o700); }
  });

  it("(c) a session another instance claimed first is not taken, even mid-decision", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_x", created("2026-10-03T02:00:05.000Z"));
    // B's claim lands first (another process): A's exclusive create fails, and A starts fresh.
    mkdirSync(claimsDir(), { recursive: true });
    writeFileSync(join(claimsDir(), "sess_x"), "b\n");
    expect(resolve("a")).toBeNull();
    expect(readFileSync(join(claimsDir(), "sess_x"), "utf8")).toBe("b\n");
  });

  it("a session on record that another instance owns is not resumed", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_x", created("2026-10-03T02:00:05.000Z"));
    expect(resolve("a")).toBe("sess_x");
    writeFileSync(join(claimsDir(), "sess_x"), "b\n");
    expect(resolve("a", { now: at("2026-10-03T05:00:00.000Z") })).toBeNull();
  });
});

describe("created after the fresh start, as an instant (P2-3)", () => {
  const take = (meta: Record<string, unknown>) => {
    const fresh = scratch("agend-v3id-tz-");
    expect(resolve("a", { cwd: fresh, now: T0 })).toBeNull();
    kasSession(fresh, "sess_x", meta);
    return resolve("a", { cwd: fresh });
  };
  it("03:00+02:00 is 01:00Z, before the 02:00Z start: not taken", () => expect(take(created("2026-10-03T03:00:00.000+02:00"))).toBeNull());
  it("23:30-03:00 the day before is 02:30Z, after it: taken", () => expect(take(created("2026-10-02T23:30:00.000-03:00"))).toBe("sess_x"));
  it("no creation time, only a newer modification: not taken", () => expect(take({ lastModifiedAt: "2026-10-03T05:00:00.000Z" })).toBeNull());
  it("a creation time that is not a time: not taken", () => expect(take({ createdAt: "not-a-time", lastModifiedAt: "2026-10-03T05:00:00.000Z" })).toBeNull());
});

describe("records it cannot read (P2-4)", () => {
  it("a damaged state is a fresh start, never a throw; a damaged sibling state blocks taking up, not launching", () => {
    mkdirSync(join(agendHome, "kiro-v3", "instances"), { recursive: true });
    writeFileSync(join(agendHome, "kiro-v3", "instances", "a.json"), JSON.stringify({ id: 5, bucket: null }));
    expect(() => resolve("a", { now: T0 })).not.toThrow();
    writeFileSync(join(agendHome, "kiro-v3", "instances", "b.json"), "null");
    kasSession(work, "sess_x", created("2026-10-03T02:00:05.000Z"));
    expect(resolve("a")).toBeNull();
    rmSync(join(agendHome, "kiro-v3", "instances", "b.json"));
    expect(resolve("a", { now: at("2026-10-03T02:00:01.000Z") })).toBeNull();
    kasSession(work, "sess_y", created("2026-10-03T02:00:06.000Z"));
    expect(resolve("a")).toBe("sess_y");
  });

  it("a session or instance name that is not a plain file name is never used", () => {
    expect(resolve("../evil", { now: T0 })).toBeNull();
    expect(existsSync(join(agendHome, "kiro-v3"))).toBe(false);
  });
});

describe("review round 2 (#1171)", () => {
  const instancesDir = () => join(agendHome, "kiro-v3", "instances");

  it("a fresh start that cannot be recorded refuses the launch; the session it would give up stays owned", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_old", created("2026-10-03T02:00:05.000Z"));
    expect(resolve("a")).toBe("sess_old");
    chmodSync(instancesDir(), 0o500);
    try {
      expect(() => resolve("a", { skipResume: true })).toThrow(KiroV3IdentityError);
    } finally { chmodSync(instancesDir(), 0o700); }
    expect(readFileSync(join(claimsDir(), "sess_old"), "utf8")).toBe("a\n");
    // Nothing was launched fresh, so resuming it is still right.
    expect(resolve("a")).toBe("sess_old");
  });

  it("a state alone never re-creates a claim: with the claim gone, a fresh start", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_old", created("2026-10-03T02:00:05.000Z"));
    expect(resolve("a")).toBe("sess_old");
    rmSync(join(claimsDir(), "sess_old"));
    expect(resolve("a", { now: at("2026-10-03T03:00:00.000Z") })).toBeNull();
    expect(existsSync(join(claimsDir(), "sess_old"))).toBe(false);
  });

  it("(a) a first fresh start that cannot be recorded refuses the launch, so no unrecorded sibling runs", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    chmodSync(instancesDir(), 0o500);
    try {
      expect(() => resolve("b", { now: T0 })).toThrow(KiroV3IdentityError);
    } finally { chmodSync(instancesDir(), 0o700); }
  });

  it("(b) siblings that cannot be listed cannot be ruled out: nothing is taken up", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    expect(resolve("b", { now: T0 })).toBeNull();
    kasSession(work, "sess_b_running", created("2026-10-03T02:00:05.000Z"));
    rmSync(join(instancesDir(), "b.json"));        // b's state lost from view …
    chmodSync(instancesDir(), 0o300);               // … and the directory cannot be listed
    try {
      expect(resolve("a")).toBeNull();
    } finally { chmodSync(instancesDir(), 0o700); }
  });

  it("a session this instance claimed but could not record in its state is still its own", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_x", created("2026-10-03T02:00:05.000Z"));
    mkdirSync(claimsDir(), { recursive: true });
    writeFileSync(join(claimsDir(), "sess_x"), "a\n");
    expect(resolve("a")).toBe("sess_x");
  });

  it("a claim still being written (no newline) is nobody's to use", () => {
    expect(resolve("a", { now: T0 })).toBeNull();
    kasSession(work, "sess_x", created("2026-10-03T02:00:05.000Z"));
    mkdirSync(claimsDir(), { recursive: true });
    writeFileSync(join(claimsDir(), "sess_x"), "a");   // a prefix of "a\n", not a finished claim
    expect(resolve("a")).toBeNull();
  });
});
