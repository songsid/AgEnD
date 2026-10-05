import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  csrfTokenFor,
  DEFAULT_SESSION_POLICY,
  labelFromUserAgent,
  MAX_WEB_SESSIONS,
  SESSION_PERSIST_DEBOUNCE_MS,
  sanitizeLabel,
  tokenEpoch,
  WebSessionStore,
} from "../src/web-session.js";

const TOKEN = "a".repeat(48);
const EPOCH = tokenEpoch(TOKEN);
const HOUR = 3_600_000;
const MIN = 60_000;

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-web-session-"));
  tempDirs.push(dir);
  return dir;
}

function clocked(start = 1_000_000) {
  const clock = { now: start };
  return { clock, opts: { now: () => clock.now } };
}

const input = { tier: "admin", surface: "local", label: "Chrome on macOS", tokenEpoch: EPOCH } as const;

describe("session identity", () => {
  it("mints a 256-bit id that is not derived from anything the caller supplied", () => {
    const store = new WebSessionStore();
    const a = store.create(input);
    const b = store.create(input);

    expect(a.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionId).not.toContain(TOKEN.slice(0, 8));
    // What the store keeps is a hash, and the handle shown to people is neither.
    expect(a.record.idHash).not.toBe(a.sessionId);
    expect(a.record.handle).not.toBe(a.sessionId.slice(0, 16));
    expect(a.record.handle).not.toBe(a.record.idHash.slice(0, 16));
  });

  it("derives a CSRF value that is neither the id nor the same for two sessions", () => {
    const store = new WebSessionStore();
    const a = store.create(input);
    const b = store.create(input);

    expect(csrfTokenFor(a.sessionId)).toMatch(/^[0-9a-f]{64}$/);
    expect(csrfTokenFor(a.sessionId)).not.toBe(a.sessionId);
    expect(csrfTokenFor(a.sessionId)).not.toBe(csrfTokenFor(b.sessionId));
    expect(csrfTokenFor(a.sessionId)).toBe(csrfTokenFor(a.sessionId));
  });

  it("refuses anything that is not a well-formed id without looking it up", () => {
    const store = new WebSessionStore();
    store.create(input);
    for (const bad of [undefined, "", "abc", "g".repeat(64), "a".repeat(63), "A".repeat(64), "a".repeat(65)]) {
      expect(store.authenticate(bad, EPOCH), String(bad)).toBeNull();
    }
  });
});

describe("expiry is decided on the server", () => {
  it("ends at the absolute cap no matter how active the session is", () => {
    const { clock, opts } = clocked();
    const store = new WebSessionStore(opts);
    const { sessionId } = store.create(input);
    const { absoluteMs, idleMs } = DEFAULT_SESSION_POLICY.local;

    // Active every idle-window minus a minute, all the way to the cap.
    for (let t = idleMs - MIN; t < absoluteMs; t += idleMs - MIN) {
      clock.now = 1_000_000 + t;
      expect(store.authenticate(sessionId, EPOCH), `t=${t}`).not.toBeNull();
    }
    clock.now = 1_000_000 + absoluteMs;
    expect(store.authenticate(sessionId, EPOCH)).toBeNull();
    // ...and it does not come back.
    clock.now = 1_000_000;
    expect(store.authenticate(sessionId, EPOCH)).toBeNull();
  });

  it("ends when idle, and activity slides the idle window", () => {
    const { clock, opts } = clocked();
    const store = new WebSessionStore(opts);
    const { sessionId } = store.create(input);
    const { idleMs } = DEFAULT_SESSION_POLICY.local;

    clock.now += idleMs - MIN;
    expect(store.authenticate(sessionId, EPOCH)).not.toBeNull(); // slides
    clock.now += idleMs - MIN;
    expect(store.authenticate(sessionId, EPOCH)).not.toBeNull(); // would have expired without the slide
    clock.now += idleMs;
    expect(store.authenticate(sessionId, EPOCH)).toBeNull();
  });

  it("does not count a non-touching check as activity", () => {
    const { clock, opts } = clocked();
    const store = new WebSessionStore(opts);
    const { sessionId } = store.create(input);
    const { idleMs } = DEFAULT_SESSION_POLICY.local;

    // A stream re-checking itself must not keep an idle session alive.
    for (let i = 0; i < 5; i++) {
      clock.now += idleMs / 4;
      store.authenticate(sessionId, EPOCH, { touch: false });
    }
    clock.now += 1;
    expect(store.authenticate(sessionId, EPOCH, { touch: false })).toBeNull();
  });

  it("uses the shorter gateway windows for a gateway session", () => {
    const { clock, opts } = clocked();
    const store = new WebSessionStore(opts);
    const { sessionId } = store.create({ ...input, surface: "gateway" });

    clock.now += DEFAULT_SESSION_POLICY.gateway.idleMs + 1;
    expect(store.authenticate(sessionId, EPOCH)).toBeNull();
    expect(DEFAULT_SESSION_POLICY.gateway.absoluteMs).toBeLessThan(DEFAULT_SESSION_POLICY.local.absoluteMs);
  });

  it("never slides the idle expiry past the absolute cap", () => {
    const { clock, opts } = clocked();
    const store = new WebSessionStore({ ...opts, policy: { local: { absoluteMs: HOUR, idleMs: 2 * HOUR } } });
    const { record } = store.create(input);

    expect(record.idleExpiry).toBe(record.absoluteExpiry);
    const { sessionId } = store.create(input);
    clock.now += 30 * MIN;
    const touched = store.authenticate(sessionId, EPOCH)!;
    expect(touched.idleExpiry).toBe(touched.absoluteExpiry);
    expect(touched.idleExpiry).toBeLessThanOrEqual(touched.absoluteExpiry);
  });
});

describe("web.token rotation", () => {
  it("kills a session the moment the token it was issued under changes, for good", () => {
    const store = new WebSessionStore();
    const { sessionId } = store.create(input);
    const rotated = tokenEpoch("b".repeat(48));

    expect(store.authenticate(sessionId, EPOCH)).not.toBeNull();
    expect(store.authenticate(sessionId, rotated)).toBeNull();
    // Deleted, not merely refused: restoring the old token does not revive it.
    expect(store.authenticate(sessionId, EPOCH)).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe("revocation", () => {
  it("revokes one session by handle without touching the others", () => {
    const store = new WebSessionStore();
    const a = store.create(input);
    const b = store.create(input);

    expect(store.revokeByHandle(a.record.handle)).toBe(true);
    expect(store.authenticate(a.sessionId, EPOCH)).toBeNull();
    expect(store.authenticate(b.sessionId, EPOCH)).not.toBeNull();
    expect(store.revokeByHandle(a.record.handle)).toBe(false);
  });

  it("does not accept the id or its hash as a handle", () => {
    const store = new WebSessionStore();
    const a = store.create(input);

    expect(store.revokeByHandle(a.sessionId)).toBe(false);
    expect(store.revokeByHandle(a.record.idHash)).toBe(false);
    expect(store.revokeByHandle(a.record.idHash.slice(0, 16))).toBe(false);
    expect(store.authenticate(a.sessionId, EPOCH)).not.toBeNull();
  });

  it("revokes everything, or everything that came in one way", () => {
    const store = new WebSessionStore();
    const local = store.create(input);
    const gw1 = store.create({ ...input, surface: "gateway" });
    const gw2 = store.create({ ...input, surface: "gateway" });

    expect(store.revokeSurface("gateway")).toBe(2);
    expect(store.authenticate(gw1.sessionId, EPOCH)).toBeNull();
    expect(store.authenticate(gw2.sessionId, EPOCH)).toBeNull();
    expect(store.authenticate(local.sessionId, EPOCH)).not.toBeNull();

    expect(store.revokeAll()).toBe(1);
    expect(store.authenticate(local.sessionId, EPOCH)).toBeNull();
  });

  it("keeps at most MAX sessions, dropping the least recently used", () => {
    const { clock, opts } = clocked();
    const store = new WebSessionStore(opts);
    const made = [];
    for (let i = 0; i < MAX_WEB_SESSIONS; i++) { clock.now += 1000; made.push(store.create(input)); }
    // Use the oldest, so the *second* oldest is now the least recently used.
    clock.now += 1000;
    store.authenticate(made[0]!.sessionId, EPOCH);
    clock.now += 1000;
    const extra = store.create(input);

    expect(store.size).toBe(MAX_WEB_SESSIONS);
    expect(store.authenticate(made[1]!.sessionId, EPOCH)).toBeNull();
    expect(store.authenticate(made[0]!.sessionId, EPOCH)).not.toBeNull();
    expect(store.authenticate(extra.sessionId, EPOCH)).not.toBeNull();
  });

  it("marks the caller's own session in the list", () => {
    const store = new WebSessionStore();
    const a = store.create({ ...input, label: "phone" });
    store.create({ ...input, label: "laptop" });

    const list = store.list(a.record.idHash);
    expect(list.filter(s => s.current).map(s => s.label)).toEqual(["phone"]);
    // The list never carries a credential-shaped field.
    for (const row of list) expect(Object.keys(row).sort()).not.toContain("idHash");
    expect(JSON.stringify(list)).not.toContain(a.sessionId);
    expect(JSON.stringify(list)).not.toContain(a.record.idHash);
  });
});

describe("persistence", () => {
  it("survives a restart, and stores a hash rather than anything that can be sent as a cookie", () => {
    const dir = tempDir();
    const first = new WebSessionStore({ dataDir: dir });
    const { sessionId, record } = first.create(input);

    const file = join(dir, "web-sessions.json");
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain(sessionId);
    expect(onDisk).toContain(record.idHash);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const second = new WebSessionStore({ dataDir: dir });
    expect(second.authenticate(sessionId, EPOCH)).not.toBeNull();
  });

  it("does not resurrect a revoked or rotated-away session after a restart", () => {
    const dir = tempDir();
    const first = new WebSessionStore({ dataDir: dir });
    const revoked = first.create(input);
    const kept = first.create(input);
    first.revokeByHandle(revoked.record.handle);

    const second = new WebSessionStore({ dataDir: dir });
    expect(second.authenticate(revoked.sessionId, EPOCH)).toBeNull();
    expect(second.authenticate(kept.sessionId, tokenEpoch("c".repeat(48)))).toBeNull();
  });

  it("drops expired sessions on load", () => {
    const dir = tempDir();
    const { clock, opts } = clocked();
    const first = new WebSessionStore({ dataDir: dir, ...opts });
    const { sessionId } = first.create(input);

    clock.now += DEFAULT_SESSION_POLICY.local.absoluteMs + 1;
    const second = new WebSessionStore({ dataDir: dir, ...opts });
    expect(second.size).toBe(0);
    expect(second.authenticate(sessionId, EPOCH)).toBeNull();
  });

  it("starts empty, and says so, when the file is unreadable or malformed", () => {
    const dir = tempDir();
    const warnings: string[] = [];
    writeFileSync(join(dir, "web-sessions.json"), "{ not json");
    expect(new WebSessionStore({ dataDir: dir, onWarn: m => warnings.push(m) }).size).toBe(0);
    expect(warnings).toHaveLength(1);

    writeFileSync(join(dir, "web-sessions.json"), JSON.stringify({ version: 1, sessions: [
      { handle: "zz", idHash: "nope", created: 1 }, "junk", null,
      { handle: "0123456789abcdef", idHash: "f".repeat(64), created: 1, lastSeen: 1, absoluteExpiry: Date.now() + HOUR,
        idleExpiry: Date.now() + HOUR, tier: "root", surface: "local", label: "x", tokenEpoch: EPOCH },
    ] }));
    expect(new WebSessionStore({ dataDir: dir }).size).toBe(0);
  });

  it("writes lastSeen at most once per debounce window, but revocation immediately", () => {
    const dir = tempDir();
    const { clock, opts } = clocked();
    const store = new WebSessionStore({ dataDir: dir, ...opts });
    const { sessionId, record } = store.create(input);
    const file = join(dir, "web-sessions.json");
    const before = readFileSync(file, "utf8");

    clock.now += 1000;
    store.authenticate(sessionId, EPOCH);
    expect(readFileSync(file, "utf8")).toBe(before);

    clock.now += SESSION_PERSIST_DEBOUNCE_MS;
    store.authenticate(sessionId, EPOCH);
    expect(readFileSync(file, "utf8")).not.toBe(before);

    store.revokeByHandle(record.handle);
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual([]);
  });

  it("does not honour an idle expiry on disk that outlasts the absolute cap", () => {
    const dir = tempDir();
    const { clock, opts } = clocked();
    const first = new WebSessionStore({ dataDir: dir, ...opts });
    const { sessionId } = first.create(input);

    // A hand-edited (or corrupted) file that pushes the idle window far past the hard cap.
    const file = join(dir, "web-sessions.json");
    const edited = JSON.parse(readFileSync(file, "utf8"));
    edited.sessions[0].idleExpiry = clock.now + 1000 * HOUR;
    writeFileSync(file, JSON.stringify(edited));

    clock.now += DEFAULT_SESSION_POLICY.local.absoluteMs + 1;
    const second = new WebSessionStore({ dataDir: dir, ...opts });
    expect(second.authenticate(sessionId, EPOCH)).toBeNull();
    // ...and it does not survive by being loaded just inside the cap either.
    clock.now = 1_000_000 + DEFAULT_SESSION_POLICY.local.absoluteMs - 1000;
    const third = new WebSessionStore({ dataDir: dir, ...opts });
    expect(third.authenticate(sessionId, EPOCH, { touch: false })).not.toBeNull();
    clock.now += 2000;
    // A check that never touches the record cannot lean on the clamp a touch would have applied.
    expect(third.authenticate(sessionId, EPOCH, { touch: false })).toBeNull();
  });

  it("keeps working in memory, and says so, when the file cannot be written", () => {
    const warnings: string[] = [];
    // A regular file where the data directory should be: creating anything under it fails (ENOTDIR).
    const blocker = join(tempDir(), "not-a-directory");
    writeFileSync(blocker, "x");
    const store = new WebSessionStore({ dataDir: join(blocker, "data"), onWarn: m => warnings.push(m) });
    const { sessionId } = store.create(input);

    expect(store.authenticate(sessionId, EPOCH)).not.toBeNull();
    expect(warnings.some(w => w.includes("could not be saved"))).toBe(true);
  });
});

describe("when the file cannot be replaced", () => {
  const fs = { renameSync, unlinkSync };
  /** A store whose file operations fail on demand, over a real directory. */
  function flaky(dir: string, warnings: string[]) {
    const fail = { rename: false, unlink: false };
    const store = new WebSessionStore({
      dataDir: dir,
      onWarn: m => warnings.push(m),
      fileOps: {
        renameSync: ((a: string, b: string) => { if (fail.rename) throw new Error("EACCES: rename"); return fs.renameSync(a, b); }) as typeof renameSync,
        unlinkSync: ((p: string) => { if (fail.unlink && !String(p).includes(".tmp-")) throw new Error("EACCES: unlink"); return fs.unlinkSync(p); }) as typeof unlinkSync,
      },
    });
    return { store, fail };
  }

  it("does not let a revoked session come back after a restart — the old file is removed, so everyone signs in again", () => {
    const dir = tempDir();
    const warnings: string[] = [];
    const { store, fail } = flaky(dir, warnings);
    const revoked = store.create(input);
    const kept = store.create(input);
    expect(new WebSessionStore({ dataDir: dir }).authenticate(revoked.sessionId, EPOCH)).not.toBeNull(); // it was saved

    fail.rename = true;
    expect(store.revokeByHandle(revoked.record.handle)).toBe(true);

    // The regression: a restart used to read the old file and revive the revoked session.
    const restarted = new WebSessionStore({ dataDir: dir });
    expect(restarted.authenticate(revoked.sessionId, EPOCH)).toBeNull();
    expect(restarted.authenticate(kept.sessionId, EPOCH)).toBeNull();   // fail closed: nobody is restored
    expect(warnings.some(w => w.includes("cannot bring back a revoked session"))).toBe(true);
  });

  it("says so, and keeps trying, when even the removal is impossible — then a later save makes the revocation stick", () => {
    const dir = tempDir();
    const warnings: string[] = [];
    const { store, fail } = flaky(dir, warnings);
    const revoked = store.create(input);
    const kept = store.create(input);

    fail.rename = true; fail.unlink = true;
    store.revokeByHandle(revoked.record.handle);
    expect(warnings.some(w => w.includes("may restore sessions that were revoked"))).toBe(true);
    // The window is real and stated: a restart right now would read the old file.
    expect(new WebSessionStore({ dataDir: dir }).authenticate(revoked.sessionId, EPOCH)).not.toBeNull();

    fail.rename = false; fail.unlink = false;
    store.flush();                       // still owed to the disk: shutdown, or the next change, pays it
    const restarted = new WebSessionStore({ dataDir: dir });
    expect(restarted.authenticate(revoked.sessionId, EPOCH)).toBeNull();
    expect(restarted.authenticate(kept.sessionId, EPOCH)).not.toBeNull();
  });

  it("knows what an earlier run left on disk: a session loaded at start can be revoked safely too", () => {
    const dir = tempDir();
    const first = new WebSessionStore({ dataDir: dir });
    const loaded = first.create(input);

    const { store, fail } = flaky(dir, []);          // a new process, which read the file at start
    fail.rename = true;
    store.revokeByHandle(loaded.record.handle);

    expect(new WebSessionStore({ dataDir: dir }).authenticate(loaded.sessionId, EPOCH)).toBeNull();
  });

  it("retries on the next change, not only on flush", () => {
    const dir = tempDir();
    const { store, fail } = flaky(dir, []);
    const revoked = store.create(input);
    fail.rename = true; fail.unlink = true;
    store.revokeByHandle(revoked.record.handle);
    fail.rename = false; fail.unlink = false;
    const later = store.create(input);   // any change writes the whole store again
    const restarted = new WebSessionStore({ dataDir: dir });
    expect(restarted.authenticate(revoked.sessionId, EPOCH)).toBeNull();
    expect(restarted.authenticate(later.sessionId, EPOCH)).not.toBeNull();
  });

  it("covers revoke-all and eviction the same way", () => {
    for (const drop of [(s: WebSessionStore) => s.revokeAll(), (s: WebSessionStore) => { for (let i = 0; i < MAX_WEB_SESSIONS; i++) s.create(input); }]) {
      const dir = tempDir();
      const { store, fail } = flaky(dir, []);
      const first = store.create(input);
      fail.rename = true;
      drop(store);
      expect(new WebSessionStore({ dataDir: dir }).authenticate(first.sessionId, EPOCH)).toBeNull();
    }
  });

  it("does not throw away the other sessions when the file is merely behind", () => {
    const dir = tempDir();
    const warnings: string[] = [];
    const { store, fail } = flaky(dir, warnings);
    const a = store.create(input);
    fail.rename = true;
    store.create(input);   // a new sign-in that cannot be saved: nothing on disk was dropped from memory

    expect(new WebSessionStore({ dataDir: dir }).authenticate(a.sessionId, EPOCH)).not.toBeNull();
    expect(warnings.some(w => w.includes("will retry"))).toBe(true);
    expect(warnings.some(w => w.includes("removed the old file"))).toBe(false);
  });

  it("writes what is still owed at shutdown, including lastSeen that the debounce was holding", () => {
    const dir = tempDir();
    const { clock, opts } = clocked();
    const store = new WebSessionStore({ dataDir: dir, ...opts });
    const { sessionId } = store.create(input);
    clock.now += 1000;
    store.authenticate(sessionId, EPOCH);              // debounced: not on disk yet
    const before = JSON.parse(readFileSync(join(dir, "web-sessions.json"), "utf8")).sessions[0].lastSeen;

    store.flush();

    const after = JSON.parse(readFileSync(join(dir, "web-sessions.json"), "utf8")).sessions[0].lastSeen;
    expect(after).toBeGreaterThan(before);
  });
});

describe("labels", () => {
  it("summarises a User-Agent coarsely", () => {
    expect(labelFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15")).toBe("Safari on macOS");
    expect(labelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120 Mobile/15E148 Safari/604.1")).toBe("Chrome on iOS");
    expect(labelFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0")).toBe("Firefox on Linux");
    expect(labelFromUserAgent(undefined)).toBe("unknown device");
  });

  it("strips anything a page could be tricked into interpreting, and bounds the length", () => {
    expect(sanitizeLabel('<img src=x onerror="alert(1)">')).not.toMatch(/[<>"'`&]/);
    expect(sanitizeLabel("a\nb\u0000c")).toBe("abc");
    expect(sanitizeLabel("x".repeat(500)).length).toBeLessThanOrEqual(80);
    expect(sanitizeLabel("   ")).toBe("unknown device");
  });
});
