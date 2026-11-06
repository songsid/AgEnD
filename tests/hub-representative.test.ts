/**
 * Hub P1 representative adapter (docs/design/hub-representative-agent.md, #3145) over the real S1 journal and admission:
 * the agent tuple, the consent/lifecycle binding, beforeInput's begin lease, the report_result correlation (exact,
 * consumed once), the frozen answer under its release lease, evidence/receipts, and never a resend.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { HubMemberJournal, migrateHubMemberJournal } from "../src/hub/member-journal.js";
import { HubMemberAdmissionAdapter } from "../src/hub/admission.js";
import { signAsker, sha256, issuerKeyId, operationDigest, messageContentDigest } from "../src/hub/identity.js";
import { HubMemberFiles } from "../src/hub/member/attachments.js";
import { HUB_ATTACHMENT_CHUNK } from "../src/hub/protocol.js";
import { HubRepresentativeExecution, HUB_REPORT_TARGET, agentPolicyDigest, isAgentTuple, migrateHubRepresentative, type HubRepresentativeDelivery } from "../src/hub/representative.js";
import type { HubAttachmentRef, HubAuthorizationRequest, HubQuestion } from "../src/hub/types.js";
import type { HubMemberProfile } from "../src/hub/profile.js";
import type { HubLocalExposure } from "../src/hub/execution/service.js";
import { buttonsDigest } from "../src/hub/buttons-model.js";

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

/** files/features/hubFiles: attachments-v1 (D) — the member's files service, the link's features, the Hub's stored files by id. */
function fixture(opts: { legacy?: boolean; handOff?: boolean; buttons?: boolean; files?: HubMemberFiles; features?: string[]; hubFiles?: Map<string, Buffer>; claimedSha?: Map<string, string> } = {}) {
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
  const question = (text = "What is in the folder?", attachments?: HubAttachmentRef[]): HubQuestion => ({ text, ...(attachments ? { attachments } : {}), identity: signAsker({ v: 1, issuer: profile.hub.hubId, issuerKeyId: profile.issuerKeyId, messageId: randomUUID(), asker: { realm: "directory", objectId: randomUUID() }, owner, destinationFleetId: profile.fleetId, exposureId: local.exposure.id, roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1, exposureRevision: 1, revocationVersion: 1, contentDigest: messageContentDigest("question", text, { attachments }), issuedAt: now, expiresAt: now + 120_000, nonce: randomBytes(32).toString("hex") }, keys.privateKey) });
  const lease = (request: HubAuthorizationRequest) => ({ decisionId: randomUUID(), messageId: request.messageId, operationId: request.operationId, phase: request.phase, operationDigest: operationDigest(request), exposureRevision: request.exposureRevision, revocationVersion: 1, linkEpoch: 1, expiresAt: now + 5_000 });
  const authorize = vi.fn(async (r: HubAuthorizationRequest) => lease(r));
  const frames: any[] = [];
  const puts = new Map<string, Buffer[]>();
  const link = {
    linkEpoch: 1,
    current: () => true,
    features: new Set(opts.features ?? (opts.buttons ? ["buttons-v1"] : [])),
    exchange: vi.fn(async (frame: any) => {
      frames.push(frame);
      if (frame.type === "attachment.get") {
        const bytes = opts.hubFiles?.get(frame.payload.id); if (!bytes) throw new Error("not-found");
        return { v: 1, type: "attachment.chunk", requestId: frame.requestId, linkEpoch: 1, payload: { id: frame.payload.id, offset: frame.payload.offset, total: bytes.length, sha256: opts.claimedSha?.get(frame.payload.id) ?? sha256(bytes), data: bytes.subarray(frame.payload.offset, frame.payload.offset + HUB_ATTACHMENT_CHUNK).toString("base64") } };
      }
      if (frame.type === "attachment.put") {
        const list = puts.get(frame.payload.id) ?? []; list.push(Buffer.from(frame.payload.data, "base64")); puts.set(frame.payload.id, list);
        return { v: 1, type: "attachment.ack", requestId: frame.requestId, linkEpoch: 1, payload: { id: frame.payload.id, offset: frame.payload.offset } };
      }
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
    ...(opts.files ? { files: opts.files } : {}),
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
  return { puts, db, rep, admission, journal, question, publish, authorize, deliveries, handed, frames, audit, stage, state, local, link,
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

describe("buttons-v1 representative reports", () => {
  it("snapshots choices before release authorization and saves/sends exactly those bytes", async () => {
    const f = fixture({ buttons: true }); f.publish(); const q = f.question(); await f.admission.admit(q);
    await until(() => f.handed.length === 1, "question handed");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { entered = resolve; });
    const real = f.authorize.getMockImplementation()!;
    f.authorize.mockImplementation(async request => { if (request.phase === "release-answer") { entered(); await gate; } return real(request); });
    const buttons = [{ label: "Original", value: "original" }, { label: "Other", value: "other" }];
    const poll = { seconds: 10, multi: true, reveal: "close" as const, showVoters: false, question: "Choose" };
    const pending = f.rep.report({ caller: "rep", correlationId: f.deliveries[0]!.correlationId, text: "Choose", extras: { buttons, poll } })!;
    await seen; buttons[0]!.label = "mutated"; poll.seconds = 99; release();
    expect((await pending).ok).toBe(true);
    const answer = f.frames.find(frame => frame.type === "answer").payload;
    expect(answer.buttons).toMatchObject({ labels: ["Original", "Other"], values: ["original", "other"], poll: { seconds: 10 } });
    expect(answer.contentDigest).toBe(messageContentDigest("answer", "Choose", { buttonsDigest: buttonsDigest(answer.buttons) }));
    const request = f.authorize.mock.calls.map(([request]) => request).find(request => request.phase === "release-answer")!;
    expect(request).toMatchObject({ answer: { answerId: answer.answerId, contentDigest: answer.contentDigest } });
    expect(f.stage(q.identity.messageId)).toBe("answered");
    expect(f.frames.filter(frame => frame.type === "answer")).toHaveLength(1);
  });
  it("an old Hub receives no button fields or release attempt, and text-only retry uses the same correlation", async () => {
    const f = fixture(); f.publish(); await f.admission.admit(f.question()); await until(() => f.handed.length === 1, "question handed");
    const correlationId = f.deliveries[0]!.correlationId;
    const refused = await f.rep.report({ caller: "rep", correlationId, text: "Choose", extras: { buttons: [{ label: "A", value: "a" }] } })!;
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("can't send buttons yet") });
    expect(f.authorize.mock.calls.filter(([request]) => request.phase === "release-answer")).toHaveLength(0);
    expect(f.frames.filter(frame => frame.type === "answer")).toEqual([]);
    expect((await f.rep.report({ caller: "rep", correlationId, text: "Plain answer" })!).ok).toBe(true);
    expect(f.frames.find(frame => frame.type === "answer").payload.buttons).toBeUndefined();
  });
  it("a lost negotiated capability during release prevents disclosure", async () => {
    const f = fixture({ buttons: true }); f.publish(); await f.admission.admit(f.question()); await until(() => f.handed.length === 1, "question handed");
    const real = f.authorize.getMockImplementation()!;
    f.authorize.mockImplementation(async request => { const lease = await real(request); if (request.phase === "release-answer") f.link.features.clear(); return lease; });
    expect((await f.rep.report({ caller: "rep", correlationId: f.deliveries[0]!.correlationId, text: "Choose", extras: { buttons: [{ label: "A", value: "a" }] } })!).ok).toBe(false);
    expect(f.frames.filter(frame => frame.type === "answer")).toEqual([]);
  });
});

describe("Hub representative files (attachments-v1, #3226 D)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function files() {
    const root = mkdtempSync(join(tmpdir(), "hub-rep-files-")); dirs.push(root);
    const state = join(root, "agend"), outside = join(root, "agent-work"); mkdirSync(state); mkdirSync(outside);
    const service = new HubMemberFiles({ stateDir: state, inboxDir: (a) => join(state, "workspaces", a, "inbox"), scratchDir: (a) => join(state, "workspaces", a, "hub-files") });
    return { service, state, outside, inbox: join(state, "workspaces", "rep", "inbox") };
  }
  const ref = (name: string, bytes: Buffer, mime: string): HubAttachmentRef => ({ id: randomUUID(), name, size: bytes.length, mime, sha256: sha256(bytes) });
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(HUB_ATTACHMENT_CHUNK + 99)]);
  const TXT = Buffer.from("hello from the asker\n");

  it("one release lease binds answer files and buttons together", async () => {
    const fs = files(), path = join(fs.outside, "answer.txt"); writeFileSync(path, "Owned answer file");
    const f = fixture({ files: fs.service, features: ["attachments-v1", "buttons-v1"] });
    f.publish(); await f.admission.admit(f.question()); await until(() => f.handed.length === 1, "question handed");
    expect((await f.rep.report({ caller: "rep", correlationId: f.deliveries[0]!.correlationId, text: "Choose", extras: {
      files: [path], buttons: [{ label: "Yes", value: "yes" }],
    } })!).ok).toBe(true);
    const answer = f.frames.find(frame => frame.type === "answer")!.payload;
    expect(answer.attachments).toHaveLength(1); expect(answer.buttons.values).toEqual(["yes"]);
    const digest = messageContentDigest("answer", "Choose", { attachments: answer.attachments, buttonsDigest: buttonsDigest(answer.buttons) });
    expect(answer.contentDigest).toBe(digest);
    expect(f.authorize.mock.calls.find(([request]) => request.phase === "release-answer")![0]).toMatchObject({ answer: { contentDigest: digest } });
    expect(answer.contentDigest).not.toBe(messageContentDigest("answer", "Choose", { attachments: answer.attachments }));
  });

  it("a question's files land whole in the agent's inbox and are named in its text, as fleet chat uploads are", async () => {
    const fs = files(), png = ref("chart.png", PNG, "image/png"), txt = ref("notes.txt", TXT, "text/plain");
    const f = fixture({ files: fs.service, features: ["attachments-v1"], hubFiles: new Map([[png.id, PNG], [txt.id, TXT]]) });
    f.publish();
    const q = f.question("See attached", [png, txt]);
    await f.admission.admit(q);
    await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
    const text = f.deliveries[0]!.text, id = q.identity.messageId;
    const pngPath = join(fs.inbox, `hub-${id}-1.png`), txtPath = join(fs.inbox, `hub-${id}-2.txt`);
    expect(readFileSync(pngPath).equals(PNG)).toBe(true); expect(readFileSync(txtPath).equals(TXT)).toBe(true);
    expect(text).toContain(`[📷 Image: ${pngPath}]`); expect(text).toContain(`[📎 File: notes.txt → ${txtPath}]`);
    expect(text).toContain("report_result's files");
    expect(f.frames.filter(x => x.type === "attachment.get").map(x => x.payload.offset)).toEqual([0, HUB_ATTACHMENT_CHUNK, 0]);
  });

  it("stored names are opaque and bounded: two messages sharing an 8-character id prefix never collide; a 255-byte display name is fine; a retry rewrites its own file", async () => {
    const fs = files(), long = "a".repeat(251) + ".txt";
    const fetch = (bytes: Buffer) => async (id: string, offset: number) => ({ id, offset, total: bytes.length, sha256: sha256(bytes), data: bytes.subarray(offset, offset + HUB_ATTACHMENT_CHUNK).toString("base64") });
    const A = Buffer.from("first message\n"), B = Buffer.from("second message!\n");
    const a = await fs.service.receive("rep", "12345678-1111-4111-8111-111111111111", [ref("notes.txt", A, "text/plain")], fetch(A));
    const b = await fs.service.receive("rep", "12345678-2222-4222-8222-222222222222", [ref("notes.txt", B, "text/plain")], fetch(B));
    const path = (line: string) => line.slice(line.lastIndexOf("→ ") + 2, -1);
    expect(path(a[0]!)).not.toBe(path(b[0]!));
    expect(readFileSync(path(a[0]!)).equals(A)).toBe(true); expect(readFileSync(path(b[0]!)).equals(B)).toBe(true);
    const l = await fs.service.receive("rep", randomUUID(), [ref(long, A, "text/plain")], fetch(A));
    expect(l[0]).toContain(`[📎 File: ${long} → `); expect(readFileSync(path(l[0]!)).equals(A)).toBe(true);
    const again = await fs.service.receive("rep", "12345678-1111-4111-8111-111111111111", [ref("notes.txt", A, "text/plain")], fetch(A));
    expect(again).toEqual(a);
  });

  it.each([["the link does not take files", { features: [] as string[] }], ["a chunk does not match its digest", { corrupt: true }]] as const)(
    "%s: the question is held (Needs you), never handed over without its files", async (_why, how) => {
      const fs = files(), txt = ref("notes.txt", TXT, "text/plain");
      // A corrupt chunk claims the ref's own digest: only the member's whole-file check can catch it.
      const f = fixture({ files: fs.service, features: "features" in how ? how.features : ["attachments-v1"], hubFiles: new Map([[txt.id, "corrupt" in how ? Buffer.from("x".repeat(TXT.length)) : TXT]]),
        claimedSha: new Map([[txt.id, txt.sha256]]) });
      f.publish();
      const q = f.question("See attached", [txt]);
      await f.admission.admit(q);
      await vi.waitFor(() => expect(f.state(q.identity.messageId)?.state).toBe("held"));
      expect(f.state(q.identity.messageId)).toEqual({ state: "held", reason: "files-unavailable" });
      expect(f.deliveries).toHaveLength(0);
    });

  it("report_result files: copied under the reply rule, pushed in chunks BEFORE the answer, bound in its digest and lease", async () => {
    const fs = files(), f = fixture({ files: fs.service, features: ["attachments-v1"] });
    const csv = join(fs.outside, "by-region.csv"), bytes = Buffer.from("region,sales\n" + "north,42\n".repeat(25_000)); writeFileSync(csv, bytes);
    f.publish(); const q = f.question(); await f.admission.admit(q);
    await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
    const outcome = await f.rep.report({ correlationId: f.deliveries[0]!.correlationId, caller: "rep", text: "Attached.", extras: { files: [csv] } })!;
    expect(outcome.ok).toBe(true);
    const order = f.frames.map(x => x.type).filter(t => t === "attachment.put" || t === "answer");
    expect(order).toEqual(["attachment.put", "attachment.put", "answer"]);
    const answer = f.frames.find(x => x.type === "answer")!.payload, sent = answer.attachments;
    expect(sent).toEqual([{ id: expect.any(String), name: "by-region.csv", size: bytes.length, mime: "text/csv", sha256: sha256(bytes) }]);
    expect(Buffer.concat(f.puts.get(sent[0].id)!).equals(bytes)).toBe(true);
    expect(answer.contentDigest).toBe(messageContentDigest("answer", "Attached.", { attachments: sent }));
    expect(f.authorize.mock.calls.map(([r]) => r).find(r => r.phase === "release-answer")).toMatchObject({ answer: { contentDigest: answer.contentDigest } });
  });

  it.each([["a state-dir file", "state"], ["an SVG", "svg"], ["a symlink", "link"], ["a Hub that can't take files", "nolink"]] as const)(
    "report_result with %s is refused with a fixable reason; the question stays open, nothing is sent", async (_what, kind) => {
      const fs = files(), f = fixture({ files: fs.service, features: kind === "nolink" ? [] : ["attachments-v1"] });
      let path = join(fs.outside, "ok.txt"); writeFileSync(path, "ok");
      if (kind === "state") { path = join(fs.state, "secret.txt"); writeFileSync(path, "token"); }
      if (kind === "svg") { path = join(fs.outside, "x.svg"); writeFileSync(path, "<svg/>"); }
      if (kind === "link") { const target = join(fs.outside, "real.txt"); writeFileSync(target, "x"); path = join(fs.outside, "alias.txt"); symlinkSync(target, path); }
      f.publish(); const q = f.question(); await f.admission.admit(q);
      await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
      const cid = f.deliveries[0]!.correlationId;
      const outcome = await f.rep.report({ correlationId: cid, caller: "rep", text: "Here.", extras: { files: [path] } })!;
      expect(outcome.ok).toBe(false); expect(outcome.message).toMatch(/^Not sent: .+ Report again with the same correlation_id\.$/);
      expect(f.frames.some(x => x.type === "attachment.put" || x.type === "answer")).toBe(false);
      expect(f.state(q.identity.messageId)!.state).toBe("delivered");
      expect((await f.rep.report({ correlationId: cid, caller: "rep", text: "Text only then." })!).ok).toBe(true);
    });
});
