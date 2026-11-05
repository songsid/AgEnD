/** Member-local restricted gateway. No production providers, CLI, fleet-input or host-tool imports. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalArguments, personKeyString, sha256, verifyAsker, verifyLease, type HubIdentityBinding } from "../identity.js";
import { questionContextDigest, type HubMemberJournal, type HubRestrictedOutbox } from "../member-journal.js";
import { answerSchema, exposureSchema, questionSchema } from "../protocol.js";
import { epoch, identifier, plain, uuid, hash, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import type { HubAnswer, HubAuthorizationLease, HubAuthorizationRequest, HubExecutionPolicy, HubLocalProposal,
  HubQuestion, HubRestrictedContext, HubRestrictedExecution, HubMemberTransport } from "../types.js";
import { HubDocumentView, executionPolicyDigest } from "./views.js";
import { HubExecutionStore } from "./store.js";
import type { HubExecutionAttentionInput } from "../../needs-you.js";

const localSchema = z.strictObject({ agent: identifier, providerId: identifier, consentId: uuid, generation: epoch, exposure: exposureSchema });
export type HubLocalExposure = z.infer<typeof localSchema>;
export interface HubExecutionBinding extends Omit<HubIdentityBinding, "now"> {
  generation: number; linkEpoch: number;
  /** Captured ownership token, permanently false after stop/replacement, including an off/on cycle. */
  current(): boolean;
}
export type HubExecutionReadiness = { ok: true; policyDigest: string; exposureRevision: number }
  | { ok: false; reasonCode: "unavailable" | "provider-unavailable" | "policy-unavailable" | "stale" };
export interface HubExecutionGateway {
  invoke(name: string, args: unknown): Promise<unknown>;
  propose(action: string, args: unknown, consequences: string): Promise<void>;
}
/** Trusted, reviewed code only, never a wire/config-supplied claim. No adapter ships in the production registry.
 * A future adapter must prove separate history/workspace/credentials and deny native/child tools and free network.
 * This declaration alone is not isolation evidence and cannot authorize installing a provider. */
export interface HubIsolatedProvider {
  readonly isolation: "hub-restricted-v1";
  /** Resolve only after positive consumption proof for this exact context/question; unknown outcomes reject. */
  open(input: { contextId: string; question: string; label: string; signal: AbortSignal;
    /** One synchronous current/exact-lease check immediately before delivering question input. Not sent to the CLI. */
    beforeInput(): void;
  }): Promise<{
    answer(gateway: HubExecutionGateway): Promise<string>;
    close(): Promise<void>;
  }>;
}
export interface HubExecutionOptions {
  store: HubExecutionStore; journal: HubMemberJournal;
  transport: Pick<HubMemberTransport, "authorize">;
  binding(): HubExecutionBinding;
  /** Current, durably owner-approved mapping. No Hub mirror or remote path is accepted here. */
  localExposure(exposureId: string): HubLocalExposure | null;
  views: ReadonlyMap<string, HubDocumentView>;
  /** Default is empty. Native/full-tool provider drivers must never be placed here. */
  providers?: ReadonlyMap<string, HubIsolatedProvider>;
  now?: () => number;
  /** Pokes the local Needs-you renderer; durable items are read with attentionItems(). No approval callback. */
  attentionChanged(): void;
}
interface Operation { request: HubAuthorizationRequest; lease: HubAuthorizationLease }
interface LiveContext {
  handle: HubRestrictedContext; question: HubQuestion; binding: HubExecutionBinding; bindingDigest: string;
  local: HubLocalExposure; view: HubDocumentView; provider: HubIsolatedProvider; abort: AbortController;
  state: "prepared" | "running" | "held" | "finished"; beginRequested: boolean; toolPending: boolean; finishing: boolean;
  operations: Map<string, Operation>; session?: Awaited<ReturnType<HubIsolatedProvider["open"]>>;
  sessionClosed?: boolean;
  opening?: ReturnType<HubIsolatedProvider["open"]>; answering?: Promise<string>; closing?: Promise<void>; retiring?: Promise<void>;
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const snapshot = <T>(value: T): T => parseStrictJson(canonicalArguments(value), 64 * 1024) as T;

export class HubRestrictedExecutionService implements HubRestrictedExecution {
  private readonly bootId = randomUUID();
  private readonly handles = new WeakMap<object, LiveContext>();
  private readonly live = new Map<string, LiveContext>();
  private recovered = false;
  private lastNow = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  constructor(private readonly options: HubExecutionOptions) {}
  private now(): number {
    const now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < this.lastNow) throw new HubProtocolError("stale");
    this.lastNow = now; return now;
  }
  /** Explicit startup, not an import side effect. Every old context remains unavailable; no input/action retry. */
  recover(): void {
    if (this.recovered) throw new HubProtocolError("conflict");
    for (const row of this.options.store.contexts()) {
      if (row.state !== "held" && row.state !== "finished") {
        this.options.store.state(row.id, "held");
        this.options.store.attention(row.id, `hold:${row.id}`, { id: `hold:${row.id}`, kind: "hold", agent: row.agent,
          messageId: row.messageId, exposureId: row.exposureId, reasonCode: "uncertain", since: this.now() });
      }
    }
    this.recovered = true; this.options.attentionChanged();
  }
  private binding(): HubExecutionBinding {
    if (!this.recovered || this.closed) throw new HubProtocolError("unavailable");
    this.options.store.check(); const b = this.options.binding();
    if (!b.current() || !Number.isSafeInteger(b.generation) || b.generation < 0) throw new HubProtocolError("unavailable");
    validated(epoch.min(1), b.linkEpoch); validated(epoch, b.revocationVersion); this.now();
    return b;
  }
  private approved(exposureId: string, expectedRevision: number, published = false) {
    const b = this.binding(), local = validated(localSchema, this.options.localExposure(exposureId));
    return this.checkedPolicy(local, b, exposureId, expectedRevision, published);
  }
  private checkedPolicy(local: HubLocalExposure, b: HubExecutionBinding, exposureId: string, expectedRevision: number, published: boolean) {
    const e = local.exposure;
    if (e.id !== exposureId || e.revision !== expectedRevision || e.fleetId !== b.fleetId || personKeyString(e.owner) !== personKeyString(b.owner)
      || e.state === "frozen" || published && e.state !== "published") throw new HubProtocolError("stale");
    const view = this.options.views.get(e.dataViewId), provider = this.options.providers?.get(local.providerId);
    if (!HubDocumentView.installed(view) || e.policyDigest !== executionPolicyDigest(view, e.allowedTools)) throw new HubProtocolError("denied");
    if (!provider || provider.isolation !== "hub-restricted-v1") throw new HubProtocolError("incompatible");
    const policy: HubExecutionPolicy = { dataViewId: e.dataViewId, policyDigest: e.policyDigest, allowedTools: [...e.allowedTools], readOnly: true };
    const bindingDigest = sha256(canonicalArguments([local, view.digest, policy]));
    return { b, local, view, provider, policy, bindingDigest };
  }
  private readinessCheck(check: () => { policy: HubExecutionPolicy; revision: number }): HubExecutionReadiness {
    try {
      const { policy, revision } = check();
      return { ok: true, policyDigest: policy.policyDigest, exposureRevision: revision };
    } catch (error) {
      return { ok: false, reasonCode: error instanceof HubProtocolError
        ? error.code === "incompatible" ? "provider-unavailable" : error.code === "stale" ? "stale" : error.code === "denied" || error.code === "invalid" ? "policy-unavailable" : "unavailable"
        : "unavailable" };
    }
  }
  readiness(exposureId: string, expectedRevision: number): HubExecutionReadiness {
    return this.readinessCheck(() => {
      validated(uuid, exposureId); validated(epoch, expectedRevision);
      return { policy: this.approved(exposureId, expectedRevision).policy, revision: expectedRevision };
    });
  }
  /** Capability check only. Never reads/installs a staged mapping or supplies admission/owner consent. */
  readinessCandidate(candidate: HubLocalExposure): HubExecutionReadiness {
    return this.readinessCheck(() => {
      const local = validated(localSchema, candidate), e = local.exposure;
      if (e.state !== "withdrawn") throw new HubProtocolError("denied");
      return { policy: this.checkedPolicy(local, this.binding(), e.id, e.revision, false).policy, revision: e.revision };
    });
  }
  restrictedOutbox(): HubRestrictedOutbox {
    return this.options.store.outbox(q => {
      const { b, bindingDigest } = this.approved(q.identity.exposureId, q.identity.exposureRevision, true);
      verifyAsker(q.identity, q.text, { ...b, now: this.now() });
      return bindingDigest;
    });
  }
  async prepare(input: HubQuestion, policy: HubExecutionPolicy): Promise<HubRestrictedContext> {
    const question = freeze(validated(questionSchema, input)), e = question.identity;
    const { b, local, view, provider, policy: approved, bindingDigest } = this.approved(e.exposureId, e.exposureRevision, true);
    verifyAsker(e, question.text, { ...b, now: this.now() });
    if (canonicalArguments(policy) !== canonicalArguments(approved)) throw new HubProtocolError("denied");
    const source = `hub:${e.issuer}:${e.messageId}`, queued = this.options.store.queued(source);
    if (!queued || queued.digest !== questionContextDigest(question) || queued.binding_digest !== bindingDigest) throw new HubProtocolError("denied");
    if (this.live.size >= 64) throw new HubProtocolError("backpressure");
    const handle = freeze({ id: randomUUID(), messageId: e.messageId, exposureId: e.exposureId, owner: { ...e.owner }, exposureRevision: e.exposureRevision, policy: approved });
    this.options.store.claim({ id: handle.id, source, messageId: e.messageId, exposureId: e.exposureId, bindingDigest, bootId: this.bootId, state: "prepared", agent: local.agent });
    const capturedBinding = Object.freeze({ ...b, owner: Object.freeze({ ...b.owner }), current: b.current.bind(b) });
    const entry: LiveContext = { handle, question, binding: capturedBinding, bindingDigest, local, view, provider, abort: new AbortController(),
      state: "prepared", beginRequested: false, toolPending: false, finishing: false, operations: new Map() };
    this.handles.set(handle, entry); this.live.set(handle.id, entry); return handle;
  }
  private entry(context: HubRestrictedContext): LiveContext {
    const entry = context && this.handles.get(context);
    if (!entry || entry.handle !== context) throw new HubProtocolError("denied");
    if (entry.state === "held" || entry.state === "finished") throw new HubProtocolError("stale");
    this.current(entry); return entry;
  }
  private current(entry: LiveContext): void {
    try {
      const b = this.binding(), original = entry.binding;
      if (entry.state === "held" || entry.state === "finished" || !original.current() || original.generation !== b.generation
        || original.linkEpoch !== b.linkEpoch || original.revocationVersion !== b.revocationVersion || original.hubId !== b.hubId
        || original.fleetId !== b.fleetId || personKeyString(original.owner) !== personKeyString(b.owner)) throw new HubProtocolError("stale");
      if (this.now() >= entry.question.identity.issuedAt + 24 * 60 * 60_000) throw new HubProtocolError("expired");
      const local = this.approved(entry.handle.exposureId, entry.handle.exposureRevision, true);
      const stored = this.options.store.context(entry.handle.id);
      if (local.bindingDigest !== entry.bindingDigest || local.view !== entry.view || local.provider !== entry.provider || stored.bootId !== this.bootId
        || stored.bindingDigest !== entry.bindingDigest || stored.state !== entry.state) throw new HubProtocolError("stale");
    } catch (error) { this.fenceEntry(entry, "stale"); throw error; }
  }
  private fenceEntry(entry: LiveContext, reasonCode: string): void {
    if (entry.state === "held" || entry.state === "finished") { this.closeSession(entry); void this.retire(entry); return; }
    entry.state = "held"; entry.abort.abort();
    try {
      this.options.store.state(entry.handle.id, "held");
      const id = `hold:${entry.handle.id}`;
      this.options.store.attention(entry.handle.id, id, { id, kind: "hold", agent: entry.local.agent, messageId: entry.handle.messageId,
        exposureId: entry.handle.exposureId, reasonCode, since: this.lastNow });
    } finally {
      try { this.options.attentionChanged(); }
      finally { this.closeSession(entry); void this.retire(entry); }
    }
  }
  private closeSession(entry: LiveContext): Promise<void> | undefined {
    if (!entry.session) return;
    if (!entry.sessionClosed) {
      entry.sessionClosed = true; entry.closing = Promise.resolve().then(() => entry.session!.close());
      void entry.closing.catch(() => {});
    }
    return entry.closing;
  }
  /** Retain the physical-work reservation until open/answer/close have actually exited. */
  private retire(entry: LiveContext): Promise<void> {
    if (!entry.retiring) {
      entry.retiring = (async () => {
        if (entry.opening) { try { entry.session ??= await entry.opening; } catch { /* Physical work exited without a session. */ } }
        this.closeSession(entry);
        if (entry.answering) { try { await entry.answering; } catch { /* Cancelled physical work has exited. */ } }
        await entry.closing;
        this.live.delete(entry.handle.id);
      })();
      void entry.retiring.catch(() => {});
    }
    return entry.retiring;
  }
  /** Call synchronously on off/withdraw/revoke/link replacement, before async cleanup. */
  fence(messageId: string, reasonCode = "revoked"): void {
    for (const entry of [...this.live.values()]) if (entry.handle.messageId === messageId) this.fenceEntry(entry, reasonCode);
  }
  /** Synchronous invalidation precedes persistence/cleanup, including when a required writer fails. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; const entries = [...this.live.values()];
    for (const entry of entries) entry.abort.abort();
    let failed = false;
    for (const entry of entries) { try { this.fenceEntry(entry, "unavailable"); } catch { failed = true; } }
    this.closing = Promise.allSettled(entries.map(entry => this.retire(entry))).then(results => {
      if (failed || results.some(result => result.status === "rejected")) throw new HubProtocolError("uncertain");
    });
    return this.closing;
  }
  private async authorize(entry: LiveContext, request: HubAuthorizationRequest): Promise<HubAuthorizationLease> {
    this.current(entry); this.options.store.reserve(entry.handle.id, request);
    try {
      const received = await this.options.transport.authorize(freeze(snapshot(request)));
      this.current(entry);
      const lease = freeze({ ...verifyLease(received, request, { ...entry.binding, now: this.now() }) });
      entry.operations.set(request.operationId, { request: freeze(snapshot(request)), lease }); return lease;
    } catch (error) { this.fenceEntry(entry, "unavailable"); throw error; }
  }
  async authorizeBegin(context: HubRestrictedContext): Promise<HubAuthorizationLease> {
    const entry = this.entry(context);
    if (entry.state !== "prepared" || entry.beginRequested) throw new HubProtocolError("uncertain");
    entry.beginRequested = true;
    return this.authorize(entry, { messageId: context.messageId, operationId: randomUUID(), exposureRevision: context.exposureRevision, phase: "begin" });
  }
  private consume(entry: LiveContext, lease: HubAuthorizationLease, request: HubAuthorizationRequest): void {
    this.current(entry); const issued = entry.operations.get(request.operationId);
    // A structurally valid DTO alone is never authority: require our own online authorization result object.
    if (!issued || issued.lease !== lease || canonicalArguments(issued.request) !== canonicalArguments(request)) throw new HubProtocolError("denied");
    verifyLease(lease, request, { ...entry.binding, now: this.now() });
    this.options.store.consume(entry.handle.id, request); entry.operations.delete(request.operationId);
    this.current(entry);
  }
  /** Register ownership BEFORE any provider code can synchronously stop/reenter this service. */
  private physical<T>(entry: LiveContext, register: (pending: Promise<T>) => void, work: () => Promise<T>): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
    const pending = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    register(pending);
    try { this.current(entry); resolve(work()); } catch (error) { reject(error); }
    return pending;
  }
  async begin(context: HubRestrictedContext, lease: HubAuthorizationLease): Promise<void> {
    const entry = this.entry(context);
    if (entry.state !== "prepared") throw new HubProtocolError("uncertain");
    const request: HubAuthorizationRequest = { messageId: context.messageId, operationId: lease.operationId, exposureRevision: context.exposureRevision, phase: "begin" };
    this.consume(entry, lease, request);
    try {
      this.options.journal.markInputIntent(context.messageId, request, lease, { ...entry.binding, current: () => { this.current(entry); return true; } });
      this.options.store.state(context.id, "running"); entry.state = "running"; this.current(entry);
      const e = entry.question.identity;
      const label = `Hub identity; external data; no local human authority. ${personKeyString(e.asker)}; exposure=${e.exposureId}; room=${e.roomId}; grant=${e.grantId}`;
      let checkedInput = false;
      const session = await this.physical(entry, pending => { entry.opening = pending; },
        () => entry.provider.open({ contextId: context.id, question: entry.question.text, label, signal: entry.abort.signal, beforeInput: () => {
          if (checkedInput) throw new HubProtocolError("uncertain");
          this.current(entry); verifyLease(lease, request, { ...entry.binding, now: this.now() }); checkedInput = true;
        } }));
      entry.session = session; this.current(entry);
      if (!checkedInput) throw new HubProtocolError("uncertain");
      this.options.journal.recordEvidence(context.messageId, "delivered"); this.options.journal.recordEvidence(context.messageId, "consumed");
    } catch (error) { this.fenceEntry(entry, "uncertain"); throw error; }
  }
  private toolArguments(entry: LiveContext, name: string, input: unknown): unknown {
    if (!entry.handle.policy.allowedTools.includes(name)) {
      this.options.store.note({ kind: "tool.denied", contextId: entry.handle.id, messageId: entry.handle.messageId });
      throw new HubProtocolError("denied");
    }
    return freeze(snapshot(entry.view.arguments(name, snapshot(input))));
  }
  async authorizeTool(context: HubRestrictedContext, name: string, input: unknown): Promise<HubAuthorizationLease> {
    const entry = this.entry(context);
    if (entry.state !== "running" || entry.toolPending) throw new HubProtocolError("uncertain");
    const args = this.toolArguments(entry, name, input); entry.toolPending = true;
    return this.authorize(entry, { messageId: context.messageId, operationId: randomUUID(), exposureRevision: context.exposureRevision, phase: "tool",
      tool: { name, argumentsDigest: sha256(canonicalArguments(args)) } });
  }
  async invokeTool(context: HubRestrictedContext, name: string, input: unknown, lease: HubAuthorizationLease): Promise<unknown> {
    const entry = this.entry(context);
    if (entry.state !== "running" || !entry.toolPending) throw new HubProtocolError("denied");
    const args = this.toolArguments(entry, name, input);
    this.consume(entry, lease, { messageId: context.messageId, operationId: lease.operationId, exposureRevision: context.exposureRevision, phase: "tool",
      tool: { name, argumentsDigest: sha256(canonicalArguments(args)) } });
    try {
      this.current(entry); const result = entry.view.read(name, args); this.current(entry);
      this.options.store.note({ kind: "tool.completed", contextId: context.id, operationId: lease.operationId });
      return result;
    } finally { entry.toolPending = false; }
  }
  async finish(context: HubRestrictedContext): Promise<HubAnswer> {
    const entry = this.entry(context);
    if (entry.state !== "running" || !entry.session || entry.finishing || entry.toolPending) throw new HubProtocolError("uncertain");
    entry.finishing = true;
    try {
      entry.answering = this.physical(entry, pending => { entry.answering = pending; }, () => entry.session!.answer({
        invoke: async (name, args) => {
          const fixed = snapshot(args), lease = await this.authorizeTool(context, name, fixed);
          return this.invokeTool(context, name, fixed, lease);
        },
        propose: async (action, args, consequences) => {
          const fixed = snapshot(args);
          await this.proposeLocalAction(context, { id: randomUUID(), action, argumentsDigest: sha256(canonicalArguments(fixed)), consequences }, fixed);
        },
      }));
      const text = validated(plain(128 * 1024), await entry.answering);
      this.current(entry);
      const answerId = randomUUID(), contentDigest = sha256(text);
      const request: HubAuthorizationRequest = { messageId: context.messageId, operationId: randomUUID(), exposureRevision: context.exposureRevision,
        phase: "release-answer", answer: { answerId, contentDigest } };
      const releaseLease = await this.authorize(entry, request); this.consume(entry, releaseLease, request);
      const answer = freeze(validated(answerSchema, { messageId: context.messageId, answerId, text, contentDigest, releaseLease }));
      this.current(entry); this.options.journal.saveAnswer(answer, request, { ...entry.binding, current: () => { this.current(entry); return true; } });
      this.options.store.state(context.id, "finished"); entry.state = "finished";
      this.closeSession(entry); void this.retire(entry); return answer;
    } catch (error) { this.fenceEntry(entry, "uncertain"); throw error; }
  }
  async hold(context: HubRestrictedContext, reasonCode: string): Promise<void> {
    const entry = this.handles.get(context); if (!entry) throw new HubProtocolError("denied");
    validated(z.enum(["unavailable", "denied", "stale", "uncertain", "revoked"]), reasonCode); this.fenceEntry(entry, reasonCode);
  }
  /** Additional args are required because a digest alone cannot show the owner the exact proposed arguments. */
  async proposeLocalAction(context: HubRestrictedContext, input: HubLocalProposal, args?: unknown): Promise<void> {
    const entry = this.entry(context);
    if (entry.state !== "running") throw new HubProtocolError("denied");
    const proposal = validated(z.strictObject({ id: uuid, action: plain(256).min(1), argumentsDigest: hash, consequences: plain(4096).min(1) }), input);
    const fixed = snapshot(args);
    if (sha256(canonicalArguments(fixed)) !== proposal.argumentsDigest) throw new HubProtocolError("denied");
    this.current(entry);
    this.options.store.attention(context.id, proposal.id, { id: proposal.id, kind: "proposal", agent: entry.local.agent,
      messageId: context.messageId, exposureId: context.exposureId, action: proposal.action, arguments: fixed,
      argumentsDigest: proposal.argumentsDigest, consequences: proposal.consequences, localAuthority: "none", since: this.now() });
    this.options.attentionChanged();
  }
  attentionItems(): HubExecutionAttentionInput[] {
    return this.options.store.attentionItems().map(input => {
      const common = { id: z.string().max(128), agent: identifier, messageId: uuid, exposureId: uuid, since: epoch };
      const item = validated(z.discriminatedUnion("kind", [
        z.strictObject({ ...common, kind: z.literal("hold"), reasonCode: z.string().max(64) }),
        z.strictObject({ ...common, kind: z.literal("proposal"), action: plain(256), arguments: z.unknown(), argumentsDigest: hash, consequences: plain(4096), localAuthority: z.literal("none") }),
      ]), input);
      return { id: item.id, kind: item.kind, agent: item.agent, messageId: item.messageId, exposureId: item.exposureId, since: item.since,
        ...(item.kind === "proposal" ? { proposal: { action: item.action, arguments: canonicalArguments(item.arguments), argumentsDigest: item.argumentsDigest, consequences: item.consequences } } : {}) };
    });
  }
}
