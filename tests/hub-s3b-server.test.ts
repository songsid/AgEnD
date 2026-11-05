/**
 * AgEnD Hub P1, slice 3 server side (S-52): sessions, the catalog mirror, grants, rooms, authorization leases, receipts,
 * answers and reconcile, through createHubHttp's HTTP handler and member receiver (hub.md §6, S3 row).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { s3bRig, WEB_ORIGIN } from "./helpers/hub-s3b-rig.js";
import { readHubCookie, hubCookieName } from "../src/hub/sessions.js";
import { HUB_SHELL_DROPS } from "../src/web-api.js";
import { verifyAsker, operationDigest } from "../src/hub/identity.js";
import type { HubExposure, HubServerFrame, PersonKey } from "../src/hub/types.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
type Rig = Awaited<ReturnType<typeof s3bRig>>;
let rig: Rig | null = null;
afterEach(async () => { await rig?.close(); rig = null; });

function exposure(fleetId: string, owner: PersonKey, over: Partial<HubExposure> = {}): HubExposure {
  return { id: randomUUID(), fleetId, owner, displayName: "Sales numbers", revision: 1, state: "published", dataViewId: "sales-q3",
    allowedTools: ["read_sheet"], policyDigest: "b".repeat(64), ...over };
}
/** Owner "olivia" with a paired fleet publishing one exposure; asker "alex" granted on it; alex's open room. */
async function world(r: Rig) {
  const owner = r.addPerson("olivia", "Olivia"), asker = r.addPerson("alex", "Alex");
  const fleetId = randomUUID(), link = r.link(fleetId, owner);
  const e = exposure(fleetId, owner);
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const o = await r.signIn("olivia"), a = await r.signIn("alex");
  const g = await r.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "alex", days: 7 });
  expect(g.status).toBe(200);
  const room = await r.call(a, "POST", "/hub/v1/rooms", { exposureId: e.id, grantId: g.json.grant.id });
  expect(room.status).toBe(200);
  return { owner, asker, fleetId, link, e, o, a, grant: g.json.grant, roomId: room.json.room.id as string };
}

describe("Hub sessions (S3b)", () => {
  it("signs in through the directory and sets only the __Host- Hub cookie", async () => {
    rig = await s3bRig();
    const s = await rig.signIn("admin");
    expect(s.status).toBe(200);
    expect(s.cookie.startsWith(`${hubCookieName(rig.hubId)}=`)).toBe(true);
    const me = await rig.call(s, "GET", "/hub/v1/session");
    expect(me.json).toMatchObject({ signedIn: true, displayName: "Hub Admin", admin: true });
    const bad = await rig.call(null, "POST", "/hub/v1/session", { login: "admin", password: "nope" });
    expect(bad.status).toBe(403);
    expect(bad.json).toEqual({ code: "denied" });
  });

  it("never authenticates by a fleet cookie, a bearer token or another Hub's cookie", async () => {
    rig = await s3bRig();
    const s = await rig.signIn("admin");
    const token = s.cookie.split("=")[1]!;
    // The fleet's cookie names carrying the very same value: still signed out.
    for (const cookie of [`agend_session=${token}`, `__Host-agend_session=${token}`, `__Host-agend_hub_${randomUUID()}=${token}`]) {
      const r = await rig.call(null, "GET", "/hub/v1/exposures", undefined, { Cookie: cookie, Authorization: `Bearer ${token}` });
      expect(r.status, cookie).toBe(401);
    }
    // Two values for the Hub's own name: neither is trusted.
    expect(readHubCookie(`${s.cookie}; ${s.cookie}`, rig.hubId)).toBeNull();
    expect(readHubCookie(`agend_session=x; ${s.cookie}; __Host-agend_session=y`, rig.hubId)).toBe(token);
  });

  it("needs the Hub's own origin and the session's CSRF token for every mutation", async () => {
    rig = await s3bRig();
    const s = await rig.signIn("admin");
    expect((await rig.call(s, "DELETE", "/hub/v1/session", undefined, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await rig.call(s, "DELETE", "/hub/v1/session", undefined, { "X-AgEnD-Hub-CSRF": "0".repeat(64) })).status).toBe(403);
    expect((await rig.call(s, "DELETE", "/hub/v1/session", undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const out = await rig.call(s, "DELETE", "/hub/v1/session");
    expect(out.status).toBe(200);
    expect((await rig.call(s, "GET", "/hub/v1/exposures")).status).toBe(401);
  });

  it("checks the directory on every protected request: a disabled person is signed out at once", async () => {
    rig = await s3bRig();
    rig.addPerson("bo");
    const s = await rig.signIn("bo");
    expect((await rig.call(s, "GET", "/hub/v1/exposures")).status).toBe(200);
    rig.setEligible("bo", false);
    expect((await rig.call(s, "GET", "/hub/v1/exposures")).status).toBe(401);
    rig.setEligible("bo", true);
    expect((await rig.call(s, "GET", "/hub/v1/exposures")).status).toBe(401);          // the session stays ended
  });

  it("is off when the server is fenced, and leaves every non-Hub path to its caller", async () => {
    rig = await s3bRig();
    const s = await rig.signIn("admin");
    for (const p of ["/auth/session", "/api/settings", "/ui/js/panel-chat.js", "/ui/js/panel-settings.js", "/hub/v2/x"]) {
      const r = await rig.call(s, "GET", p);
      expect(r.status === 404, p).toBe(true);
      if (!p.startsWith("/hub/")) expect(r.text).toBe("fleet-404");
    }
    expect((await rig.call(s, "GET", "/hub/v1/pair")).status).toBe(404);                // member-listener paths never here
    rig.disable();
    expect((await rig.call(s, "GET", "/hub/v1/session")).status).toBe(503);
    expect((await rig.call(s, "GET", "/ui/hub")).status).toBe(503);
  });
});

describe("Hub workspace page (S3b)", () => {
  it("draws the Hub-only shell from no request data and serves only the Hub's lazy modules", async () => {
    rig = await s3bRig();
    const r = await rig.call(null, "GET", "/ui/hub", undefined, { Cookie: "agend_session=x; __Host-agend_session=y" });
    expect(r.status).toBe(200);
    expect(r.text).toContain('data-hub="hub"');
    expect(r.text).toContain('data-hub-name="Team Hub"');
    expect(r.text).not.toContain("data-prefs");
    expect(r.text).not.toContain("data-owner-css");
    // No fleet fetch wrapper: it would read the fleet's /auth/session and show the fleet's "session ended" banner.
    expect(r.text).not.toContain("agend-auth.js");
    expect(readFileSync("src/ui/app.html", "utf8")).toContain(HUB_SHELL_DROPS);       // the drop still names a real tag
    expect((await rig.call(null, "GET", "/ui/js/panel-hub.js")).status).toBe(200);
    expect((await rig.call(null, "GET", "/ui/js/panel-fleet.js")).text).toBe("fleet-404");
    expect((await rig.call(null, "GET", "/assets/app.js")).status).toBe(200);
    expect((await rig.call(null, "GET", "/assets/nope.js")).text).toBe("fleet-404");
  });

  it("no Hub server module reaches a fleet session or cookie reader", () => {
    const files = [...readdirSync("src/hub").filter((f) => f.endsWith(".ts")).map((f) => join("src/hub", f)),
      ...readdirSync("src/hub/http").map((f) => join("src/hub/http", f))];
    for (const f of files) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/web-session|readSessionCookies|isAuthenticated|prefsViewer|webSessions|agend_session|agend_device/);
      // From the fleet's web modules, only the two cookie-free servers.
      for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[./]*(?:\.\.\/)*(web-api|auth-api)\.js"/g))
        expect(m[1]!.split(",").map((x) => x.trim()).filter(Boolean), f).toEqual([m[2] === "web-api" ? "serveHubWorkspaceShell" : "servePublicAsset"]);
    }
  });
});

describe("Hub catalog mirror and grants (S3b)", () => {
  it("accepts complete, monotonic snapshots: older refused, a changed repeat refused, absence withdraws", async () => {
    rig = await s3bRig();
    const { link, e, o, a, owner } = await world(rig);
    const snap = (revision: number, exposures: HubExposure[]) => rig!.http.receive(rig!.frame("exposure.snapshot", { revision, exposures }, link) as never, link);
    await expect(snap(0, [e])).rejects.toMatchObject({ code: "stale" });
    await expect(snap(1, [{ ...e, displayName: "Renamed" }])).rejects.toMatchObject({ code: "conflict" });
    await expect(snap(1, [e])).resolves.toBeUndefined();
    await expect(snap(2, [{ ...e, revision: 0 }])).rejects.toMatchObject({ code: "stale" });
    expect((await rig.call(a, "GET", "/hub/v1/exposures")).json.askable).toHaveLength(1);
    await snap(2, []);                                        // newer and complete: e is gone
    expect((await rig.call(a, "GET", "/hub/v1/exposures")).json.askable).toHaveLength(0);
    expect((await rig.call(o, "GET", "/hub/v1/exposures")).json.mine).toHaveLength(0);
    // Re-published at the same revision later: consent does not revive the old grant.
    await snap(3, [e]);
    expect((await rig.call(a, "GET", "/hub/v1/exposures")).json.askable).toHaveLength(0);
    void owner;
  });

  it("refuses an exposure that names another fleet's id", async () => {
    rig = await s3bRig();
    const { e } = await world(rig);
    const other = rig.addPerson("otto"), l2 = rig.link(randomUUID(), other);
    await expect(rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ ...e, fleetId: l2.fleetId, owner: other }] }, l2) as never, l2))
      .rejects.toMatchObject({ code: "denied" });
  });

  it("shows a person only their own exposures and what is granted to them (no enumeration)", async () => {
    rig = await s3bRig();
    const { e } = await world(rig);
    rig.addPerson("eve");
    const eve = await rig.signIn("eve");
    const v = await rig.call(eve, "GET", "/hub/v1/exposures");
    expect(v.json).toEqual({ mine: [], askable: [] });
    expect((await rig.call(eve, "POST", "/hub/v1/rooms", { exposureId: e.id, grantId: randomUUID() })).status).toBe(404);
  });

  it("lets only the owner grant, at the revision shown, to one known eligible person", async () => {
    rig = await s3bRig();
    const { e, o, a } = await world(rig);
    rig.addPerson("bea");
    expect((await rig.call(a, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "bea", days: 1 })).status).toBe(404);
    expect((await rig.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 2, login: "bea", days: 1 })).status).toBe(404);   // bea never signed in
    await rig.signIn("bea");
    expect((await rig.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 2, login: "bea", days: 1 })).status).toBe(409);
    expect((await rig.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "bea", days: 400 })).status).toBe(400);
    expect((await rig.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "olivia", days: 1 })).status).toBe(404);
    expect((await rig.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "bea", days: 1 })).status).toBe(200);
  });

  it("a grant goes to whoever the directory says holds that login NOW: a rename never redirects it; a shared label is refused (Fable on #3112)", async () => {
    rig = await s3bRig();
    const { e, o } = await world(rig);
    const bob = rig.addPerson("bob", "Bob Old");
    await rig.signIn("bob");                                   // the Hub knows "bob" → Bob Old
    rig.rename("bob", "robert");                               // the directory renames him …
    const newBob = rig.addPerson("bob", "Bob New");             // … and gives "bob" to a new colleague (never signed in)
    const g = await rig.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "bob", days: 1 });
    expect(g.status).toBe(404);                                 // not to Bob Old
    expect(rig.db.prepare("SELECT COUNT(*) AS n FROM hub_grants WHERE subject=?").get(`${bob.realm}/${bob.objectId}`)).toEqual({ n: 0 });
    await rig.signIn("bob");                                   // the new colleague signs in: now "bob" is theirs
    const g2 = await rig.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "bob", days: 1 });
    expect(g2.status).toBe(200);
    expect(g2.json.grant.subject.person).toEqual(newBob);
    // Two rows carrying one label (case-insensitively): refused, whoever the directory says.
    rig.addPerson("sam");
    await rig.signIn("sam");
    rig.db.prepare("INSERT INTO hub_people(person, realm, object_id, display_name, login_label, status, last_checked_at) VALUES(?,?,?,?,?,'active',0)")
      .run(`corp/${randomUUID()}`, "corp", randomUUID(), "Other Sam", "SAM");
    expect((await rig.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "sam", days: 1 })).status).toBe(404);
  });

  it("a new exposure revision leaves the old grant inapplicable; a freeze stops asking", async () => {
    rig = await s3bRig();
    const { e, link, a, o, roomId } = await world(rig);
    await rig.call(o, "POST", `/hub/v1/exposures/${e.id}/freeze`, { revision: 1 });
    expect((await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "hi" })).status).toBe(403);
    await rig.http.receive(rig.frame("exposure.snapshot", { revision: 2, exposures: [{ ...e, revision: 2, policyDigest: "c".repeat(64) }] }, link) as never, link);
    expect((await rig.call(a, "GET", "/hub/v1/exposures")).json.askable).toHaveLength(0);
  });
});

describe("Hub rooms, dispatch, leases and answers (S3b)", () => {
  it("commits a question before 'queued', dedups by key, and refuses a changed body", async () => {
    rig = await s3bRig();
    rig.setTransport(false);
    const { a, roomId } = await world(rig);
    const key = randomUUID();
    const q1 = await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: key, text: "What were Q3 sales?" });
    expect(q1.json.receipt).toMatchObject({ stage: "queued", sequence: 0, contentDigest: sha("What were Q3 sales?") });
    const q2 = await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: key, text: "What were Q3 sales?" });
    expect(q2.json.receipt.messageId).toBe(q1.json.receipt.messageId);
    expect((await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: key, text: "Something else" })).status).toBe(409);
    expect([...rig.contents.values()]).toEqual([{ question: "What were Q3 sales?" }]);
    expect(rig.db.prepare("SELECT COUNT(*) AS n FROM hub_messages").get()).toEqual({ n: 1 });
    expect(rig.sent).toHaveLength(0);                          // no transport: nothing sent, nothing lost
  });

  it("a failed audit append refuses the question (nothing queued)", async () => {
    rig = await s3bRig();
    const { a, roomId } = await world(rig);
    rig.setAuditFails(true);
    expect((await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "x" })).status).toBe(500);
    expect(rig.db.prepare("SELECT COUNT(*) AS n FROM hub_messages").get()).toEqual({ n: 0 });
  });

  it("only the room's asker reads it; reads are paced and re-check the grant", async () => {
    rig = await s3bRig();
    const { a, o, roomId, grant } = await world(rig);
    expect((await rig.call(o, "GET", `/hub/v1/rooms/${roomId}/messages`)).status).toBe(404);
    expect((await rig.call(a, "GET", `/hub/v1/rooms/${roomId}/messages`)).status).toBe(200);
    const again = await rig.call(a, "GET", `/hub/v1/rooms/${roomId}/messages`);
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("10");
    await rig.call(o, "DELETE", `/hub/v1/grants/${grant.id}?revision=1`);
    const a2 = await rig.signIn("alex");                      // a fresh session: not paced
    expect((await rig.call(a2, "GET", `/hub/v1/rooms/${roomId}/messages`)).status).toBe(403);
  });

  it("sends a signed question on a reconciled link and issues exact, short leases", async () => {
    rig = await s3bRig();
    const { a, roomId, link, fleetId, owner, e } = await world(rig);
    const rec = await rig.http.receive(rig.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, link) as never, link);
    expect(rec).toMatchObject({ type: "reconcile", payload: { receipts: [], more: false } });
    const ask = await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "Q3?" });
    await new Promise((r) => setTimeout(r, 20));
    expect(rig.sent).toHaveLength(1);
    const q = rig.sent[0]!.frame as Extract<HubServerFrame, { type: "question" }>;
    expect(q.type).toBe("question");
    expect(q.linkEpoch).toBe(1);
    const env = verifyAsker(q.payload.identity, "Q3?", { hubId: rig.hubId, issuerKeyId: rig.issuer.keyId, issuerPublicKey: rig.keys.publicKey,
      fleetId, owner, revocationVersion: 0, now: Date.now() });
    expect(env.messageId).toBe(ask.json.receipt.messageId);
    const messageId = env.messageId;
    const auth = (payload: object) => rig!.http.receive(rig!.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, ...payload }, link) as never, link) as Promise<any>;
    const admit = await auth({ phase: "admit" });
    expect(admit.payload.ok).toBe(true);
    expect(admit.payload.lease.expiresAt - Date.now()).toBeLessThanOrEqual(5_000);
    expect((await auth({ phase: "tool", tool: { name: "shell", argumentsDigest: "d".repeat(64) } })).payload).toEqual({ ok: false, reasonCode: "denied" });
    expect((await auth({ phase: "tool", tool: { name: "read_sheet", argumentsDigest: "d".repeat(64) } })).payload.ok).toBe(true);
    // Another fleet never learns the message exists.
    const other = rig.link(randomUUID(), rig.addPerson("zed"));
    const foreign = await rig.http.receive(rig.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "admit" }, other) as never, other) as any;
    expect(foreign.payload).toEqual({ ok: false, reasonCode: "not-found" });
    // The owner disabled in the directory: refused now.
    rig.setEligible("olivia", false);
    expect((await auth({ phase: "begin" })).payload).toEqual({ ok: false, reasonCode: "revoked" });
    void e;
  });

  it("accepts an answer only under the release lease issued for exactly it", async () => {
    rig = await s3bRig();
    const { a, roomId, link } = await world(rig);
    rig.setTransport(false);
    const ask = await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "Q3?" });
    const messageId = ask.json.receipt.messageId;
    const answerId = randomUUID(), text = "Q3 sales were 42.";
    const release = async (digest: string) => {
      const operationId = randomUUID();
      const r = await rig!.http.receive(rig!.frame("authorize.request", { messageId, operationId, exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest: digest } }, link) as never, link) as any;
      expect(r.payload).toMatchObject({ ok: true });
      expect(r.payload.lease.operationDigest).toBe(operationDigest({ messageId, operationId, exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest: digest } }));
      return r.payload.lease;
    };
    const answer = (lease: unknown, body = text) => rig!.http.receive(rig!.frame("answer", { messageId, answerId, text: body, contentDigest: sha(body), releaseLease: lease }, link) as never, link);
    const leaseOther = await release(sha("another answer"));
    await expect(answer(leaseOther)).rejects.toMatchObject({ code: "denied" });
    const lease = await release(sha(text));
    await expect(answer({ ...lease, expiresAt: lease.expiresAt + 1 })).rejects.toMatchObject({ code: "denied" });
    const ack = await answer(lease) as any;
    expect(ack).toMatchObject({ type: "receipt", payload: { messageId, stage: "answered" } });
    await expect(answer(lease)).resolves.toMatchObject({ type: "receipt" });          // the same answer again: the prior ACK
    // A different answer for the same id: refused at release, before any bytes are offered.
    const changed = await rig.http.receive(rig.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer",
      answer: { answerId, contentDigest: sha("changed") } }, link) as never, link) as any;
    expect(changed.payload).toEqual({ ok: false, reasonCode: "conflict" });
    await expect(answer(lease, "changed")).rejects.toMatchObject({ code: "conflict" });
    const read = await rig.call(a, "GET", `/hub/v1/rooms/${roomId}/messages`);
    expect(read.json.entries[0]).toMatchObject({ question: "Q3?", answer: text, receipt: { stage: "answered" } });
  });

  it("a release lease is spent only on the link it was issued on (a replaced link's lease is refused)", async () => {
    rig = await s3bRig();
    const { a, roomId, link, fleetId, owner } = await world(rig);
    rig.setTransport(false);
    const ask = await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "Q" });
    const messageId = ask.json.receipt.messageId, answerId = randomUUID(), text = "A";
    const r = await rig.http.receive(rig.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer",
      answer: { answerId, contentDigest: sha(text) } }, link) as never, link) as any;
    const next = rig.link(fleetId, owner, 2);                  // S1 replaced the link: a new epoch
    link.alive = false;
    await expect(rig.http.receive(rig.frame("answer", { messageId, answerId, text, contentDigest: sha(text), releaseLease: r.payload.lease }, next) as never, next))
      .rejects.toMatchObject({ code: "denied" });
    expect(rig.db.prepare("SELECT answer_ref FROM hub_messages WHERE id=?").get(messageId)).toEqual({ answer_ref: null });
  });

  it("authorization is re-checked at the answer: a grant revoked after the release lease stores nothing", async () => {
    rig = await s3bRig();
    const { a, o, roomId, link, grant } = await world(rig);
    rig.setTransport(false);
    const ask = await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "Q" });
    const messageId = ask.json.receipt.messageId, answerId = randomUUID(), text = "secret answer";
    const r = await rig.http.receive(rig.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer",
      answer: { answerId, contentDigest: sha(text) } }, link) as never, link) as any;
    expect(r.payload.ok).toBe(true);
    await rig.call(o, "DELETE", `/hub/v1/grants/${grant.id}?revision=1`);
    await expect(rig.http.receive(rig.frame("answer", { messageId, answerId, text, contentDigest: sha(text), releaseLease: r.payload.lease }, link) as never, link))
      .rejects.toMatchObject({ code: "revoked" });
    expect(rig.db.prepare("SELECT answer_ref, stage FROM hub_messages WHERE id=?").get(messageId)).toEqual({ answer_ref: null, stage: "queued" });
    expect([...rig.contents.values()].some((c) => c.answer !== undefined)).toBe(false);
    expect(rig.db.prepare("SELECT state FROM hub_rooms WHERE id=?").get(roomId)).toEqual({ state: "closed" });
  });

  it("an expired grant can no longer read its room (nor ask in it)", async () => {
    let now = Date.now();
    rig = await s3bRig({ now: () => now });
    const { a, roomId } = await world(rig);
    now += 7 * 86_400_000 + 1;                                  // world() granted 7 days
    const a2 = await rig.signIn("alex");
    expect((await rig.call(a2, "GET", `/hub/v1/rooms/${roomId}/messages`)).status).toBe(403);
    expect((await rig.call(a2, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "Q" })).status).toBe(403);
    void a;
  });

  it("member receipts are monotonic, never downgrade evidence, and page through reconcile", async () => {
    rig = await s3bRig();
    const { a, roomId, link } = await world(rig);
    rig.setTransport(false);
    const ask = await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "Q" });
    const { messageId, contentDigest } = ask.json.receipt;
    const receipt = (sequence: number, stage: string) => rig!.http.receive(rig!.frame("receipt", { messageId, contentDigest, stage, sequence, at: Date.now() }, link) as never, link);
    await expect(receipt(1, "delivered")).resolves.toMatchObject({ type: "receipt", payload: { sequence: 1 } });
    await expect(receipt(1, "delivered")).resolves.toMatchObject({ type: "receipt" });   // same evidence, same ACK
    await expect(receipt(1, "consumed")).rejects.toMatchObject({ code: "conflict" });
    await expect(receipt(2, "queued")).rejects.toMatchObject({ code: "stale" });
    await expect(receipt(3, "consumed")).resolves.toMatchObject({ type: "receipt" });
    const page = await rig.http.receive(rig.frame("reconcile", { afterReceiptSequence: 1, messages: [{ messageId, contentDigest }] }, link) as never, link) as any;
    expect(page.payload).toMatchObject({ nextReceiptSequence: 3, more: false });
    expect(page.payload.receipts.map((r: { stage: string }) => r.stage)).toEqual(["consumed"]);
    await expect(rig.http.receive(rig.frame("reconcile", { afterReceiptSequence: 0, messages: [{ messageId, contentDigest: "f".repeat(64) }] }, link) as never, link))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("cancels a queued question whose grant was revoked before it could be sent", async () => {
    rig = await s3bRig();
    const { a, o, roomId, link, grant } = await world(rig);
    rig.setTransport(false);
    const ask = await rig.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "Q" });
    await rig.call(o, "DELETE", `/hub/v1/grants/${grant.id}?revision=1`);
    rig.setTransport(true);
    await rig.http.receive(rig.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, link) as never, link);
    await new Promise((r) => setTimeout(r, 30));
    expect(rig.sent).toHaveLength(0);
    expect(rig.db.prepare("SELECT stage, reason_code FROM hub_messages WHERE id=?").get(ask.json.receipt.messageId)).toEqual({ stage: "cancelled", reason_code: "revoked" });
  });
});

describe("Hub administration and pairing (S3b)", () => {
  it("only the configured administrator administers; the owner confirms their own pairing", async () => {
    rig = await s3bRig();
    const owner = rig.addPerson("olivia");
    const o = await rig.signIn("olivia"), ad = await rig.signIn("admin");
    expect((await rig.call(o, "GET", "/hub/v1/admin/overview")).status).toBe(403);
    expect((await rig.call(o, "POST", "/hub/v1/admin/pairings", { login: "olivia" })).status).toBe(403);
    const offer = await rig.call(ad, "POST", "/hub/v1/admin/pairings", { login: "olivia" });
    expect(offer.status).toBe(200);
    expect(offer.json.code).toMatch(/^[a-f0-9]{12}$/);
    const pending = rig.pairing.pair({ code: offer.json.code });
    expect((await rig.call(o, "GET", "/hub/v1/pairings")).json.pairings).toEqual([expect.objectContaining({ id: pending.pairingId, fingerprint: pending.fingerprint })]);
    expect((await rig.call(ad, "POST", `/hub/v1/admin/pairings/${pending.pairingId}/approve`, { fingerprint: pending.fingerprint })).status).toBe(403);  // owner first
    expect((await rig.call(o, "POST", `/hub/v1/pairings/${pending.pairingId}/confirm`, { fingerprint: "e".repeat(64) })).status).toBe(403);
    expect((await rig.call(o, "POST", `/hub/v1/pairings/${pending.pairingId}/confirm`, { fingerprint: pending.fingerprint })).status).toBe(200);
    expect((await rig.call(ad, "POST", `/hub/v1/admin/pairings/${pending.pairingId}/approve`, { fingerprint: pending.fingerprint })).status).toBe(200);
    const view = await rig.call(ad, "GET", "/hub/v1/admin/overview");
    expect(view.json.pairings[0]).toMatchObject({ ownerConfirmed: true, adminApproved: true, owner: { name: "olivia", login: "olivia" } });
    void owner; void WEB_ORIGIN;
  });
});
