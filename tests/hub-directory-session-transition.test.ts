/** Owned loopback HTTPS, private SQLite and fake people only. No fleet/service or real directory. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, request } from "node:https";
import { applyHubMigrations, createHubUnitOfWork, hubTxDatabase, openHubDatabase } from "../src/hub/db.js";
import { createHubHttp, HUB_HTTP_MIGRATIONS, type HubHttp } from "../src/hub/http/compose.js";
import { HubPairingService } from "../src/hub/pairing.js";
import { HUB_TRANSPORT_MIGRATION, HubTransportStore } from "../src/hub/store.js";
import { issuerKeyId, signAsker } from "../src/hub/identity.js";
import { createBrowserCertificate } from "../src/hub/init/browser-certificate.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import { tempDir } from "./support/hub-init-fixtures.js";
import { advanceHubSessionEpoch, readHubSessionEpoch, HUB_SESSION_EPOCH_MIGRATION } from "../src/hub/session-epoch.js";
import { HubSessions } from "../src/hub/sessions.js";
import { HubCore } from "../src/hub/http/core.js";
import { groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";
import { HUB_SESSION_AUTHENTICATION_MIGRATION } from "../src/hub/session-directory-transition.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { createHubSettingsWriter } from "../src/hub/settings-commit.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { BIND_PASSWORD_REF, BIND_SECRET_REL } from "../src/hub/init/layout.js";
import { ensurePrivateDirectory } from "../src/hub/private-files.js";
import { hubCookieName, hubCsrfOf } from "../src/hub/sessions.js";

function held() {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(r => { enter = r; }), wait: new Promise<void>(r => { release = r; }), enter: () => enter(), release: () => release() };
}

async function httpsRig(sealed = false) {
  const home = tempDir("hub-epoch-"), path = join(home, "hub", "test.sqlite");
  const material = await createBrowserCertificate(home, "https://127.0.0.1");
  const cert = readFileSync(material.certFile), key = readFileSync(material.keyFile);
  const identity = sealed ? await provisionHubIdentity({home,memberOrigin:"https://member.example.test"}) : undefined;
  const person = { realm: "fictional", objectId: randomUUID() }, hubId = identity?.hubId ?? randomUUID(), keys = generateKeyPairSync("ed25519");
  const found = { key: person, login: "avery", dn: "fictional", groups: [], displayName: "Avery (fictional)" };
  let signInHold: ReturnType<typeof held> | undefined, eligibilityHold: ReturnType<typeof held> | undefined;
  let signInCalls = 0, now = 1_000_000, auditHook: (() => void) | undefined;
  const directory: HubDirectory = {
    realm: person.realm,
    async signIn(login, password) {
      signInCalls++;
      const h = signInHold; if (h) { h.enter(); await h.wait; }
      return login === "avery" && password === "dummy-password" ? { ok: true, person: found } : { ok: false, reason: "invalid-credentials" };
    },
    async checkEligibility() {
      const h = eligibilityHold; if (h) { h.enter(); await h.wait; }
      return { eligible: true, person: found };
    },
    async close() {},
  };
  let db = openHubDatabase(home, "hub/test.sqlite", { create: true });
  let http: HubHttp, port = 0, origin = "", floor = 0, mounted = true;
  let store: HubTransportStore;
  let sessions: HubSessions, decision: ReturnType<typeof createHubDirectorySettingsDecision>;
  let server: ReturnType<typeof createServer>;
  const open = async () => {
    applyHubMigrations(db, [HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS, groupPolicyMigration(hubId, person.realm, "old-generation"), HUB_DIRECTORY_SETTINGS_MIGRATION]);
    db.exec("CREATE TABLE IF NOT EXISTS test_audit(value TEXT NOT NULL)");
    store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } },
      appendAudit: (record, owningDb) => { owningDb.prepare("INSERT INTO test_audit VALUES(?)").run(JSON.stringify(record)); const hook = auditHook; auditHook = undefined; hook?.(); } });
    if (!db.prepare("SELECT 1 FROM hub_transport_state").get()) store.initialize();
    server = createServer({ cert, key }, (req, res) => { if (!http.handle(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
    port = (server.address() as { port: number }).port; origin = `https://127.0.0.1:${port}`;
    openHttp();
  };
  const openHttp = () => {
    const pairing = new HubPairingService({ store, directory, enabled: () => true, fenceFleet() {},
      identity: { hubId, memberOrigin: "https://member.example.test", webOrigin: origin, spkiSha256: "a".repeat(64),
        issuerPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() } });
    decision = createHubDirectorySettingsDecision({ db, transport: store, hubId });
    const deps: ConstructorParameters<typeof HubCore>[0] = { store, directory, pairing, config: { hubId, name: "Fictional", memberOrigin: "https://member.example.test", webOrigin: origin, administrator: person },
      uow: createHubUnitOfWork(db), audit: { append(tx, record) {
        hubTxDatabase(tx).prepare("INSERT INTO test_audit VALUES(?)").run(JSON.stringify(record)); const hook = auditHook; auditHook = undefined; hook?.();
      }, async read() { return []; }, async readContent(): Promise<never> { throw Error("not used"); } },
      issuer: { keyId: issuerKeyId(keys.publicKey), sign: e => signAsker(e, keys.privateKey) }, content: { put(): never { throw Error("not used"); }, get() { return undefined; } },
      transport: () => null, current: () => ({ serverEnabled: () => mounted, memberEnabled: () => false, epoch: () => 0 }),
      now: () => now,
    };
    http = createHubHttp(deps, hubTxDatabase); sessions = new HubSessions(new HubCore(deps, hubTxDatabase));
  };
  const stop = async () => { await http.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); db.close(); };
  await open();
  type Browser = { cookie: string; csrf: string };
  const call = (browser: Browser | null, method: string, path: string, value?: unknown) => new Promise<{ status: number; json: any; cookie: string }>((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const req = request(origin + path, { method, ca: cert, agent: false, headers: { Origin: origin, ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
      ...(browser ? { Cookie: browser.cookie, "X-AgEnD-Hub-CSRF": browser.csrf } : {}) } }, res => {
      let text = ""; res.on("data", b => { text += b; }); res.on("end", () => {
        try { resolve({ status: res.statusCode!, json: JSON.parse(text), cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0]! }); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject); req.end(body);
  });
  return { get db() { return db; }, home, hubId, get signInCalls() { return signInCalls; }, call, person,
    get sessions() { return sessions; }, get decision() { return decision; },
    setNow: (n: number) => { now = n; }, get now() { return now; }, setMounted: (value: boolean) => { mounted = value; },
    actor(browser: Browser) { const s = sessions.session(browser.cookie.split("=")[1]!); if (!s) throw Error("no session"); return { kind: "hub-administrator" as const, person, sessionId: s.sessionId, requestId: randomUUID() }; },
    token(browser: Browser) { return browser.cookie.split("=")[1]!; },
    browser(token: string): Browser { return { cookie: `${hubCookieName(hubId)}=${token}`, csrf: hubCsrfOf(token) }; },
    input(actor: HubDirectoryDecisionRequest["actor"]): HubDirectoryDecisionRequest {
      const image = (n: string) => Object.fromEntries(["configDigest","configSha","directorySha","manifestSha","bindSecretSha"].map(k => [k,n.repeat(64)])) as HubDirectoryDecisionRequest["before"];
      return { id: randomUUID(), expected: decision.inspect(), before: image("a"), after: image("b"), generation: "new-generation", receiptSha: "c".repeat(64), actor, at: now, changes: ["server"], recipients: [{kind:"host",sink:"owner-test"}] };
    },
    remount: async () => { await http.close(); openHttp(); },
    signIn: async () => { const r = await call(null, "POST", "/hub/v1/session", { login: "avery", password: "dummy-password" }); return { ...r, csrf: r.json.csrf as string }; },
    holdSignIn: () => (signInHold = held()), holdEligibility: () => (eligibilityHold = held()),
    advance: () => db.transaction(() => advanceHubSessionEpoch(db, readHubSessionEpoch(db))).immediate(),
    tick: () => { now += 1000; }, auditOnce: (hook: () => void) => { auditHook = hook; },
    restart: async () => { await stop(); db = openHubDatabase(home, "hub/test.sqlite", { create: false }); await open(); },
    close: async () => { signInHold?.release(); eligibilityHold?.release(); await stop(); material.cleanup(); rmSync(home, { recursive: true, force: true }); expect(existsSync(home)).toBe(false); },
  };
}

let rig: Awaited<ReturnType<typeof httpsRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });

async function setup(delay = 0) {
  const r = rig = await httpsRig(), browser = await r.signIn();
  expect(browser.status).toBe(200);
  r.setNow(r.now + delay);
  const actor = r.actor(browser), rotation = r.sessions.prepareDirectoryRotation(r.token(browser), actor);
  return { r, browser, actor, rotation, input: r.input(actor) };
}

describe("trusted-directory authentication attestation", () => {
  it("records actual AD authentication separately from session access, and expires it after five minutes", async () => {
    const { r, browser, actor } = await setup(), at = r.now;
    expect(r.sessions.recentAuthentication(actor)).toBe(at);
    r.setNow(at + 300_000); expect(r.sessions.recentAuthentication(actor)).toBe(at);
    await r.call(browser, "GET", "/hub/v1/session");
    r.setNow(at + 300_001); expect(r.sessions.recentAuthentication(actor)).toBeNull();
    expect(r.db.prepare("SELECT authenticated_at FROM hub_session_authentication").get()).toEqual({ authenticated_at: at });
  });
  it.each(["backward", "ended", "wrong-person", "wrong-epoch", "legacy", "idle"])("does not attest %s authority", async kind => {
    const { r, actor } = await setup();
    if (kind === "backward") r.setNow(r.now - 1);
    if (kind === "ended") r.db.exec("UPDATE hub_sessions SET state='ended'");
    if (kind === "wrong-person") actor.person = { ...actor.person, objectId: randomUUID() };
    if (kind === "wrong-epoch") r.db.exec("UPDATE hub_session_authentication SET directory_epoch=99");
    if (kind === "legacy") r.db.exec("DELETE FROM hub_session_authentication");
    if (kind === "idle") r.setNow(r.now + 3_600_001);
    expect(r.sessions.recentAuthentication(actor)).toBeNull();
  });
  it("never turns a rotated session's new creation time into a recent authentication proof", async () => {
    const { r, input, rotation } = await setup(); r.tick();
    r.decision.decide(input, () => {}, rotation); await r.remount();
    const replacement = r.sessions.completeDirectoryRotation(rotation, input.id), next = r.browser(replacement.token);
    expect((await r.call(next, "GET", "/hub/v1/session")).json.signedIn).toBe(true);
    expect(r.sessions.recentAuthentication(r.actor(next))).toBeNull();
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_session_authentication").get()).toEqual({ n: 1 });
  });
  it("refuses a mounted old-epoch attestation after the actual decision", async () => {
    const { r, actor, rotation, input } = await setup(); r.decision.decide(input, () => {}, rotation);
    expect(() => r.sessions.recentAuthentication(actor)).toThrow(/unavailable/);
  });
});

describe("one SQL decision and narrow browser successor", () => {
  it("atomically ends every old session and creates only the actor's fresh token/CSRF with the old absolute expiry", async () => {
    const { r, browser, input, rotation } = await setup(), other = await r.signIn();
    const expiry = (r.db.prepare("SELECT expires_at FROM hub_sessions LIMIT 1").get() as {expires_at:number}).expires_at;
    const saved = r.decision.decide(input, () => {}, rotation);
    expect(saved.browserSession).toMatchObject({v:1,previousSessionId:input.actor.sessionId});
    expect(r.db.prepare("SELECT state,directory_epoch,expires_at FROM hub_sessions ORDER BY rowid").all()).toEqual([
      { state: "ended", directory_epoch: 0, expires_at: expiry }, { state: "ended", directory_epoch: 0, expires_at: expiry },
      { state: "active", directory_epoch: 1, expires_at: expiry },
    ]);
    expect(() => r.sessions.completeDirectoryRotation(rotation, input.id)).toThrow(); // old mounted core
    await r.remount(); r.setMounted(false);
    expect(() => r.sessions.completeDirectoryRotation(rotation, input.id)).toThrow();
    r.setMounted(true);
    const next = r.sessions.completeDirectoryRotation(rotation, input.id), successor = r.browser(next.token);
    expect(next.token).not.toBe(r.token(browser)); expect(successor.csrf).not.toBe(browser.csrf);
    expect((await r.call(successor, "GET", "/hub/v1/session")).json).toMatchObject({ signedIn: true, admin: true });
    for (const old of [browser, other]) expect((await r.call(old, "GET", "/hub/v1/session")).json.signedIn).toBe(false);
    expect((await r.call({ ...successor, csrf: browser.csrf }, "DELETE", "/hub/v1/session")).status).toBe(403);
    expect(() => r.sessions.completeDirectoryRotation(rotation, input.id)).toThrow();
    for (const table of ["hub_settings_operations", "hub_settings_security_notices", "test_audit"]) {
      const body = JSON.stringify(r.db.prepare(`SELECT * FROM ${table}`).all());
      expect(body).not.toContain(next.token); expect(body).not.toContain(successor.csrf);
    }
  });
  it("an abandoned/crashed originating response has no cookie-based retrieval route; ordinary sign-in still works after restart", async () => {
    const { r, browser, input, rotation } = await setup();
    r.decision.decide(input, () => {}, rotation); rotation.discard(); await r.restart();
    expect(() => r.sessions.completeDirectoryRotation(rotation, input.id)).toThrow();
    expect((await r.call(browser, "GET", "/hub/v1/session")).json.signedIn).toBe(false);
    expect((await r.signIn()).status).toBe(200);
  });
  it("can release exactly once after a physical SQLite/HTTPS reopen if the original request still holds its private handle", async () => {
    const { r, input, rotation } = await setup(); r.decision.decide(input, () => {}, rotation); await r.restart();
    const next = r.sessions.completeDirectoryRotation(rotation, input.id);
    expect((await r.call(r.browser(next.token), "GET", "/hub/v1/session")).json.signedIn).toBe(true);
    expect(() => r.sessions.completeDirectoryRotation(rotation, input.id)).toThrow();
  });
  it("host recovery advances the epoch but never manufactures an administrator session", async () => {
    const { r, actor } = await setup();
    r.decision.decide(r.input({ kind: "host-owner", sessionId: actor.sessionId, requestId: actor.requestId }), () => {});
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_sessions WHERE state='active'").get()).toEqual({ n: 0 });
  });
  it.each(["host", "person", "session", "request", "epoch", "forged"])("refuses a %s handoff mismatch before advancing the epoch", async kind => {
    const { r, input, rotation } = await setup();
    if (kind === "host") input.actor = { kind: "host-owner", sessionId: input.actor.sessionId, requestId: input.actor.requestId };
    if (kind === "person" && input.actor.kind === "hub-administrator") input.actor.person = { ...input.actor.person, objectId: randomUUID() };
    if (kind === "session") input.actor.sessionId = "another-session";
    if (kind === "request") input.actor.requestId = randomUUID();
    if (kind === "epoch") input.expected.directoryEpoch++;
    expect(() => r.decision.decide(input, () => {}, kind === "forged" ? { discard() {} } : rotation)).toThrow();
    expect(readHubSessionEpoch(r.db)).toBe(0);
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_settings_operations").get()).toEqual({ n: 0 });
  });
  it.each(["expired", "backward", "signed-out", "changed-token", "changed-expiry", "discarded"])("rechecks a %s source session after the required audit and rolls ALL SQL back", async kind => {
    const { r, input, rotation } = await setup(kind === "backward" ? 1000 : 0), before = r.now;
    r.auditOnce(() => {
      if (kind === "expired") r.setNow(before + 300_000);
      if (kind === "backward") r.setNow(before - 1);
      if (kind === "signed-out") r.db.exec("UPDATE hub_sessions SET state='ended'");
      if (kind === "changed-token") r.db.exec("UPDATE hub_sessions SET token_hash='replacement'");
      if (kind === "changed-expiry") r.db.exec("UPDATE hub_sessions SET expires_at=expires_at+1");
      if (kind === "discarded") rotation.discard();
    });
    expect(() => r.decision.decide(input, () => {}, rotation)).toThrow();
    expect(readHubSessionEpoch(r.db)).toBe(0);
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_settings_operations").get()).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT state,directory_epoch FROM hub_sessions").all()).toEqual([{ state: "active", directory_epoch: 0 }]);
    expect(() => r.decision.inspect()).toThrow(/uncertain/); // floor advanced before audit; no rewind
    expect(() => r.decision.decide(input, () => {}, rotation)).toThrow(); // consumed even on refusal
  });
  it("rejects a handoff captured from a different owning SQLite DB", async () => {
    const { r, input, rotation } = await setup();
    const db = openHubDatabase(r.db.name.replace(/\/hub\/test.sqlite$/, ""), "hub/other.sqlite", { create: true });
    try {
      applyHubMigrations(db, [HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS, groupPolicyMigration(r.decision.hubId, r.person.realm, "old-generation"), HUB_DIRECTORY_SETTINGS_MIGRATION]);
      for (const table of ["hub_people","hub_sessions"] as const) {
        for (const existing of r.db.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[]) {
          db.prepare(`INSERT INTO ${table} VALUES(${Object.keys(existing).map(()=>"?").join(",")})`).run(...Object.values(existing));
        }
      }
      let floor=0;
      const store = new HubTransportStore(db, { floor: {read:()=>floor,raise:n=>{floor=n;}}, appendAudit() {} }); store.initialize();
      const decision = createHubDirectorySettingsDecision({db,transport:store,hubId:r.decision.hubId});
      expect(() => decision.decide({...input,expected:decision.inspect()}, () => {}, rotation)).toThrow();
      expect(readHubSessionEpoch(db)).toBe(0);
    } finally { db.close(); }
  });
  it("a held old-directory sign-in cannot join the new epoch during an actual settings decision", async () => {
    const { r, input, rotation } = await setup(), h = r.holdSignIn(), pending = r.signIn();
    await h.entered; r.decision.decide(input, () => {}, rotation); h.release();
    expect((await pending).status).toBe(503);
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_sessions").get()).toEqual({ n: 2 });
  });
  it("does not release for another operation, after timeout, or after another epoch advanced", async () => {
    const { r, input, rotation } = await setup(), start = r.now;
    r.decision.decide(input, () => {}, rotation); await r.remount();
    expect(() => r.sessions.completeDirectoryRotation(rotation, randomUUID())).toThrow();
    r.setNow(start + 300_000); expect(() => r.sessions.completeDirectoryRotation(rotation, input.id)).toThrow();
    r.setNow(start); r.advance(); expect(() => r.sessions.completeDirectoryRotation(rotation, input.id)).toThrow();
  });
});

it("requires the new authentication schema for new binaries and refuses downgrade instead of inferring old attestations", async () => {
  const r = rig = await httpsRig(), old = [HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS.filter(m => m !== HUB_SESSION_AUTHENTICATION_MIGRATION),
    groupPolicyMigration(r.decision.hubId, r.person.realm, "old-generation"), HUB_DIRECTORY_SETTINGS_MIGRATION];
  expect(() => applyHubMigrations(r.db, old)).toThrow(/s5-session-authentication/);
  r.db.exec("DROP TABLE hub_session_authentication");
  const browser = await r.signIn(); expect([500,503]).toContain(browser.status);
  expect(r.db.prepare("SELECT COUNT(*) n FROM hub_sessions").get()).toEqual({ n: 0 });
});

it.each(["normal","lost-response","compensated"])("the actual sealed writer forwards the request-local transition into its root decision (%s)", async mode => {
  const interrupted=mode === "lost-response";
  const r = rig = await httpsRig(true), browser = await r.signIn(), actor = r.actor(browser);
  const rotation = r.sessions.prepareDirectoryRotation(r.token(browser), actor);
  let hub = {enabled:true,hubId:r.hubId,memberOrigin:"https://member.example.test",webOrigin:"https://hub.example.test",
    webListen:{host:"127.0.0.1",port:8444},memberListen:{host:"127.0.0.1",port:8443},administrator:r.person,
    directory:{realm:r.person.realm,profile:"ad" as const,url:"ldaps://old.example.test",baseDn:"DC=example,DC=test",bindDn:"CN=Reader",bindPasswordRef:BIND_PASSWORD_REF},retention:{contentDays:30,eventDays:90},coexistence:"dedicated"};
  ensurePrivateDirectory(r.home,"hub/secrets"); writeFileSync(join(r.home,BIND_SECRET_REL),"dummy-old-service",{mode:0o600});
  const planDigest = hubPlanDigest(hub), confirmationId="d".repeat(32), committedAt=new Date(r.now).toISOString();
  writeFileSync(join(r.home,"hub/init-manifest.json"),JSON.stringify({v:1,hubId:r.hubId,planDigest,confirmationId,committedAt,
    signature:sealHubInitialization({home:r.home,planDigest,confirmationId,committedAt})}),{mode:0o600});
  const writer = createHubSettingsWriter({home:r.home,readHub:()=>hub,now:()=>r.now,directoryDecision:()=>r.decision,
    saveHub(patches){for(const p of patches)if(p.path[1]==="directory")hub={...hub,directory:p.value as typeof hub.directory};},
    step(name){if(interrupted&&name==="directory-decision")throw Error("simulated response lost after SQL");}});
  const candidate={directory:{...hub.directory,baseDn:"OU=People,DC=example,DC=test"},changes:["search"] as const,recipients:[{kind:"host" as const,sink:"owner-test"}]};
  const prepared=writer.directory!.prepare({...candidate,changes:[...candidate.changes]},actor,()=>true);
  let clockSpy: ReturnType<typeof vi.spyOn> | undefined;
  if(mode === "normal")r.auditOnce(()=>{clockSpy=vi.spyOn(HubCore.prototype,"now").mockImplementation(()=>{throw Error("clock callback after writer proof");});});
  if(interrupted){
    expect(()=>writer.directory!.commit(prepared.ref,actor,()=>true,rotation)).toThrow("simulated response lost");
    expect(writer.pending()).toBe(true); rotation.discard(); writer.recover();
  } else {
    let result: ReturnType<NonNullable<typeof writer.directory>["commit"]> | undefined;
    expect(()=>{result=writer.directory!.commit(prepared.ref,actor,()=>true,rotation);}).not.toThrow();
    expect(result).toMatchObject({directoryEpoch:1});
  }
  clockSpy?.mockRestore();
  expect(writer.pending()).toBe(false);
  expect(verifyHubInitialization({home:r.home,hubId:r.hubId,memberOrigin:hub.memberOrigin,planDigest:hubPlanDigest(hub)}).planDigest).toBe(hubPlanDigest(hub));
  expect(r.db.prepare("SELECT state,directory_epoch FROM hub_sessions ORDER BY rowid").all()).toEqual([
    {state:"ended",directory_epoch:0},{state:"active",directory_epoch:1}]);
  const operationId=r.decision.inspect().operationId!;
  if(mode === "compensated") {
    const compensation=writer.directory!.compensate(operationId,()=>true);
    expect(compensation.directoryEpoch).toBe(2);
    expect(r.decision.operation(compensation.receiptId).browserSession).toBeUndefined();
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_sessions WHERE state='active'").get()).toEqual({n:0});
    await r.remount(); expect(()=>r.sessions.completeDirectoryRotation(rotation,operationId)).toThrow(); return;
  }
  await r.remount();
  if(interrupted)expect(()=>r.sessions.completeDirectoryRotation(rotation,operationId)).toThrow();
  else{
    const next=r.sessions.completeDirectoryRotation(rotation,operationId);
    expect((await r.call(r.browser(next.token),"GET","/hub/v1/session")).json.signedIn).toBe(true);
  }
});

it("requires the durable operation's exact browser-transition binding before releasing the response token", async () => {
  const {r,input,rotation}=await setup(); r.decision.decide(input,()=>{},rotation); await r.remount();
  const row=r.db.prepare("SELECT body FROM hub_settings_operations WHERE id=?").get(input.id) as {body:string};
  const body=JSON.parse(row.body); body.browserSession.sessionId="replacement";
  r.db.prepare("UPDATE hub_settings_operations SET body=? WHERE id=?").run(JSON.stringify(body),input.id);
  expect(()=>r.sessions.completeDirectoryRotation(rotation,input.id)).toThrow();
});

it("does not prepare a handoff from a different token or an unconfigured person", async () => {
  const {r,browser,actor}=await setup(), other=await r.signIn();
  expect(()=>r.sessions.prepareDirectoryRotation(r.token(other),actor)).toThrow();
  expect(()=>r.sessions.prepareDirectoryRotation(r.token(browser),{...actor,person:{...actor.person,objectId:randomUUID()}})).toThrow();
});

it("consumes a valid handle even when the first source proof refuses before the floor advances", async () => {
  const {r,input,rotation}=await setup();
  expect(()=>r.decision.decide(input,()=>{throw Error("source expired");},rotation)).toThrow("source expired");
  expect(readHubSessionEpoch(r.db)).toBe(0); expect(r.decision.inspect().operationId).toBeNull();
  expect(()=>r.decision.decide(input,()=>{},rotation)).toThrow();
  expect(r.db.prepare("SELECT COUNT(*) n FROM hub_settings_operations").get()).toEqual({n:0});
});
