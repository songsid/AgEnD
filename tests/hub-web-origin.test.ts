/**
 * M-2901 (#3428 follow-up): a connected Fleet learns the Hub's current web address (src/hub/web-origin.ts).
 * - The statement: signed with the Hub's issuer key, bound to the Hub, its issuer key, the Fleet and the member address;
 *   anything else signed it, or it names another Fleet or a bad address: refused.
 * - The member's kept copy: beside pairing.json (which stays byte-identical), re-verified on every read; revisions only
 *   move forward; the same revision never names two addresses.
 * - The member's step: what it keeps is recorded in its audit, a refusal too, and the write sits inside the record.
 * - The real pinned link: the Hub's welcome carries it only when both ends list web-origin-v1; the pairing view (the
 *   source of the member's three links to the Hub's pages) then names the new address. An older Hub or member: nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { applyHubMigrations, HUB_INSTANCE_MIGRATION, openHubDatabase } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubRig } from "./helpers/hub-rig.js";
import { HubSocket } from "../src/hub/socket.js";
import { HUB_OPTIONAL_CAPABILITIES } from "../src/hub/protocol.js";
import { readPrivateFile } from "../src/hub/private-files.js";
import { issuerKeyId } from "../src/hub/identity.js";
import { createHubMemberPairingApi } from "../src/hub/member/pairing-api.js";
import { HUB_WEB_ORIGIN_CAPABILITY, HubMemberWebOriginStore, createHubWebOriginRecorder, learnHubWebOrigin, signHubWebOrigin, verifyHubWebOrigin, memberWebOriginBinding,
  validHubWebOrigin, type HubWebOriginStatement } from "../src/hub/web-origin.js";
import type { HubMemberProfile } from "../src/hub/profile.js";

const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of rigs.splice(0)) await r.close(); });
type Rig = Awaited<ReturnType<typeof hubRig>>;
async function rig(options: Parameters<typeof hubRig>[0] = {}) { const r = await hubRig(options); rigs.push(r); return r; }
const issuer = (r: Rig) => createPrivateKey(readPrivateFile(r.root, "hub/keys/issuer-key.pem"));
const statementFor = (r: Rig, p: HubMemberProfile, webOrigin: string, revision: number, key = issuer(r), fleetId = p.fleetId) =>
  signHubWebOrigin({ hubId: p.hub.hubId, issuerKeyId: issuerKeyId(key), fleetId, memberOrigin: p.hub.memberOrigin }, webOrigin, revision, key);
const pairingFile = (r: Rig, p: HubMemberProfile) => join(r.memberHome, "hub-member", p.hub.hubId, "pairing.json");
const keptFile = (r: Rig, p: HubMemberProfile) => join(r.memberHome, "hub-member", p.hub.hubId, "web-origin.json");
const NEW = "https://hub2.example.test:8443";

describe("M-2901 the Hub's signed web-address statement", () => {
  it("verifies only for this Hub's issuer key, this Fleet and this member address; a forged one is refused", async () => {
    const r = await rig(), p = await r.pair(), { binding, key } = memberWebOriginBinding(p);
    const good = statementFor(r, p, NEW, 1);
    expect(verifyHubWebOrigin(good, binding, key)).toEqual(good);
    // Another key, even one that claims this Hub's issuer key id: refused.
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(() => signHubWebOrigin({ ...binding, issuerKeyId: binding.issuerKeyId }, NEW, 1, other)).toThrow();
    const forged = { ...good, signature: signHubWebOrigin({ ...binding, issuerKeyId: issuerKeyId(other) }, NEW, 1, other).signature };
    expect(() => verifyHubWebOrigin(forged, binding, key)).toThrow(expect.objectContaining({ code: "denied" }));
    // Signed for another Fleet of the same Hub; or changed after signing (address, revision): refused.
    expect(() => verifyHubWebOrigin(statementFor(r, p, NEW, 1, issuer(r), randomUUID()), binding, key)).toThrow();
    expect(() => verifyHubWebOrigin({ ...good, webOrigin: "https://evil.example.test" }, binding, key)).toThrow();
    expect(() => verifyHubWebOrigin({ ...good, revision: 2 }, binding, key)).toThrow();
    expect(() => verifyHubWebOrigin({ ...good, extra: 1 }, binding, key)).toThrow();
  });

  it("names only an address a join would take: a bare https origin, never the member address", async () => {
    const r = await rig(), p = await r.pair();
    for (const bad of ["http://hub2.example.test", "https://hub2.example.test/path", "https://user:pw@hub2.example.test", "https://hub2.example.test.", p.hub.memberOrigin, "not a url"]) {
      expect(validHubWebOrigin(bad, p.hub.memberOrigin)).toBe(false);
      expect(() => statementFor(r, p, bad, 1)).toThrow();
      // Even signed by the Hub's own issuer key (the tuple signed by hand, as a faulty Hub would): the member refuses it.
      const { binding, key } = memberWebOriginBinding(p);
      const signature = sign(null, Buffer.from(JSON.stringify(["agend-hub-web-origin-v1", 1, binding.hubId, binding.issuerKeyId, binding.fleetId, binding.memberOrigin, bad, 1])), issuer(r)).toString("base64url");
      expect(() => verifyHubWebOrigin({ v: 1, webOrigin: bad, revision: 1, signature }, binding, key)).toThrow();
    }
    // The same hand-signed tuple with a good address verifies (the test's own tuple matches the real one).
    const { binding, key } = memberWebOriginBinding(p);
    const signature = sign(null, Buffer.from(JSON.stringify(["agend-hub-web-origin-v1", 1, binding.hubId, binding.issuerKeyId, binding.fleetId, binding.memberOrigin, NEW, 1])), issuer(r)).toString("base64url");
    expect(verifyHubWebOrigin({ v: 1, webOrigin: NEW, revision: 1, signature }, binding, key).webOrigin).toBe(NEW);
    expect(validHubWebOrigin(NEW, p.hub.memberOrigin)).toBe(true);
  });
});

describe("M-2901 the member's kept statement", () => {
  it("only moves forward; the same revision never names two addresses; the profile's address is revision 0", async () => {
    const r = await rig(), p = await r.pair(), store = new HubMemberWebOriginStore(r.memberHome, p.hub.hubId);
    expect(store.effective(p)).toBe(p.hub.webOrigin);
    expect(store.plan(p, statementFor(r, p, p.hub.webOrigin, 0))).toEqual({ kind: "unchanged" });       // a Hub that never moved
    expect(() => store.plan(p, statementFor(r, p, NEW, 0))).toThrow(expect.objectContaining({ code: "stale" }));
    expect(store.plan(p, statementFor(r, p, NEW, 2))).toEqual({ kind: "changed", from: p.hub.webOrigin });
    store.save(p, statementFor(r, p, NEW, 2), () => true);
    expect(store.effective(p)).toBe(NEW);
    expect(store.plan(p, statementFor(r, p, NEW, 2))).toEqual({ kind: "unchanged" });
    expect(() => store.plan(p, statementFor(r, p, "https://hub3.example.test", 2))).toThrow(expect.objectContaining({ code: "stale" }));
    expect(() => store.plan(p, statementFor(r, p, p.hub.webOrigin, 1))).toThrow(expect.objectContaining({ code: "stale" }));   // no rollback
    expect(store.plan(p, statementFor(r, p, p.hub.webOrigin, 3))).toEqual({ kind: "changed", from: NEW });  // moved back, later
  });

  it("is re-verified on every read: a kept file edited by hand, or signed by another key, is as if absent", async () => {
    const r = await rig(), p = await r.pair(), store = new HubMemberWebOriginStore(r.memberHome, p.hub.hubId);
    store.save(p, statementFor(r, p, NEW, 1), () => true);
    const kept = JSON.parse(readFileSync(keptFile(r, p), "utf8"));
    writeFileSync(keptFile(r, p), JSON.stringify({ ...kept, webOrigin: "https://evil.example.test" }), { mode: 0o600 });
    expect(store.read(p)).toBeNull();
    expect(store.effective(p)).toBe(p.hub.webOrigin);
    const other = generateKeyPairSync("ed25519").privateKey;
    writeFileSync(keptFile(r, p), JSON.stringify(signHubWebOrigin({ ...memberWebOriginBinding(p).binding, issuerKeyId: issuerKeyId(other) }, NEW, 1, other)), { mode: 0o600 });
    expect(store.effective(p)).toBe(p.hub.webOrigin);
    // save() verifies too: a forged statement is never written.
    expect(() => store.save(p, { ...statementFor(r, p, NEW, 4), webOrigin: "https://evil.example.test" }, () => true)).toThrow();
  });
});

describe("M-2901 the member's step: verify, decide, keep — each recorded", () => {
  const step = (r: Rig, p: HubMemberProfile) => {
    const records: Array<{ action: string; result: string; reasonCode: string; requestId: string; keptBefore: boolean }> = [];
    const run = (statement: unknown) => learnHubWebOrigin({ home: r.memberHome, profile: p, current: () => true, log: () => {},
      record: entry => { records.push({ ...entry, keptBefore: existsSync(keptFile(r, p)) }); } }, statement);
    return { records, run };
  };
  it("a new address: recorded first, then kept; pairing.json is byte-identical; the same again: nothing", async () => {
    const r = await rig(), p = await r.pair(), before = readFileSync(pairingFile(r, p)), s = step(r, p);
    expect(s.run(statementFor(r, p, NEW, 1))).toBe("updated");
    expect(s.records).toEqual([{ action: "web-origin.updated", result: "completed", reasonCode: "revision:1", requestId: expect.stringMatching(/^web-origin:[a-f0-9]{64}$/), keptBefore: false }]);
    expect(existsSync(keptFile(r, p))).toBe(true);
    expect(readFileSync(pairingFile(r, p)).equals(before)).toBe(true);
    expect(s.run(statementFor(r, p, NEW, 1))).toBe("unchanged");
    expect(s.records).toHaveLength(1);
  });
  it("a forged or rolled-back statement: refused, recorded as denied, nothing kept", async () => {
    const r = await rig(), p = await r.pair(), s = step(r, p);
    const other = generateKeyPairSync("ed25519").privateKey;
    const forged = signHubWebOrigin({ ...memberWebOriginBinding(p).binding, issuerKeyId: issuerKeyId(other) }, NEW, 5, other);
    expect(s.run(forged)).toBe("refused");
    expect(s.run({ v: 1, webOrigin: NEW, revision: 5 })).toBe("refused");                                     // unsigned
    expect(s.records.map(x => [x.action, x.result, x.reasonCode])).toEqual([["web-origin.refused", "denied", "unverified"], ["web-origin.refused", "denied", "unverified"]]);
    expect(existsSync(keptFile(r, p))).toBe(false);
    expect(s.run(statementFor(r, p, NEW, 3))).toBe("updated");
    expect(s.run(statementFor(r, p, "https://hub3.example.test", 2))).toBe("refused");
    expect(s.records.at(-1)).toMatchObject({ action: "web-origin.refused", reasonCode: "stale" });
    expect(new HubMemberWebOriginStore(r.memberHome, p.hub.hubId).effective(p)).toBe(NEW);
  });
});

describe("M-2901 (#3797 r1, Prism P2): the record commits before the kept file — never a changed address without its record", () => {
  /** The member's own audit, as compose/member.ts opens it, with the production recorder. */
  async function audited() {
    const r = await rig(), p = await r.pair();
    const db = openHubDatabase(r.memberHome, "hub-member/audit-test.sqlite", { create: true });
    applyHubMigrations(db, [HUB_INSTANCE_MIGRATION, HUB_AUDIT_MIGRATION]);
    const audit = createHubAudit({ db, contentKey: randomBytes(32) });
    const record = createHubWebOriginRecorder({ db, audit, now: Date.now, fleetId: p.fleetId, policyVersion: () => 0 });
    const rows = (action: string) => (db.prepare("SELECT count(*) n FROM hub_audit WHERE action = ?").get(action) as { n: number }).n;
    const effective = () => new HubMemberWebOriginStore(r.memberHome, p.hub.hubId).effective(p);
    const learn = (statement: unknown, current = () => true) => learnHubWebOrigin({ home: r.memberHome, profile: p, current, log: () => {}, record }, statement);
    return { r, p, db, rows, effective, learn };
  }
  it("the record does not commit (SQLite aborts it): nothing kept, the address unchanged; the retry records once and keeps it", async () => {
    const { r, p, db, rows, effective, learn } = await audited(), before = readFileSync(pairingFile(r, p));
    db.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON hub_audit BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => learn(statementFor(r, p, NEW, 1))).toThrow(/disk full/);
    expect(rows("web-origin.updated")).toBe(0);
    expect(existsSync(keptFile(r, p))).toBe(false);
    expect(effective()).toBe(p.hub.webOrigin);
    db.exec("DROP TRIGGER fail_audit");
    expect(learn(statementFor(r, p, NEW, 1))).toBe("updated");
    expect(rows("web-origin.updated")).toBe(1);
    expect(effective()).toBe(NEW);
    expect(readFileSync(pairingFile(r, p)).equals(before)).toBe(true);
    db.close();
  });
  it("the kept file is not written after the record committed: the address unchanged; the retry adds no second record and keeps it", async () => {
    const { r, p, db, rows, effective, learn } = await audited();
    expect(() => learn(statementFor(r, p, NEW, 1), () => false)).toThrow();                // the link went away before the write
    expect(rows("web-origin.updated")).toBe(1);
    expect(effective()).toBe(p.hub.webOrigin);
    expect(learn(statementFor(r, p, NEW, 1))).toBe("updated");
    expect(rows("web-origin.updated")).toBe(1);                                                   // the same statement: its one record
    expect(effective()).toBe(NEW);
    expect(learn(statementFor(r, p, NEW, 1))).toBe("unchanged");
    expect(rows("web-origin.updated")).toBe(1);
    db.close();
  });
  it("the same forged statement on every reconnect is one record, not one per link", async () => {
    const { r, p, db, rows, learn } = await audited();
    const other = generateKeyPairSync("ed25519").privateKey;
    const forged = signHubWebOrigin({ ...memberWebOriginBinding(p).binding, issuerKeyId: issuerKeyId(other) }, NEW, 5, other);
    for (let i = 0; i < 3; i++) expect(learn(forged)).toBe("refused");
    expect(rows("web-origin.refused")).toBe(1);
    db.close();
  });
});

describe("M-2901 over the real pinned link (welcome, web-origin-v1)", () => {
  function frames() {
    const sent: any[] = [], original = HubSocket.prototype.send;
    vi.spyOn(HubSocket.prototype, "send").mockImplementation(function (this: HubSocket<any, any>, frame: any) { sent.push(frame); return original.call(this, frame); });
    return sent;
  }
  async function moved(opts: { client?: readonly string[]; server?: readonly string[] } = {}) {
    let signer: ((fleetId: string) => HubWebOriginStatement) | undefined;
    const got: HubWebOriginStatement[] = [];
    let profile!: HubMemberProfile;
    const r = await rig({ ...(opts.server ? { serverCapabilities: opts.server } : {}), serverWebOrigin: fleetId => signer!(fleetId),
      clientWebOrigin: statement => { got.push(statement); learnHubWebOrigin({ home: r.memberHome, profile, current: () => true, log: () => {}, record: () => {} }, statement); } });
    profile = await r.pair();
    signer = fleetId => statementFor(r, profile, NEW, 1, issuer(r), fleetId);
    return { r, profile, got };
  }
  it("both ends list it: the welcome carries the signed address, the member keeps it, and its pairing view names it", async () => {
    const sent = frames(), { r, profile, got } = await moved(), before = readFileSync(pairingFile(r, profile));
    const c = r.client(); await c.value.start();
    expect(HUB_OPTIONAL_CAPABILITIES).toContain(HUB_WEB_ORIGIN_CAPABILITY);
    expect(c.state.link!.features.has(HUB_WEB_ORIGIN_CAPABILITY)).toBe(true);
    expect(sent.find(f => f.type === "welcome").payload.webOrigin).toMatchObject({ v: 1, webOrigin: NEW, revision: 1 });
    expect(got).toHaveLength(1);
    await vi.waitFor(() => expect(existsSync(keptFile(r, profile))).toBe(true));
    // The member's own pages build every Hub link from this view's webOrigin (settings-hub.js, hub-switcher.js).
    writeFileSync(join(r.memberHome, "hub-member/state.json"), JSON.stringify({ hubId: profile.hub.hubId }), { mode: 0o600 });
    const view = createHubMemberPairingApi({ home: r.memberHome, link: () => "online" }).view() as any;
    expect(view).toMatchObject({ state: "paired", hub: { webOrigin: NEW, memberOrigin: profile.hub.memberOrigin } });
    expect(readFileSync(pairingFile(r, profile)).equals(before)).toBe(true);
    expect(c.state.syncs).toBe(1);                                                                // the link reconciled as before
  });
  it("an older member (does not list it): no webOrigin field in the welcome; its strict schema never meets it", async () => {
    const sent = frames(), { r, got } = await moved();
    const c = r.client(undefined, undefined, HUB_OPTIONAL_CAPABILITIES.filter(x => x !== HUB_WEB_ORIGIN_CAPABILITY)); await c.value.start();
    expect(sent.find(f => f.type === "welcome").payload).not.toHaveProperty("webOrigin");
    expect(got).toEqual([]);
  });
  it("an older Hub (does not list it): nothing sent, nothing learned, the link works", async () => {
    const sent = frames(), { r, profile, got } = await moved({ server: HUB_OPTIONAL_CAPABILITIES.filter(x => x !== HUB_WEB_ORIGIN_CAPABILITY) });
    const c = r.client(); await c.value.start();
    expect(sent.find(f => f.type === "welcome").payload).not.toHaveProperty("webOrigin");
    expect(got).toEqual([]);
    expect(existsSync(keptFile(r, profile))).toBe(false);
    expect(c.state.syncs).toBe(1);
  });
});
