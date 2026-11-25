import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RequestContextActorV1Schema, RequestContextV1Schema, type RequestContextActorV1, type RequestContextV1 } from "./request-context-protocol.js";
import { requestContextDigest } from "./request-context-store.js";

export interface RequestContextRuntimeOwner {
  instance: string; incarnation: string; workGeneration: string;
  daemonBootId: string; spawnGeneration: number; launchFenceEpoch: number; deliveryEpoch: number;
}
type Sender = { kind: "peer"; instance: string; incarnation: string } | RequestContextActorV1;
const senderIdentity = (sender: Sender): unknown => {
  if (sender.kind === "peer") return sender;
  if (sender.kind === "unknown") throw Error("request-context unknown expected sender");
  return sender.platform === "hub" ? { kind: sender.kind, platform: sender.platform, hubId: sender.hubId, id: sender.id }
    : { kind: sender.kind, platform: sender.platform, userId: sender.userId };
};
export type RequestContextInputProof =
  | { kind: "independent" }
  | { kind: "expected-return"; parentContextId: string; expectedSender: Sender; actualSender: Sender }
  | { kind: "admin-steer"; activeToken?: string; parentContextId?: string; actor: RequestContextActorV1 }
  | { kind: "recovery"; parentContextId?: string };
const key = z.string().min(1).max(256);
const senderSchema = z.union([z.strictObject({ kind: z.literal("peer"), instance: key, incarnation: key }), RequestContextActorV1Schema]);
const proofSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("independent") }),
  z.strictObject({ kind: z.literal("expected-return"), parentContextId: z.uuid(), expectedSender: senderSchema, actualSender: senderSchema }),
  z.strictObject({ kind: z.literal("admin-steer"), activeToken: z.uuid().optional(), parentContextId: z.uuid().optional(), actor: RequestContextActorV1Schema })
    .refine(value => !!value.activeToken !== !!value.parentContextId, "Exactly one current turn or mapped work is required"),
  z.strictObject({ kind: z.literal("recovery"), parentContextId: z.uuid().optional() }),
]);
export interface PreparedRequestContextInput {
  inputId: string; wireSha256: string; owner: RequestContextRuntimeOwner; context?: RequestContextV1; proof: RequestContextInputProof;
}
export interface RequestContextRecoveryPointer {
  instance: string; incarnation: string; workGeneration: string; contextId: string;
}
export interface RequestContextTurnPorts {
  /** Only server-owned admitted input/attempt or recovery-job keys; never a body, reply pointer or correlation string. */
  input(inputId: string): PreparedRequestContextInput | null;
  context(contextId: string): RequestContextV1 | null;
  retain(context: RequestContextV1): void;
  canManage(actor: RequestContextActorV1): boolean;
  recovery(): RequestContextRecoveryPointer | null;
  saveRecovery(pointer: RequestContextRecoveryPointer | null): void;
}
export interface RequestContextTurnSnapshot {
  readonly token: string; readonly inputId: string; readonly context: RequestContextV1;
  readonly owner: Readonly<RequestContextRuntimeOwner>; readonly wireSha256: string;
  /** Diagnostic only. This is not a causal parent or a release reference. */
  readonly unprovedRecoveryFrom?: string;
}
export class RequestContextInputDeferred extends Error {
  constructor() { super("request-context input must wait for the owned turn to end"); this.name = "RequestContextInputDeferred"; }
}
const same = (a: unknown, b: unknown): boolean => requestContextDigest(a) === requestContextDigest(b);
const outside = (context: RequestContextV1): boolean => context.ingress !== "owner";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function validOwner(owner: RequestContextRuntimeOwner): void {
  if (![owner.instance, owner.incarnation, owner.workGeneration, owner.daemonBootId].every(value => typeof value === "string" && value.length > 0 && value.length <= 256)
    || ![owner.spawnGeneration, owner.launchFenceEpoch, owner.deliveryEpoch].every(value => Number.isSafeInteger(value) && value >= 0)) throw Error("request-context unknown runtime owner");
}
/** Per-owned-turn binding only. No clock, pending-child lock, human authority or persistent active-turn restoration. */
export class RequestContextLocalTurns {
  private active: RequestContextTurnSnapshot | null = null;
  constructor(private readonly ports: RequestContextTurnPorts) {}
  current(owner: RequestContextRuntimeOwner): RequestContextTurnSnapshot | null {
    validOwner(owner);
    if (this.active && !same(this.active.owner, owner)) this.active = null;
    return this.active;
  }
  isCurrent(snapshot: RequestContextTurnSnapshot, owner: RequestContextRuntimeOwner): boolean {
    validOwner(owner);
    // A stale completion/query must not clear a newer binding as a side effect of checking its old owner.
    const active = this.active;
    return active !== null && same(active.owner, owner) && active.token === snapshot.token && same(active, snapshot);
  }
  beforeQueuedSteer(inputId: string | null, wireSha256: string, owner: RequestContextRuntimeOwner): RequestContextTurnSnapshot {
    const input = inputId === null ? null : this.ports.input(inputId);
    const active = this.current(owner);
    if (!input || input.inputId !== inputId || input.proof.kind !== "admin-steer" || !active) throw new RequestContextInputDeferred();
    // apply validates live canManage, exact actor, original parent/token and unchanged wire digest.
    const snapshot = this.apply(input, wireSha256, owner);
    if (snapshot.token !== active.token) throw new RequestContextInputDeferred();
    return snapshot;
  }
  /** Called synchronously under the final pane-write lock, after every await/current-owner check. */
  beforeWrite(inputId: string | null, wireSha256: string, owner: RequestContextRuntimeOwner): RequestContextTurnSnapshot {
    const input: PreparedRequestContextInput | null = inputId === null
      ? { inputId: `unmapped-system:${randomUUID()}`, wireSha256, owner, proof: { kind: "recovery" } } : this.ports.input(inputId);
    if (!input || inputId !== null && input.inputId !== inputId) throw Error("request-context admitted input unavailable");
    return this.apply(input, wireSha256, owner);
  }
  /** An already-owned recovery job captures its original input binding, not the latest speaker or correlation. */
  beforeRecoveryWrite(inputId: string, wireSha256: string, owner: RequestContextRuntimeOwner,
    parent: RequestContextTurnSnapshot): RequestContextTurnSnapshot {
    const stored = this.ports.context(parent.context.ref.contextId);
    if (!stored || !same(stored, parent.context) || parent.owner.instance !== owner.instance
      || parent.owner.incarnation !== owner.incarnation || parent.owner.workGeneration !== owner.workGeneration) throw Error("request-context recovery job parent changed");
    return this.apply({ inputId, wireSha256, owner, context: parent.context,
      proof: { kind: "recovery", parentContextId: parent.context.ref.contextId } }, wireSha256, owner);
  }
  private apply(input: PreparedRequestContextInput, wireSha256: string, owner: RequestContextRuntimeOwner): RequestContextTurnSnapshot {
    const active = this.current(owner), inputId = input.inputId;
    if (input.wireSha256 !== wireSha256) throw Error("request-context admitted input unavailable");
    if (!same(input.owner, owner)) throw Error("request-context prepared input owner changed");
    if (active?.inputId === inputId) {
      if (active.wireSha256 !== wireSha256) throw Error("request-context input changed during retry");
      return active;
    }
    const proof = proofSchema.parse(input.proof);
    let context = input.context ? RequestContextV1Schema.parse(input.context) : null;
    let diagnostic: string | undefined;
    if (proof.kind === "admin-steer") {
      if (proof.actor.kind !== "person" || proof.actor.platform === "hub" || !this.ports.canManage(proof.actor)) {
        throw Error("request-context steer has no current permitted work");
      }
      if (proof.activeToken) {
        if (!active || active.token !== proof.activeToken) throw Error("request-context steer has no current permitted work");
        if (context && !same(context, active.context)) throw Error("request-context steer cannot replace active provenance");
        context = active.context;
      } else {
        const parent = this.ports.context(proof.parentContextId!);
        context ??= parent;
        if (!parent || !context || context.ref.rootContextId !== parent.ref.rootContextId
          || context.ref.contextId !== parent.ref.contextId && context.ref.parentContextId !== parent.ref.contextId) throw Error("request-context mapped steer unavailable");
        for (const key of ["rootEvidenceRef", "initiatingActor", "ingress", "sourceAudience", "returnAudience"] as const) {
          if (!same(parent[key] ?? null, context[key] ?? null)) throw Error("request-context steer cannot replace active provenance");
        }
        if (active && active.context.ref.rootContextId !== context.ref.rootContextId) throw new RequestContextInputDeferred();
      }
      // Recognition of this administrator is not a go-ahead and does not replace the outside requester.
    } else if (proof.kind === "expected-return" || proof.kind === "recovery" && proof.parentContextId) {
      const parentId = proof.parentContextId!;
      const parent = this.ports.context(parentId);
      if (!parent || !context || context.ref.rootContextId !== parent.ref.rootContextId
        || context.ref.contextId !== parentId && context.ref.parentContextId !== parentId) throw Error("request-context expected parent unavailable");
      if (proof.kind === "expected-return") {
        if (!same(senderIdentity(proof.expectedSender), senderIdentity(proof.actualSender))) throw Error("request-context unexpected return sender");
        if (proof.actualSender.kind !== "peer" && !same(senderIdentity(proof.actualSender), senderIdentity(parent.initiatingActor))) {
          throw Error("request-context return is not from the initiating actor");
        }
      }
      for (const key of ["rootEvidenceRef", "initiatingActor", "ingress", "sourceAudience", "returnAudience"] as const) {
        if (!same(parent[key] ?? null, context[key] ?? null)) throw Error("request-context continuation changed provenance");
      }
      if (active && active.context.ref.rootContextId !== context.ref.rootContextId) throw new RequestContextInputDeferred();
    } else if (proof.kind === "recovery") {
      if (active) throw new RequestContextInputDeferred();
      const pointer = this.ports.recovery();
      if (!pointer || pointer.instance !== owner.instance || pointer.incarnation !== owner.incarnation || pointer.workGeneration !== owner.workGeneration) {
        throw Error("request-context recovery has no trustworthy parent or conservative scope");
      }
      const previous = this.ports.context(pointer.contextId);
      if (!previous || !outside(previous) || previous.source.instance !== pointer.instance || previous.source.incarnation !== pointer.incarnation) throw Error("request-context recovery scope unavailable");
      const id = randomUUID(); diagnostic = previous.ref.contextId;
      context = { ...previous, ref: { version: 1, contextId: id, rootContextId: id },
        rootEvidenceRef: `unproved-recovery:${id}`, initiatingActor: { kind: "unknown", reason: "unproved-recovery" },
        source: { instance: owner.instance, incarnation: owner.incarnation } };
    } else {
      if (!context || context.ref.parentContextId || context.ref.contextId !== context.ref.rootContextId) throw Error("request-context independent input requires a new root");
      if (active) throw new RequestContextInputDeferred();
    }
    if (!context || context.source.instance !== owner.instance || context.source.incarnation !== owner.incarnation) throw Error("request-context input destination changed");
    this.ports.retain(context);
    if (outside(context)) this.ports.saveRecovery({ instance: owner.instance, incarnation: owner.incarnation,
      workGeneration: owner.workGeneration, contextId: context.ref.contextId });
    else if (proof.kind === "independent") this.ports.saveRecovery(null);
    // A join does not create a second active turn or change the token used by in-flight calls.
    if (active) return active;
    this.active = freeze({ token: randomUUID(), inputId: input.inputId, wireSha256, owner: structuredClone(owner), context: structuredClone(context),
      ...(diagnostic ? { unprovedRecoveryFrom: diagnostic } : {}) });
    return this.active;
  }
  /** Only an exact owned end/cancel proof retires this binding; idle/age/answer publication are not proofs. */
  ended(snapshot: RequestContextTurnSnapshot, owner: RequestContextRuntimeOwner): boolean {
    if (!this.isCurrent(snapshot, owner)) return false;
    this.active = null; return true;
  }
  /** Stop/fresh-runtime fences retire active memory, never reinterpret old work as an owner root. */
  fence(): void { this.active = null; }
}
