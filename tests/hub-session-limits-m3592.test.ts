/**
 * M-3592: the Hub administrator sets how long a sign-in lasts (absolute 1 h – 7 d, default 8 h; idle 15 min – 24 h,
 * default 1 h), in Administration. Through the real Hub HTTP server on real SQLite, with a fake clock: defaults
 * unchanged; admin-only, bounded, revision-checked and audited saves; new sessions take the absolute limit (cookie
 * and row); a lower limit ends a session signed in before it, a higher one never lengthens one; idle applies to all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HUB_SESSION_LIMIT_BOUNDS, hubSessionLimits, withinHubSessionLimits } from "../src/hub/session-limits.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIN = 60_000, HOUR = 60 * MIN;
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  let t = Date.parse("2026-11-24T01:00:00Z");
  r = await s3bRig({ now: () => t });
  r.addPerson("member", "Member");
  const admin = await r.signIn("admin");
  return { r, admin, at: () => t, advance: (ms: number) => { t += ms; } };
}
const PATH = "/hub/v1/admin/session-limits";
const maxAge = (setCookie: string | null) => Number(/Max-Age=(\d+)/.exec(setCookie ?? "")?.[1]);
/** Whether this browser is signed in now (GET /hub/v1/session answers 200 either way, with signedIn). */
const signedIn = async (w: { r: NonNullable<typeof r> }, b: { cookie: string; csrf: string }) => (await w.r.call(b, "GET", "/hub/v1/session")).json?.signedIn === true;

describe("M-3592 the sign-in lifetime setting", () => {
  it("defaults are today's (8 h, 1 h): a Hub never configured reads them, and a new session's cookie and row last 8 h", async () => {
    const w = await world();
    const got = await w.r.call(w.admin, "GET", PATH);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ absoluteMinutes: 480, idleMinutes: 60, revision: 0, configured: false, bounds: HUB_SESSION_LIMIT_BOUNDS });
    const res = await fetch(`${w.r.base}/hub/v1/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: w.r.config.webOrigin }, body: JSON.stringify({ login: "member", password: "pw-member" }) });
    expect(maxAge(res.headers.get("set-cookie"))).toBe(8 * 3600);
    expect(hubSessionLimits(w.r.db)).toEqual({ absoluteMs: 8 * HOUR, idleMs: HOUR });
  });

  it("only the administrator reads or saves it; a member is refused", async () => {
    const w = await world();
    const member = await w.r.signIn("member");
    expect((await w.r.call(member, "GET", PATH)).status).toBe(403);
    expect((await w.r.call(member, "PUT", PATH, { absoluteMinutes: 120, idleMinutes: 30, ifRevision: 0 })).status).toBe(403);
    expect((await w.r.call(null, "GET", PATH)).status).toBe(401);
  });

  it("bounded: below or above either range, a fraction, idle longer than the sign-in, or an extra field is refused", async () => {
    const w = await world();
    for (const bad of [
      { absoluteMinutes: 59, idleMinutes: 30 }, { absoluteMinutes: 7 * 24 * 60 + 1, idleMinutes: 30 },
      { absoluteMinutes: 120, idleMinutes: 14 }, { absoluteMinutes: 2000, idleMinutes: 24 * 60 + 1 },
      { absoluteMinutes: 120.5, idleMinutes: 30 }, { absoluteMinutes: 120, idleMinutes: 30, extra: 1 },
    ]) expect((await w.r.call(w.admin, "PUT", PATH, { ...bad, ifRevision: 0 })).status, JSON.stringify(bad)).toBe(400);
    const longer = await w.r.call(w.admin, "PUT", PATH, { absoluteMinutes: 60, idleMinutes: 90, ifRevision: 0 });
    expect([longer.status, longer.json]).toEqual([400, { code: "idle-longer-than-absolute" }]);
    for (const ok of [{ absoluteMinutes: 60, idleMinutes: 15 }, { absoluteMinutes: 7 * 24 * 60, idleMinutes: 24 * 60 }]) {
      const cur = (await w.r.call(w.admin, "GET", PATH)).json.revision;
      expect((await w.r.call(w.admin, "PUT", PATH, { ...ok, ifRevision: cur })).status, JSON.stringify(ok)).toBe(200);
    }
  });

  it("saved with a revision (a stale one is 409), audited with the new values, and needs the page's CSRF token", async () => {
    const w = await world();
    const saved = await w.r.call(w.admin, "PUT", PATH, { absoluteMinutes: 120, idleMinutes: 30, ifRevision: 0 });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ absoluteMinutes: 120, idleMinutes: 30, revision: 1, configured: true });
    expect((await w.r.call(w.admin, "PUT", PATH, { absoluteMinutes: 240, idleMinutes: 30, ifRevision: 0 })).json).toEqual({ code: "revision-conflict" });
    const audit = w.r.audits.filter((a) => a.action === "session.limits-updated");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ result: "completed", reasonCode: "absolute:120,idle:30" });
    expect((await w.r.call({ cookie: w.admin.cookie, csrf: "0".repeat(64) }, "PUT", PATH, { absoluteMinutes: 240, idleMinutes: 30, ifRevision: 1 })).status).toBe(403);
  });

  it("a new sign-in takes the absolute limit: its cookie and its session end then", async () => {
    const w = await world();
    expect((await w.r.call(w.admin, "PUT", PATH, { absoluteMinutes: 120, idleMinutes: 60, ifRevision: 0 })).status).toBe(200);
    const res = await fetch(`${w.r.base}/hub/v1/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: w.r.config.webOrigin }, body: JSON.stringify({ login: "member", password: "pw-member" }) });
    expect(maxAge(res.headers.get("set-cookie"))).toBe(2 * 3600);
    const member = { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!, csrf: (await res.json() as { csrf: string }).csrf };
    for (let i = 0; i < 3; i++) { w.advance(39 * MIN); expect(await signedIn(w, member), `${i}`).toBe(true); }   // used: idle never ends it
    w.advance(4 * MIN);
    expect(await signedIn(w, member)).toBe(false);                                      // 2 h 1 min after sign-in
  });

  it("a lower absolute limit ends a session signed in before it; a higher one never lengthens one", async () => {
    const w = await world();
    const member = await w.r.signIn("member");                                                                         // signed in under the default 8 h
    for (let i = 0; i < 3; i++) { w.advance(30 * MIN); expect(await signedIn(w, member)).toBe(true); }                 // 90 min, in use
    const admin = await w.r.signIn("admin");                                                                          // the admin's own was idle
    expect((await w.r.call(admin, "PUT", PATH, { absoluteMinutes: 60, idleMinutes: 30, ifRevision: 0 })).status).toBe(200);
    expect(await signedIn(w, member), "lowered").toBe(false);                                      // 90 min > the new 60

    const w2 = await world();
    const early = await w2.r.signIn("member");                                                                        // 8 h under the default
    expect((await w2.r.call(w2.admin, "PUT", PATH, { absoluteMinutes: 7 * 24 * 60, idleMinutes: 24 * 60, ifRevision: 0 })).status).toBe(200);
    for (let i = 0; i < 15; i++) { w2.advance(30 * MIN); expect(await signedIn(w2, early), `${i}`).toBe(true); }
    w2.advance(31 * MIN);
    expect(await signedIn(w2, early), "raised").toBe(false);                                      // still ended at 8 h
  });

  it("#4397 review: a limit lowered and raised again before a session is next checked still ended it (absolute and idle)", async () => {
    const w = await world();
    const member = await w.r.signIn("member");
    for (let i = 0; i < 3; i++) { w.advance(30 * MIN); expect(await signedIn(w, member)).toBe(true); }                   // 90 min, in use
    const admin = await w.r.signIn("admin");
    expect((await w.r.call(admin, "PUT", PATH, { absoluteMinutes: 60, idleMinutes: 30, ifRevision: 0 })).status).toBe(200);
    expect((await w.r.call(admin, "PUT", PATH, { absoluteMinutes: 480, idleMinutes: 60, ifRevision: 1 })).status).toBe(200);
    expect(await signedIn(w, member), "lowered then raised, not checked between").toBe(false);

    const v = await world();
    const idle = await v.r.signIn("member");
    v.advance(40 * MIN);                                                                                             // unused 40 min
    const a2 = await v.r.signIn("admin");
    expect((await v.r.call(a2, "PUT", PATH, { absoluteMinutes: 480, idleMinutes: 15, ifRevision: 0 })).status).toBe(200);
    expect((await v.r.call(a2, "PUT", PATH, { absoluteMinutes: 480, idleMinutes: 60, ifRevision: 1 })).status).toBe(200);
    expect(await signedIn(v, idle), "idle lowered then raised").toBe(false);
  });

  it("a lower limit pulls a session's stored end in to its sign-in + the limit, never pushes one out", async () => {
    const w = await world();
    await w.r.signIn("member");
    const end = () => (w.r.db.prepare("SELECT s.expires_at, s.created_at FROM hub_sessions s JOIN hub_people p ON p.person=s.person WHERE p.login_label='member' AND s.state='active'").get() as any);
    const before = end();
    expect(before.expires_at - before.created_at).toBe(8 * HOUR);
    expect((await w.r.call(w.admin, "PUT", PATH, { absoluteMinutes: 120, idleMinutes: 60, ifRevision: 0 })).status).toBe(200);
    expect(end().expires_at - end().created_at).toBe(2 * HOUR);
    expect((await w.r.call(w.admin, "PUT", PATH, { absoluteMinutes: 600, idleMinutes: 60, ifRevision: 1 })).status).toBe(200);
    expect(end().expires_at - end().created_at).toBe(2 * HOUR);
  });

  it("the idle limit applies to every session at once: unused longer than it, signed out; used within it, kept", async () => {
    const w = await world();
    const a = await w.r.signIn("member");
    expect((await w.r.call(w.admin, "PUT", PATH, { absoluteMinutes: 480, idleMinutes: 15, ifRevision: 0 })).status).toBe(200);
    w.advance(14 * MIN);
    expect(await signedIn(w, a)).toBe(true);
    w.advance(16 * MIN);
    expect(await signedIn(w, a)).toBe(false);
  });
});

describe("M-3592 the one limits rule", () => {
  const L = { absoluteMs: 2 * HOUR, idleMs: 30 * MIN }, row = { created_at: 0, seen_at: 0 };
  it("used within the idle limit and signed in less than the absolute limit ago: within; either past it: not", () => {
    expect(withinHubSessionLimits(row, L, 30 * MIN)).toBe(true);
    expect(withinHubSessionLimits(row, L, 30 * MIN + 1)).toBe(false);                                   // idle
    expect(withinHubSessionLimits({ created_at: 0, seen_at: 2 * HOUR - 1 }, L, 2 * HOUR - 1)).toBe(true);
    expect(withinHubSessionLimits({ created_at: 0, seen_at: 2 * HOUR - 1 }, L, 2 * HOUR)).toBe(false); // absolute, from sign-in
  });
  it("HubSessions, the company-join approval and the directory session rotation all apply it", () => {
    const src = (f: string) => readFileSync(join(__dirname, "..", "src", "hub", f), "utf8");
    for (const f of ["sessions.ts", "join/service.ts", "session-directory-transition.ts"]) {
      expect(src(f), f).toMatch(/withinHubSessionLimits\([^)]*hubSessionLimits\(|withinHubSessionLimits\(row, limits, now\)/);
      expect(src(f), f).not.toMatch(/60 \* 60_000/);
    }
  });
});
