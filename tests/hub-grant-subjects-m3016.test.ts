/** Shared owner grants: actual HTTP/session/SQLite with inert AD GUID facts. No account or live directory. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import type { PersonKey } from "../src/hub/types.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubPolicyService, readMessage } from "../src/hub/policy.js";
import { buildHubGroupImpact } from "../src/hub/group-policy/admin-impact.js";
import { initialGroupPolicy } from "../src/hub/group-policy/model.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { buttonsDigest } from "../src/hub/buttons-model.js";
import { messageContentDigest } from "../src/hub/identity.js";
import { grantOf, grantApplies, exposureOf } from "../src/hub/catalog.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); vi.restoreAllMocks(); });
const held = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

async function world() {
  let at = Date.now();
  const r = await s3bRig({ now: () => at }); rigs.push(r);
  const owner = r.addPerson("olivia"), recipient = r.addPerson("alex", "Alex Chen"), stranger = r.addPerson("outsider");
  const group = { realm: "corp", objectId: randomUUID() }, dn = "CN=Engineering,DC=example,DC=test";
  let memberships: readonly string[] | null = [group.objectId];
  Object.assign(r.directory, {
    groupPolicy: "ad-direct-guid",
    resolvePolicyGroup: vi.fn(async (input: string) => input === dn ? { ok: true, group: { key: group, dn } } : { ok: false, reason: "not-found" }),
    readPolicyGroups: vi.fn(async (key: PersonKey) => memberships === null ? { kind: "unknown" }
      : { kind: "complete", person: { ...key }, groups: key.objectId === recipient.objectId ? [...memberships] : [], observedAt: at }),
    searchPolicyGroups: vi.fn(async () => ({ ok: true, groups: [{ objectId: group.objectId, cn: "Engineering", dn }], truncated: false })),
    searchGrantPeople: vi.fn(async () => ({ ok: true, people: [{ person: recipient, login: "alex", displayName: "Alex Chen" }], truncated: false })),
    lookupForGrant: vi.fn(async (login: string) => login === "alex" ? { ok: true, person: { key: recipient, login, dn: "private", groups: [] } } : { ok: false, reason: "not-found" }),
  });
  groupPolicyMigration(r.hubId, "corp", "directory-v1").up(r.db);
  const policy = createHubGroupPolicyStore({ db: r.db, hubId: r.hubId, realm: "corp", generation: "directory-v1", directory: r.directory,
    audit: { appendInTransaction() {} } as never, current: () => true, now: () => at });
  (r.httpDeps as any).grantDirectory = { policy: () => policy, binding: () => ({ kind: "ready" }) };
  const browser = await r.signIn("olivia"), other = await r.signIn("outsider"), asker = await r.signIn("alex");
  const exposureId = randomUUID(), link = r.link(randomUUID(), owner);
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner,
    displayName: "Shared agent", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const grant = (extra: Record<string, unknown> = {}, b = browser) => r.call(b, "POST", "/hub/v1/grants", {
    exposureId, exposureRevision: 1, days: 90, subject: { kind: "group", group, dn }, ...extra,
  });
  const search = (kind: "person" | "group", b = browser, extra: Record<string, unknown> = {}) => r.call(b, "POST", `/hub/v1/exposures/${exposureId}/grant-subjects/search`, { exposureRevision: 1, kind, q: "Al", ...extra });
  return { r, owner, recipient, stranger, group, dn, browser, other, asker, exposureId, link, grant, search,
    setMembership: (value: readonly string[] | null) => { memberships = value; }, advance: (ms: number) => { at += ms; }, now: () => at };
}

describe("M-3016 owner person/group grants", () => {
  it("creates a GUID-bound group grant, without materializing its members as personal grants", async () => {
    const w = await world(), out = await w.grant();
    expect(out.status).toBe(200);
    expect(out.json.grant).toMatchObject({ owner: w.owner, approvedBy: w.owner, subject: { kind: "group", group: w.group },
      exposureId: w.exposureId, exposureRevision: 1, expiresAt: w.now() + 90 * 86_400_000 });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 1 });
  });
  it("caps all new person grants at90d while a90d control still works", async () => {
    const w = await world();
    const make = (days: number) => w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "alex", days });
    expect((await make(91)).status).toBe(400);
    expect((await make(90)).status).toBe(200);
  });
  it("preserves the recorded expiry of an existing longer personal grant", async () => {
    const w = await world(), out = await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "alex", days: 7 });
    expect(out.status).toBe(200);
    const expiry = w.now() + 365 * 86_400_000;
    w.r.db.prepare("UPDATE hub_grants SET expires_at=? WHERE id=?").run(expiry, out.json.grant.id);
    const view = await w.r.call(w.browser, "GET", "/hub/v1/exposures");
    expect(view.status).toBe(200); expect(view.json.mine[0].grants[0].expiresAt).toBe(expiry);
  });
  it.each(["person", "group"] as const)("offers bounded %s suggestions only for the exact owner and exposure revision", async kind => {
    const w = await world(), out = await w.search(kind);
    expect(out.status).toBe(200); expect(out.json.ok).toBe(true);
    expect(kind === "person" ? out.json.people[0].person : out.json.groups[0].objectId).toEqual(kind === "person" ? w.recipient : w.group.objectId);
    expect((await w.search(kind, w.other)).status).toBe(404);
    expect((await w.search(kind, w.browser, { exposureRevision: 2 })).status).toBe(409);
  });
  it("selection binds the selected person key instead of silently retargeting a reused login", async () => {
    const w = await world();
    const out = await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "alex", days: 7,
      subject: { kind: "person", person: { ...w.recipient, objectId: randomUUID() } } });
    expect(out.status).toBe(409); expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });
  it("checks live direct membership for catalog, opening, history and questions without revoking the shared group grant", async () => {
    const w = await world(), grant = await w.grant(); expect(grant.status).toBe(200);
    const view = () => w.r.call(w.asker, "GET", "/hub/v1/exposures");
    expect((await view()).json.askable.map((x: any) => x.grant.id)).toEqual([grant.json.grant.id]);
    const room = await w.r.call(w.asker, "POST", "/hub/v1/rooms", { exposureId: w.exposureId, grantId: grant.json.grant.id }); expect(room.status).toBe(200);
    w.setMembership([]);
    expect((await view()).json.askable).toEqual([]);
    expect((await w.r.call(w.asker, "GET", `/hub/v1/rooms/${room.json.room.id}/messages`)).status).toBe(403);
    expect((await w.r.call(w.asker, "POST", `/hub/v1/rooms/${room.json.room.id}/messages`, { idempotencyKey: randomUUID(), text: "must not send" })).status).toBe(403);
    expect(w.r.db.prepare("SELECT state FROM hub_grants WHERE id=?").get(grant.json.grant.id)).toEqual({ state: "active" });
    w.setMembership([w.group.objectId]);
    expect((await w.r.call(w.asker, "GET", `/hub/v1/rooms/${room.json.room.id}/messages`)).status).toBe(200);
  });
  it("unknown membership is unavailable, never removal or an empty authoritative allow list", async () => {
    const w = await world(), grant = await w.grant(); expect(grant.status).toBe(200); w.setMembership(null);
    const out = await w.r.call(w.asker, "GET", "/hub/v1/exposures");
    expect(out.status).toBe(503); expect(out.json.code).toBe("unavailable");
    expect(w.r.db.prepare("SELECT state,revision FROM hub_grants WHERE id=?").get(grant.json.grant.id)).toEqual({ state: "active", revision: 1 });
  });
  it.each(["session", "owner", "revision", "group"] as const)("fences a held group resolve after %s changes", async change => {
    const w = await world(), entered = held<void>(), gate = held<any>();
    w.r.directory.resolvePolicyGroup = async () => { entered.resolve(); return gate.promise; };
    const pending = w.grant(); await entered.promise;
    if (change === "session") await w.r.call(w.browser, "DELETE", "/hub/v1/session");
    else if (change === "owner") w.r.db.prepare("UPDATE hub_exposures SET owner=? WHERE id=?").run(`${w.stranger.realm}/${w.stranger.objectId}`, w.exposureId);
    else if (change === "revision") w.r.db.prepare("UPDATE hub_exposures SET revision=2 WHERE id=?").run(w.exposureId);
    gate.resolve({ ok: true, group: { key: change === "group" ? { ...w.group, objectId: randomUUID() } : w.group, dn: w.dn } });
    expect((await pending).status).toBe(change === "session" ? 401 : change === "owner" ? 404 : 409);
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });
  it("accepted durable phases survive browser sign-out, but use a fresh bounded grant proof", async () => {
    const w = await world(), grant = await w.grant(); expect(grant.status).toBe(200);
    const room = await w.r.call(w.asker, "POST", "/hub/v1/rooms", { exposureId: w.exposureId, grantId: grant.json.grant.id });
    const question = await w.r.call(w.asker, "POST", `/hub/v1/rooms/${room.json.room.id}/messages`, { idempotencyKey: randomUUID(), text: "recorded fixture" }); expect(question.status).toBe(200);
    await w.r.call(w.asker, "DELETE", "/hub/v1/session");
    const core = new HubCore(w.r.httpDeps, w.r.sql), policy = new HubPolicyService(core), msg = readMessage(w.r.db, question.json.receipt.messageId)!;
    const proof = await policy.operation(msg, w.link); proof.assertCurrent();
    w.advance(5_000); expect(() => proof.assertCurrent()).toThrow();
    const fresh = await policy.operation(msg, w.link); fresh.assertCurrent();
    w.setMembership([]); await expect(policy.operation(msg, w.link)).rejects.toThrow();
  });
  it.each(["person", "group"].flatMap(kind => ["within-window", "expired", "rollback"].map(clock => ({ kind, clock }))))(
    "permanently retires a $kind action proof after $clock clock regression, while a fresh proof works", async ({ kind, clock }) => {
      const w = await world(), out = kind === "group" ? await w.grant()
        : await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "alex", days: 7 });
      expect(out.status).toBe(200);
      const core = new HubCore(w.r.httpDeps, w.r.sql), context = { requestId: randomUUID(), current: () => true };
      const grant = grantOf(w.r.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(out.json.grant.id) as never);
      const proof = await core.grantAccess([grant.id], w.recipient, context);
      expect(proof.allows(grant, w.recipient)).toBe(true);
      if (clock === "within-window") {
        w.advance(3_000); proof.assertCurrent(); w.advance(-2_000);
      } else if (clock === "expired") {
        w.advance(5_000); expect(() => proof.assertCurrent()).toThrow();
        // Expiry retires the action permit, not its separate data-only selection fence.
        expect(() => proof.assertSelectionCurrent()).not.toThrow(); w.advance(-4_999);
      } else { w.advance(-1); expect(() => proof.assertCurrent()).toThrow(); w.advance(2); }
      expect(() => proof.assertCurrent()).toThrow();
      w.advance(3_000); expect(() => proof.allows(grant, w.recipient)).toThrow();
      expect(() => proof.assertSelectionCurrent()).toThrow();
      const reads = vi.mocked(w.r.directory.readPolicyGroups!).mock.calls.length;
      const fresh = await core.grantAccess([grant.id], w.recipient, context);
      expect(fresh.allows(grant, w.recipient)).toBe(true); fresh.assertCurrent();
      expect(vi.mocked(w.r.directory.readPolicyGroups!).mock.calls.length).toBe(reads + (kind === "group" ? 1 : 0));
    });
  it("a group owner grant never bypasses the Hub's operational ask gate", async () => {
    const w = await world(), grant = await w.grant(); expect(grant.status).toBe(200);
    w.r.httpDeps.groups = { asker: async () => { throw new HubProtocolError("denied"); }, check: async () => ({ source: "legacy", assertCurrent() {} }) } as never;
    const out = await w.r.call(w.asker, "GET", "/hub/v1/exposures"); expect(out.status).toBe(200); expect(out.json.askable).toEqual([]);
    expect((await w.r.call(w.asker, "POST", "/hub/v1/rooms", { exposureId: w.exposureId, grantId: grant.json.grant.id })).status).toBe(403);
  });
  it.each([true, false])("impact evaluates known-person group grants with fresh facts; complete=%s", async complete => {
    const w = await world(), before = initialGroupPolicy("corp", "directory-v1");
    const out = buildHubGroupImpact({ before, next: { ...before, state: "enabled", denies: [{ person: w.recipient, deny: ["ask_agents"] }] }, administrator: w.r.admin,
      people: [{ key: w.recipient, name: "Alex", login: "alex", hasAskGrant: false, askGroups: [w.group] }], resources: [],
      facts: new Map([[`${w.recipient.realm}/${w.recipient.objectId}`, complete
        ? { kind: "complete" as const, person: w.recipient, groups: [w.group.objectId], observedAt: w.now() } : { kind: "unknown" as const }]]) });
    const id = `${w.recipient.realm}/${w.recipient.objectId}`;
    if (complete) expect(out.impact.losingActions.find(p => p.personId === id)?.capabilities).toContain("ask_agents");
    else { expect(out.impact.losingActions.some(p => p.personId === id)).toBe(false); expect(out.impact.held.find(p => p.personId === id)?.capabilities).toContain("ask_agents"); }
  });
  it("shows one askable agent for overlapping grants, retaining its still-authorized conversation", async () => {
    const w = await world(), first = await w.grant(); expect(first.status).toBe(200);
    const room = await w.r.call(w.asker, "POST", "/hub/v1/rooms", { exposureId: w.exposureId, grantId: first.json.grant.id }); expect(room.status).toBe(200);
    const personal = await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "alex", days: 90 }); expect(personal.status).toBe(200);
    expect((await w.r.call(w.asker, "GET", "/hub/v1/exposures")).json.askable.map((x: any) => x.grant.id)).toEqual([first.json.grant.id]);
    w.setMembership([]);
    expect((await w.r.call(w.asker, "GET", "/hub/v1/exposures")).json.askable.map((x: any) => x.grant.id)).toEqual([personal.json.grant.id]);
    expect((await w.r.call(w.asker, "GET", `/hub/v1/rooms/${room.json.room.id}/messages`)).status).toBe(403);
  });
  it.each(["asker", "stale", "future"])("rejects %s membership observations without changing grants", async mode => {
    const w = await world(), g = await w.grant(); expect(g.status).toBe(200);
    w.r.directory.readPolicyGroups = async () => ({ kind: "complete", person: mode === "asker" ? w.owner : w.recipient,
      groups: [w.group.objectId], observedAt: w.now() + (mode === "stale" ? -1 : mode === "future" ? 1 : 0) });
    const out = await w.r.call(w.asker, "GET", "/hub/v1/exposures"); expect(out.status).toBe(503);
    expect(w.r.db.prepare("SELECT state,revision FROM hub_grants WHERE id=?").get(g.json.grant.id)).toEqual({ state: "active", revision: 1 });
  });
  it("bounds feedback per real session and rejects malformed/CSRF/frozen reads before directory work", async () => {
    const w = await world(), lookup = vi.mocked(w.r.directory.searchGrantPeople!);
    for (const q of ["a", "a".repeat(65), " a", "a\u0000b"]) expect((await w.search("person", w.browser, { q })).status).toBe(400);
    expect((await w.r.call(w.browser,"POST",`/hub/v1/exposures/${w.exposureId}/grant-subjects/search`,{exposureRevision:1,kind:"person",q:"Al"},{"X-AgEnD-Hub-CSRF":"wrong"})).status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    for (let i=0;i<30;i++) expect((await w.search("person")).json.ok).toBe(true);
    const limited = await w.search("person"); expect(limited.status).toBe(429); expect(limited.json).toEqual({ ok:false, reason:"limited" }); expect(lookup).toHaveBeenCalledTimes(30);
    w.advance(60_000); expect((await w.search("person")).json.ok).toBe(true);
    w.r.db.prepare("UPDATE hub_exposures SET state='frozen' WHERE id=?").run(w.exposureId);
    expect((await w.search("person")).status).toBe(403); expect(lookup).toHaveBeenCalledTimes(31);
  });
  it.each(["session", "owner", "revision", "method"])("does not disclose a held search after %s changes", async mode => {
    const w = await world(), entered = held<void>(), gate = held<any>();
    w.r.directory.searchGrantPeople = async () => { entered.resolve(); return gate.promise; };
    const pending = w.search("person"); await entered.promise;
    try {
      if (mode === "session") await w.r.call(w.browser,"DELETE","/hub/v1/session");
      else if (mode === "owner") w.r.db.prepare("UPDATE hub_exposures SET owner=? WHERE id=?").run(`${w.stranger.realm}/${w.stranger.objectId}`,w.exposureId);
      else if (mode === "revision") w.r.db.prepare("UPDATE hub_exposures SET revision=2 WHERE id=?").run(w.exposureId);
      else w.r.directory.searchGrantPeople = async () => ({ok:true,people:[],truncated:false});
    } finally { gate.resolve({ok:true,people:[{person:w.recipient,login:"alex",displayName:"Alex Chen"}],truncated:false}); }
    const out = await pending; expect(out.status).not.toBe(200); expect(out.text).not.toContain("Alex Chen");
  });
  it("the owner suggestion route shares the four-physical-read pool, without opening a fifth operation", async () => {
    const w = await world(), gate = held<void>(); let entered = 0;
    w.r.directory.searchGrantPeople = async () => { entered++; await gate.promise; return {ok:true,people:[],truncated:false}; };
    const running = Array.from({length:4},()=>w.search("person"));
    let fifth: ReturnType<typeof w.search> | undefined;
    try {
      await vi.waitFor(()=>expect(entered).toBe(4)); fifth=w.search("person");
      const out = await Promise.race([fifth,new Promise<null>(r=>setTimeout(()=>r(null),100))]);
      expect(out?.status).toBe(429); expect(entered).toBe(4);
    } finally { gate.resolve(); await Promise.all([...running,...(fifth?[fifth]:[])]); }
  });

  it("group identity alone is no permit, and an operation proof binds rows, time, caller and message", async () => {
    const w=await world(), out=await w.grant(); expect(out.status).toBe(200);
    const core=new HubCore(w.r.httpDeps,w.r.sql), grant=grantOf(w.r.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(out.json.grant.id) as never), exposure=exposureOf(w.r.db.prepare("SELECT * FROM hub_exposures WHERE id=?").get(w.exposureId) as never);
    expect(grantApplies(grant,exposure,w.recipient,w.now())).toBe(false);
    let current=true; const context={requestId:randomUUID(),current:()=>current};
    const proof=await core.grantAccess([grant.id],w.recipient,context);
    expect(proof.allows(grant,w.stranger)).toBe(false); expect(proof.allows(grant,w.recipient)).toBe(true);
    current=false; expect(()=>proof.assertCurrent()).toThrow(); current=true;
    w.advance(-1); expect(()=>proof.assertCurrent()).toThrow(); w.advance(1);
    w.r.db.prepare("UPDATE hub_grants SET revision=revision+1 WHERE id=?").run(grant.id); expect(()=>proof.assertCurrent()).toThrow();
  });
  it("durable proof refuses an altered asker or a replaced member link", async () => {
    const w=await world(), g=await w.grant(); expect(g.status).toBe(200);
    const room=await w.r.call(w.asker,"POST","/hub/v1/rooms",{exposureId:w.exposureId,grantId:g.json.grant.id});
    const sent=await w.r.call(w.asker,"POST",`/hub/v1/rooms/${room.json.room.id}/messages`,{idempotencyKey:randomUUID(),text:"persisted actor"}); expect(sent.status).toBe(200);
    const policy=new HubPolicyService(new HubCore(w.r.httpDeps,w.r.sql)), msg=readMessage(w.r.db,sent.json.receipt.messageId)!;
    await expect(policy.operation({...msg,asker:`${w.owner.realm}/${w.owner.objectId}`},w.link)).rejects.toThrow();
    const proof=await policy.operation(msg,w.link); w.link.alive=false; expect(()=>proof.assertCurrent()).toThrow();
  });

  it("without a chat, an overlapping grant uses the longer valid window", async () => {
    const w=await world(), group=await w.grant({days:7});expect(group.status).toBe(200);
    const personal=await w.r.call(w.browser,"POST","/hub/v1/grants",{exposureId:w.exposureId,exposureRevision:1,login:"alex",days:90});expect(personal.status).toBe(200);
    expect((await w.r.call(w.asker,"GET","/hub/v1/exposures")).json.askable.map((x:any)=>x.grant.id)).toEqual([personal.json.grant.id]);
  });

  it.each([false,true])("group grants flow through answer release and button/poll continuation; poll=%s", async poll => {
    const w=await world(), g=await w.grant();expect(g.status).toBe(200);(w.link.features as Set<string>).add("buttons-v1");
    const opened=await w.r.call(w.asker,"POST","/hub/v1/rooms",{exposureId:w.exposureId,grantId:g.json.grant.id}), roomId=opened.json.room.id;
    const sent=await w.r.call(w.asker,"POST",`/hub/v1/rooms/${roomId}/messages`,{idempotencyKey:randomUUID(),text:"group-owned continuation"});expect(sent.status).toBe(200);
    const messageId=sent.json.receipt.messageId,buttons={id:randomUUID().replaceAll("-",""),labels:["Yes","No"],...(poll?{poll:{seconds:10,multi:false,reveal:"close" as const,showVoters:true,question:"Pick"}}:{})};
    const text="Choose",answerId=randomUUID(),contentDigest=messageContentDigest("answer",text,{buttonsDigest:buttonsDigest(buttons)});
    const auth=await w.r.http.receive(w.r.frame("authorize.request",{messageId,operationId:randomUUID(),exposureRevision:1,phase:"release-answer",answer:{answerId,contentDigest}},w.link) as never,w.link) as any;
    expect(auth.payload.ok).toBe(true);
    await w.r.http.receive(w.r.frame("answer",{messageId,answerId,text,contentDigest,buttons,releaseLease:auth.payload.lease},w.link) as never,w.link);
    w.setMembership([]); const click=()=>w.r.call(w.asker,"POST",`/hub/v1/rooms/${roomId}/buttons`,{setId:buttons.id,idempotencyKey:randomUUID(),...(poll?{options:[0]}:{index:0})});
    expect((await click()).status).toBe(403);expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_messages WHERE room_id=?").get(roomId)).toEqual({n:1});
    w.setMembership([w.group.objectId]);expect((await click()).status).toBe(200);expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_messages WHERE room_id=?").get(roomId)).toEqual({n:2});
  });
  it("group grants retain quota only in their currently authorized room projections", async () => {
    const w=await world(), g=await w.grant();expect(g.status).toBe(200);for(const f of ["welcome-caps-v1","quota-band-v1"])(w.link.features as Set<string>).add(f);
    await w.r.http.receive(w.r.frame("exposure.quota",{exposureId:w.exposureId,quota:{band:"near_limit"}},w.link) as never,w.link);
    const opened=await w.r.call(w.asker,"POST","/hub/v1/rooms",{exposureId:w.exposureId,grantId:g.json.grant.id});expect(opened.status).toBe(200);expect(opened.json.room.quota).toEqual({band:"near_limit"});
    expect((await w.r.call(w.asker,"GET","/hub/v1/rooms")).json.rooms[0].quota).toEqual({band:"near_limit"});
    w.setMembership([]);const held=await w.r.call(w.asker,"GET","/hub/v1/rooms");expect(held.status).toBe(200);expect(held.json.rooms[0]).not.toHaveProperty("quota");expect(held.json.rooms[0].state).toBe("held");
  });

  it.each([false,true])("catalog refreshes an aged subject observation after slow operational reads; memberLeft=%s", async left => {
    const w=await world(), grant=await w.grant();expect(grant.status).toBe(200);
    // Inert operational-policy boundary; production grant reads, HTTP/session, DB and membership remain real.
    vi.spyOn(HubCore.prototype,"groupExposure").mockImplementation(async()=>{w.advance(6_000);if(left)w.setMembership([]);return {assertCurrent(){}};});
    const out=await w.r.call(w.asker,"GET","/hub/v1/exposures");expect(out.status).toBe(200);
    expect(out.json.askable.map((x:any)=>x.grant.id)).toEqual(left?[]:[grant.json.grant.id]);
    expect(vi.mocked(w.r.directory.readPolicyGroups!)).toHaveBeenCalledTimes(2);
  });
  it("room-list subject proof is acquired after slow operational reads", async()=>{
    const w=await world(), g=await w.grant();expect(g.status).toBe(200);
    const room=await w.r.call(w.asker,"POST","/hub/v1/rooms",{exposureId:w.exposureId,grantId:g.json.grant.id});expect(room.status).toBe(200);
    vi.spyOn(HubCore.prototype,"groupExposure").mockImplementation(async()=>{w.advance(6_000);return {assertCurrent(){}};});
    const out=await w.r.call(w.asker,"GET","/hub/v1/rooms");expect(out.status).toBe(200);expect(out.json.rooms[0].state).toBe("active");
  });

  it("an aged catalog selection cannot revive under a replacement directory method", async()=>{
    const w=await world(), g=await w.grant();expect(g.status).toBe(200);const read=w.r.directory.readPolicyGroups!;
    vi.spyOn(HubCore.prototype,"groupExposure").mockImplementation(async()=>{w.advance(6_000);w.r.directory.readPolicyGroups=key=>read(key);return {assertCurrent(){}};});
    const out=await w.r.call(w.asker,"GET","/hub/v1/exposures");expect(out.status).toBe(503);expect(w.r.db.prepare("SELECT state FROM hub_grants WHERE id=?").get(g.json.grant.id)).toEqual({state:"active"});
  });

});
