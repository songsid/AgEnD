/** Explicit synchronous directory-decision scope. It never changes an ordinary policy/permit reader. */
import type Database from "better-sqlite3";
import type { HubTransportStore } from "./store.js";
import type { HubDirectoryDecisionRequest, HubDirectorySettingsOperation } from "./settings-directory-decision.js";
import { canonicalArguments, sha256 } from "./identity.js";
import { parseCanonicalPolicy, rebindCanonicalPolicy } from "./roles/read.js";
import { readHubSessionEpoch } from "./session-epoch.js";
import { HubProtocolError, identifier, validated } from "./validation.js";

export interface HubDirectoryDecisionProof { readonly directoryDecisionProof: true }
interface Scope {
  db: Database.Database;
  transport: Pick<HubTransportStore, "read">;
  hubId: string;
  request: HubDirectoryDecisionRequest;
  beforeRaw: string;
  operation?: HubDirectorySettingsOperation;
}
interface Frame extends Scope {
  active: boolean;
  method: HubTransportStore["read"];
  currentRaw: string;
  transportImage: string;
}
const frames = new WeakMap<HubDirectoryDecisionProof, Frame>();
function fail(): never { throw new HubProtocolError("unavailable"); }
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);

/** Only the decision kernel calls this with its parsed immutable request and exact SQL participant. */
export function withHubDirectoryDecisionProof<T>(input: Scope, work: (proof: HubDirectoryDecisionProof) => T): T {
  const before = parseCanonicalPolicy(input.beforeRaw), request = structuredClone(input.request);
  const currentRaw = input.operation ? rebindCanonicalPolicy(before, request.generation).raw : input.beforeRaw;
  const proof = Object.freeze({ directoryDecisionProof: true as const });
  const state: Frame = { ...input, hubId: validated(identifier, input.hubId), request, beforeRaw: input.beforeRaw,
    ...(input.operation ? { operation: structuredClone(input.operation) } : {}), active: true, method: input.transport.read,
    currentRaw, transportImage: JSON.stringify(input.transport.read()) };
  frames.set(proof, state);
  try {
    inspectHubDirectoryDecisionProof(proof, { db: state.db, hubId: state.hubId });
    const answer = work(proof);
    if (answer && (typeof answer === "object" || typeof answer === "function") && typeof (answer as { then?: unknown }).then === "function") {
      void Promise.resolve(answer).catch(() => {}); throw new HubProtocolError("invalid");
    }
    inspectHubDirectoryDecisionProof(proof, { db: state.db, hubId: state.hubId });
    return answer;
  } finally { state.active = false; }
}

/** Fresh exact SQL view; copied JSON data returned here is not a reusable capability. */
export function inspectHubDirectoryDecisionProof(proof: HubDirectoryDecisionProof, binding: {
  db: Database.Database; hubId: string; actor?: HubDirectoryDecisionRequest["actor"];
}) {
  const state = frames.get(proof);
  try {
    if (!state || !state.active || state.db !== binding.db || state.hubId !== binding.hubId || !state.db.inTransaction
      || state.transport.read !== state.method || binding.actor !== undefined && !same(binding.actor, state.request.actor)) fail();
    const { db, request, operation } = state, before = parseCanonicalPolicy(state.beforeRaw);
    const row = db.prepare("SELECT hub_id,body FROM hub_group_policy WHERE singleton=1").get() as { hub_id: string; body: string } | undefined;
    const head = db.prepare("SELECT operation_id,directory_epoch FROM hub_settings_head WHERE singleton=1").get() as { operation_id: string | null; directory_epoch: number } | undefined;
    const transport = state.method.call(state.transport), offset = operation ? 1 : 0;
    if (row?.hub_id !== state.hubId || row.body !== state.currentRaw || sha256(state.beforeRaw) !== request.expected.policySha
      || !head || head.operation_id !== request.expected.operationId || head.directory_epoch !== request.expected.directoryEpoch
      || readHubSessionEpoch(db) !== request.expected.directoryEpoch
      || transport.revision !== request.expected.transportRevision + offset || transport.revocationVersion !== request.expected.authorizationVersion + offset
      || JSON.stringify(transport) !== state.transportImage) fail();
    const stored = db.prepare("SELECT body FROM hub_settings_operations WHERE id=?").get(request.id) as { body: string } | undefined;
    if (operation ? !stored || stored.body !== JSON.stringify(operation) || operation.id !== request.id || !same(operation.actor, request.actor)
      || operation.directoryEpoch !== request.expected.directoryEpoch + 1 || operation.authorizationVersion !== request.expected.authorizationVersion + 1
      : stored !== undefined) fail();
    if (!state.active || state.transport.read !== state.method) fail();
    return Object.freeze({ before, current: parseCanonicalPolicy(state.currentRaw), expected: Object.freeze(structuredClone(request.expected)),
      actor: structuredClone(request.actor), phase: operation ? "final" as const : "initial" as const });
  } catch { return fail(); }
}
