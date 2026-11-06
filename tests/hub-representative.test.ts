/**
 * Hub P1 representative adapter (docs/design/hub-representative-agent.md, #3145) over the real S1 journal and admission:
 * the agent tuple, the consent/lifecycle binding, beforeInput's begin lease, the report_result correlation (exact,
 * consumed once), the frozen answer under its release lease, evidence/receipts, and never a resend.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { HubMemberJournal, migrateHubMemberJournal } from "../src/hub/member-journal.js";
import { HubMemberAdmissionAdapter } from "../src/hub/admission.js";
import { signAsker, sha256, issuerKeyId, operationDigest } from "../src/hub/identity.js";
import { HubRepresentativeExecution, HUB_REPORT_TARGET, agentPolicyDigest, isAgentTuple, migrateHubRepresentative, type HubRepresentativeDelivery } from "../src/hub/representative.js";
import type { HubAuthorizationRequest, HubQuestion } from "../src/hub/types.js";
import type { HubMemberProfile } from "../src/hub/profile.js";
import type { HubLocalExposure } from "../src/hub/execution/service.js";

const dbs: Database.Database[] = [];
const reps: HubRepresentativeExecution[] = [];
afterEach(async () => {
  for (const r of reps.splice(0)) await r.close();
  dbs.splice(0).forEach((db) => db.close());
});
const tick = () => new Promise((r) => setImmediate(r));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await tick();
  expect(check(), label).toBe(true);
}

function fixture(opts: { legacy?: boolean; handOff?: boolean } = {}) {
  const db = new Database(":memory:");
  dbs.push(db);
  migrateHubMemberJournal(db);
  migrateHubRepresentative(db);
  const keys = generateKeyPairSync("ed25519");
  const owner = { realm: "directory", objectId: randomUUID() };
  const now = 1_800_000_000_000;
  let live = true, floor = 0, token: string | null = "token-1", handOff = opts.handOff ?? true;
  const profile: HubMemberProfile = { v: 1, hub: { hubId: randomUUID(), memberOrigin: "https://hub.test", webOrigin: "https://web.test", spkiSha256: "a".repeat(64), issuerPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }, owner, fleetId: randomUUID(), credential: "a".repeat(64), certificatePem: "unused", issuerKeyId: issuerKeyId(keys.publicKey) };
  const local: HubLocalExposure = opts.legacy
    ? { agent: "rep", providerId: "claude", consentId: randomUUID(), generation: 1, exposure: { id: randomUUID(), fleetId: profile.fleetId, owner, displayName: "Rep", revision: 1, state: "published", dataViewId: "handbook", allowedTools: ["documents.read"], policyDigest: sha256("view") } }
    : { agent: "rep", providerId: "agent", consentId: randomUUID(), generation: 1, exposure: { id: randomUUID(), fleetId: profile.fleetId, owner, displayName: "Rep", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: agentPolicyDigest("rep") } };
  let current: HubLocalExposure | null = local;
  const question = (text = "What is in the folder?"): HubQuestion => ({ text, identity: signAsker({ v: 1, issuer: profile.hub.hubId, issuerKeyId: profile.issuerKeyId, messageId: randomUUID(), asker: { realm: "directory", objectId: randomUUID() }, owner, destinationFleetId: profile.fleetId, exposureId: local.exposure.id, roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1, exposureRevision: 1, revocationVersion: 1, contentDigest: sha256(text), issuedAt: now, expiresAt: now + 120_000, nonce: randomBytes(32).toString("hex") }, keys.privateKey) });
  const lease = (request: HubAuthorizationRequest) => ({ decisionId: randomUUID(), messageId: request.messageId, operationId: request.operationId, phase: request.phase, operationDigest: operationDigest(request), exposureRevision: request.exposureRevision, revocationVersion: 1, linkEpoch: 1, expiresAt: now + 5_000 });
  const authorize = vi.fn(async (r: HubAuthorizationRequest) => lease(r));
  const frames: any[] = [];
  const link = {
    linkEpoch: 1,
    current: () => true,
    exchange: vi.fn(async (frame: any) => {
      frames.push(frame);
      if (frame.type === "answer" && exchangeMode === "reject") throw new Error("link dropped");
      if (frame.type === "answer" && exchangeMode === "bad-ack") return { v: 1, type: "receipt", requestId: frame.requestId, linkEpoch: 1, payload: { messageId: frame.payload.messageId, contentDigest: "x".repeat(64), stage: "consumed", sequence: 1, at: now } };
      if (frame.type === "answer") return { v: 1, type: "receipt", requestId: frame.requestId, linkEpoch: 1, payload: { messageId: frame.payload.messageId, contentDigest: "x".repeat(64), stage: "answered", sequence: 1, at: now } };
      return { v: 1, type: "receipt", requestId: frame.requestId, linkEpoch: 1, payload: frame.payload };
    }),
  };
  let online: typeof link | null = link;
  const deliveries: HubRepresentativeDelivery[] = [];
  const handed: boolean[] = [];
  const audit: string[] = [];
  let journal!: HubMemberJournal;
  let onDeliver: (() => void) | null = null;
  let failAudit: string | null = null;
  let exchangeMode: "ok" | "reject" | "bad-ack" = "ok";
  const rep = new HubRepresentativeExecution({
    db,
    get journal() { return journal; },
    binding: () => ({ fleetId: profile.fleetId, owner, linkEpoch: 1, revocationVersion: 1, current: () => live }),
    localExposure: () => current,
    agentToken: () => token,
    authorize,
    link: () => online,
    deliver: async (input) => {
      deliveries.push(input);
      onDeliver?.(); // e.g. something changes while the question waits for the agent's idle gate
      const ok = await input.beforeInput();
      handed.push(ok && handOff);
      return ok && handOff;
    },
    audit: (event) => {
      if (failAudit === event.action) throw new Error("audit storage failed");
      audit.push(event.action + (event.reasonCode ? `:${event.reasonCode}` : ""));
    },
    attentionChanged: () => {},
    log: () => {},
    now: () => now,
  } as ConstructorParameters<typeof HubRepresentativeExecution>[0]);
  reps.push(rep);
  const options = { hubId: profile.hub.hubId, encryptionKey: randomBytes(32), floor: { read: () => floor, raise: (n: number) => { floor = n; } }, outbox: rep.restrictedOutbox(), now: () => now };
  journal = new HubMemberJournal(db, options);
  journal.initialize();
  rep.recover();
  const admission = new HubMemberAdmissionAdapter({ journal, transport: { start: async () => {}, send: async () => {}, authorize, close: async () => {} },
    binding: () => ({ profile, linkEpoch: 1, revocationVersion: 1, current: () => live }), exposure: () => current?.exposure ?? null, fenceLocal: (id) => rep.fence(id), hold: () => {}, now: () => now });
  /** S3c's atomic publish asks readinessCandidate inside its transaction: that records the agent's lifecycle token. */
  const publish = () => db.transaction(() => rep.readinessCandidate({ ...local, exposure: { ...local.exposure, state: "withdrawn" } })).immediate();
  const stage = (id: string) => (JSON.parse((db.prepare("SELECT value FROM hub_member_messages WHERE message_id=?").get(id) as { value: string }).value) as { stage: string }).stage;
  const state = (id: string) => (db.prepare("SELECT state, reason FROM hub_representative_questions WHERE message_id=?").get(id) as { state: string; reason: string | null } | undefined);
  return { db, rep, admission, journal, question, publish, authorize, deliveries, handed, frames, audit, stage, state, local,
    setToken: (t: string | null) => { token = t; }, withdraw: () => { current = null; }, stop: () => { live = false; }, offline: () => { online = null; }, online: () => { online = link; },
    setHandOff: (v: boolean) => { handOff = v; }, whileWaiting: (fn: () => void) => { onDeliver = fn; },
    failAuditOf: (action: string | null) => { failAudit = action; }, exchange: (mode: "ok" | "reject" | "bad-ack") => { exchangeMode = mode; } };
}

describe("Hub representative adapter (#3145)", () => {
  it("the agent tuple is exact: all four fields, the digest over {mode:'agent', agent}", () => {
    const f = fixture();
    expect(isAgentTuple(f.local)).toBe(true);
    for (const change of [{ providerId: "claude" }, { exposure: { ...f.local.exposure, dataViewId: "handbook" } }, { exposure: { ...f.local.exposure, allowedTools: ["documents.read"] } },
      { exposure: { ...f.local.exposure, policyDigest: agentPolicyDigest("other") } }, { agent: "other" }]) {
      expect(isAgentTuple({ ...f.local, ...change } as HubLocalExposure), JSON.stringify(change)).toBe(false);
    }
  });

  it("publish → question → ordinary delivery with a Hub correlation id → report_result → frozen answer under its release lease", async () => {
    const f = fixture();
    f.publish();
    const q = f.question();
    const receipt = await f.admission.admit(q);
    expect(receipt.stage).toBe("queued");
    await until(() => f.deliveries.length === 1 && f.handed.length === 1, "delivered once");
    const d = f.deliveries[0]!;
    expect(d.agent).toBe("rep");
    expect(d.correlationId).toMatch(/^hub-[0-9a-f-]{36}$/);
    expect(d.text).toContain("What is in the folder?");
    expect(d.text).toContain(`report_result to ${HUB_REPORT_TARGET} with correlation_id ${d.correlationId}`);
    expect(d.text).not.toMatch(/\[user:/); // never a fleet person's authority header
    // beforeInput took exactly the begin lease and spent it on the input intent; queue acceptance is not delivery.
    expect(f.authorize.mock.calls.map(([r]) => r.phase)).toEqual(["admit", "begin"]);
    expect(f.stage(q.identity.messageId)).toBe("queued");
    expect(f.state(q.identity.messageId)!.state).toBe("delivered");

    // Wrong caller or unknown id: not a Hub answer (ordinary routing).
    expect(f.rep.report({ correlationId: d.correlationId, caller: "someone-else", text: "x" })).toBeNull();
    expect(f.rep.report({ correlationId: `hub-${randomUUID()}`, caller: "rep", text: "x" })).toBeNull();
    expect(f.rep.report({ correlationId: "cid-123", caller: "rep", text: "x" })).toBeNull();

    const outcome = await f.rep.report({ correlationId: d.correlationId, caller: "rep", text: "Three files." })!;
    expect(outcome).toEqual({ ok: true, message: expect.any(String) });
    // Consumed once: the same id again is no longer a Hub answer.
    expect(f.rep.report({ correlationId: d.correlationId, caller: "rep", text: "again" })).toBeNull();
    const release = f.authorize.mock.calls.map(([r]) => r).find((r) => r.phase === "release-answer")!;
    const answer = f.frames.find((x) => x.type === "answer")!;
    expect(answer.payload).toMatchObject({ messageId: q.identity.messageId, text: "Three files.", contentDigest: sha256("Three files.") });
    expect(release).toMatchObject({ answer: { answerId: answer.payload.answerId, contentDigest: sha256("Three files.") } });
    expect(answer.payload.releaseLease.operationId).toBe(release.operationId);
    expect(f.stage(q.identity.messageId)).toBe("answered");
    expect(f.state(q.identity.messageId)!.state).toBe("released");
    // The member's evidence went back as receipts, in order, each acknowledged.
    await until(() => f.journal.unackedReceipts({}).receipts.length === 0, "receipts acknowledged");
    // The journal keeps one current receipt per message: its latest stage goes back (delivered/consumed are behind it).
    expect(f.frames.filter((x) => x.type === "receipt").map((x) => x.payload.stage)).toEqual(["answered"]);
    expect(f.audit).toEqual(["representative.queued", "representative.handed", "representative.release", "representative.answered"]);
  });

  it("a legacy (container) tuple refuses delivery: readiness says so and admission never reaches the agent", async () => {
    const f = fixture({ legacy: true });
    expect(f.rep.readiness(f.local.exposure.id, 1)).toEqual({ ok: false, reasonCode: "policy-unavailable" });
    // Even with a consent/lifecycle record present (an alpha row from before P1), the tuple alone refuses it.
    f.db.prepare("INSERT INTO hub_representative_consents VALUES(?,?,?)").run(f.local.consentId, f.local.agent, "token-1");
    await expect(f.admission.admit(f.question())).rejects.toThrow();
    await tick();
    expect(f.deliveries).toEqual([]);
  });

  it("a replaced/retargeted agent: consent no longer matches — refused at admission, and stale before input", async () => {
    const f = fixture();
    f.publish();
    f.setToken("token-2"); // e.g. a new folder or backend after the owner published
    await expect(f.admission.admit(f.question())).rejects.toThrow();
    expect(f.rep.readiness(f.local.exposure.id, 1)).toMatchObject({ ok: true }); // capability only, never consent
    f.publish(); // explicit republish records the new token
    const q = f.question();
    // Admitted, then the agent changes while the question waits for its idle gate: no begin lease, no input.
    f.whileWaiting(() => f.setToken("token-3"));
    await f.admission.admit(q);
    await until(() => f.handed.length === 1, "hand-off attempted");
    expect(f.handed).toEqual([false]);
    expect(f.authorize.mock.calls.map(([r]) => r.phase)).not.toContain("begin");
    expect(f.state(q.identity.messageId)).toEqual({ state: "held", reason: "stale" });
    expect(f.stage(q.identity.messageId)).toBe("queued"); // nothing reached the agent
  });

  it("withdrawn after delivery: the report is refused, nothing is disclosed, the owner sees a hold", async () => {
    const f = fixture();
    f.publish();
    const q = f.question();
    await f.admission.admit(q);
    await until(() => f.handed.length === 1, "handed");
    f.withdraw();
    const outcome = await f.rep.report({ correlationId: f.deliveries[0]!.correlationId, caller: "rep", text: "secret" })!;
    expect(outcome.ok).toBe(false);
    expect(f.frames.some((x) => x.type === "answer")).toBe(false);
    expect(f.state(q.identity.messageId)).toEqual({ state: "held", reason: "uncertain" });
    expect(f.rep.attentionItems()).toMatchObject([{ kind: "hold", agent: "rep", messageId: q.identity.messageId }]);
  });

  it("withdrawn while the release lease is being granted: the frozen answer is never saved or sent", async () => {
    const f = fixture();
    f.publish();
    const q = f.question();
    await f.admission.admit(q);
    await until(() => f.handed.length === 1, "handed");
    const grant = f.authorize.getMockImplementation()!;
    f.authorize.mockImplementation(async (r) => { const lease = await grant(r); if (r.phase === "release-answer") f.withdraw(); return lease; });
    const outcome = await f.rep.report({ correlationId: f.deliveries[0]!.correlationId, caller: "rep", text: "secret" })!;
    expect(outcome.ok).toBe(false);
    expect(f.frames.some((x) => x.type === "answer")).toBe(false);
    expect(f.stage(q.identity.messageId)).toBe("consumed"); // the agent took it up; no answer was saved
  });

  it("a hand-off that fails after the input intent is uncertain and never resent; so is a pane that never took it", async () => {
    const f = fixture({ handOff: false });
    f.publish();
    const q = f.question();
    await f.admission.admit(q);
    await until(() => f.state(q.identity.messageId)?.state === "held", "held");
    expect(f.stage(q.identity.messageId)).toBe("uncertain");
    f.rep.pump();
    await tick();
    expect(f.deliveries).toHaveLength(1); // never a second hand-off

    const g = fixture();
    g.publish();
    const q2 = g.question();
    await g.admission.admit(q2);
    await until(() => g.handed.length === 1, "handed");
    g.rep.deliveryFailed(g.deliveries[0]!.correlationId, "someone-else"); // not its agent: ignored
    expect(g.state(q2.identity.messageId)!.state).toBe("delivered");
    g.rep.deliveryFailed(g.deliveries[0]!.correlationId, "rep");
    expect(g.state(q2.identity.messageId)).toEqual({ state: "held", reason: "uncertain" });
    expect(g.stage(q2.identity.messageId)).toBe("uncertain");
    expect(g.rep.report({ correlationId: g.deliveries[0]!.correlationId, caller: "rep", text: "late" })).toBeNull();
  });

  it("an empty report keeps the question open on the same id; the next one is released", async () => {
    const f = fixture();
    f.publish();
    const q = f.question();
    await f.admission.admit(q);
    await until(() => f.handed.length === 1, "handed");
    const cid = f.deliveries[0]!.correlationId;
    expect(await f.rep.report({ correlationId: cid, caller: "rep", text: "   " })!).toMatchObject({ ok: false });
    expect(f.stage(q.identity.messageId)).toBe("queued");
    expect(await f.rep.report({ correlationId: cid, caller: "rep", text: "Done." })!).toMatchObject({ ok: true });
    expect(f.stage(q.identity.messageId)).toBe("answered");
  });

  it("restart: work that never reached input is queued again; anything past it is held, never redelivered", async () => {
    const f = fixture();
    f.publish();
    f.offline();
    const a = f.question("first"), b = f.question("second");
    await f.admission.admit(a);
    await f.admission.admit(b);
    f.db.prepare("UPDATE hub_representative_questions SET state='dispatching', cid='hub-x' WHERE message_id=?").run(a.identity.messageId);
    f.db.prepare("UPDATE hub_representative_questions SET state='input', cid='hub-y' WHERE message_id=?").run(b.identity.messageId);
    const again = new HubRepresentativeExecution((f.rep as unknown as { options: ConstructorParameters<typeof HubRepresentativeExecution>[0] }).options);
    again.recover();
    expect(f.state(a.identity.messageId)!.state).toBe("queued");
    expect(f.state(b.identity.messageId)).toEqual({ state: "held", reason: "uncertain" });
    expect(() => again.recover()).toThrow();
  });

  it("#3147 P1: a failed required audit stops the release — nothing saved, nothing disclosed, a visible hold", async () => {
    const f = fixture();
    f.publish();
    const q = f.question();
    await f.admission.admit(q);
    await until(() => f.handed.length === 1, "handed");
    f.failAuditOf("representative.release");
    const outcome = await f.rep.report({ correlationId: f.deliveries[0]!.correlationId, caller: "rep", text: "secret" })!;
    expect(outcome.ok).toBe(false);
    expect(f.frames.some((x) => x.type === "answer")).toBe(false);
    expect(f.stage(q.identity.messageId)).toBe("consumed"); // no answer saved
    expect(f.state(q.identity.messageId)).toEqual({ state: "held", reason: "uncertain" });
    expect(f.rep.attentionItems()).toHaveLength(1);
  });

  it.each(["no link", "reject", "bad-ack"] as const)("#3147 P2: a saved answer whose send fails (%s) is held in Needs-you, never resent", async (mode) => {
    const f = fixture();
    f.publish();
    const q = f.question();
    await f.admission.admit(q);
    await until(() => f.handed.length === 1, "handed");
    if (mode === "no link") f.offline(); else f.exchange(mode);
    const cid = f.deliveries[0]!.correlationId;
    const outcome = await f.rep.report({ correlationId: cid, caller: "rep", text: "the answer" })!;
    expect(outcome.ok).toBe(false);
    expect(f.stage(q.identity.messageId)).toBe("answered"); // saved under its release lease
    expect(f.state(q.identity.messageId)).toEqual({ state: "held", reason: "uncertain" });
    expect(f.rep.attentionItems()).toMatchObject([{ kind: "hold", messageId: q.identity.messageId }]);
    expect(f.frames.filter((x) => x.type === "answer")).toHaveLength(mode === "no link" ? 0 : 1);
    expect(f.rep.report({ correlationId: cid, caller: "rep", text: "again" })).toBeNull(); // never a second release
  });

  it("#3147 P2: the reporting daemon generation is asked again before every release step", async () => {
    const f = fixture();
    f.publish();
    const q = f.question();
    await f.admission.admit(q);
    await until(() => f.handed.length === 1, "handed");
    let current = true;
    const grant = f.authorize.getMockImplementation()!;
    f.authorize.mockImplementation(async (r) => { const lease = await grant(r); if (r.phase === "release-answer") current = false; return lease; });
    const outcome = await f.rep.report({ correlationId: f.deliveries[0]!.correlationId, caller: "rep", text: "x", callerCurrent: () => current })!;
    expect(outcome.ok).toBe(false);
    expect(f.frames.some((x) => x.type === "answer")).toBe(false);
    expect(f.stage(q.identity.messageId)).toBe("consumed");
  });

  it("#3147 P2: a crash between the input intent and the representative's own transition is held uncertain, never re-queued", async () => {
    const f = fixture();
    f.publish();
    f.offline();
    const q = f.question();
    await f.admission.admit(q);
    // The intent committed in the journal; the process died before 'input' was written.
    const request = { messageId: q.identity.messageId, operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const };
    f.journal.markInputIntent(q.identity.messageId, request, await f.authorize(request), { current: () => true, linkEpoch: 1, revocationVersion: 1 });
    f.db.prepare("UPDATE hub_representative_questions SET state='dispatching', cid='hub-crash' WHERE message_id=?").run(q.identity.messageId);
    const again = new HubRepresentativeExecution((f.rep as unknown as { options: ConstructorParameters<typeof HubRepresentativeExecution>[0] }).options);
    again.recover();
    expect(f.state(q.identity.messageId)).toEqual({ state: "held", reason: "uncertain" });
    expect(f.stage(q.identity.messageId)).toBe("uncertain");
    expect(again.attentionItems()).toHaveLength(1);
    f.online();
    again.pump();
    await tick(); await tick();
    expect(f.deliveries).toHaveLength(0);
  });

  it("#3147 P2: a backlog larger than one page keeps draining after one pump", async () => {
    const f = fixture();
    f.publish();
    f.offline();
    for (let i = 0; i < 65; i += 1) await f.admission.admit(f.question(`q${i}`));
    for (let i = 0; i < 5; i += 1) await tick(); // every per-admission pump ran (offline: nothing to do)
    f.online();
    f.rep.pump();
    await until(() => f.handed.length === 65, "all 65 handed");
    expect(new Set(f.deliveries.map((d) => d.correlationId)).size).toBe(65);
  });
});
