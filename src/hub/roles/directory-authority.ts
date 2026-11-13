/** Ephemeral server proof for directory preparation; never a request-body capability. */
import { canonicalArguments } from "../identity.js";
import { parseHubDirectoryDecisionMetadata, type HubDirectoryDecisionRequest } from "../settings-directory-decision.js";
import { epoch, hash, HubProtocolError, person, validated } from "../validation.js";
import type { HubDirectoryManagementPreparation, HubManagementPermit } from "./authority.js";
import type { PersonKey } from "../types.js";
import type { HubDirectoryDecisionProof } from "../directory-decision-proof.js";

type Administrator = Extract<HubDirectoryDecisionRequest["actor"], { kind: "hub-administrator" }>;
export interface HubDirectoryAdministration { readonly directoryAdministration: true }
/** Preparation identity only; settings writers never accept this handle as administration. */
export interface HubDirectoryPreparation { readonly directoryPreparation: true }
export interface HubDirectoryAdministrationBinding {
  directory: object; administrator: PersonKey; image: string; epoch: number;
  /** Exact mounted decision's callback-local getter. Omission retains the strict ordinary path. */
  decisionProof?(): HubDirectoryDecisionProof | null;
}
interface Proof {
  actor: Administrator;
  permit: HubManagementPermit;
  method: HubManagementPermit["assertCurrent"];
  decisionMethod: HubManagementPermit["assertDirectoryDecision"];
  frame: HubDirectoryAdministrationBinding["decisionProof"];
  image: string;
  binding: HubDirectoryAdministrationBinding;
  retired: boolean;
}
const proofs = new WeakMap<HubDirectoryAdministration, Proof>();
interface Preparation {
  actor: Administrator; preparation: HubDirectoryManagementPreparation;
  check: HubDirectoryManagementPreparation["assertCurrent"]; authorize: HubDirectoryManagementPreparation["authorize"];
  retire: HubDirectoryManagementPreparation["retire"]; binding: HubDirectoryAdministrationBinding;
  frame: HubDirectoryAdministrationBinding["decisionProof"]; retired: boolean; running: boolean;
}
const preparations = new WeakMap<HubDirectoryPreparation, Preparation>();
const image = (permit: HubManagementPermit) => canonicalArguments({ actor: permit.actor, permission: permit.permission, source: permit.source, expiresAt: permit.expiresAt });
function synchronous(value: unknown): void {
  if (value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
    void Promise.resolve(value).catch(() => {}); throw new HubProtocolError("unavailable");
  }
}
const actorOf = (raw: Administrator): Administrator => {
  const actor = parseHubDirectoryDecisionMetadata({ actor: raw, changes: ["search"], recipients: [{ kind: "host", sink: "owner" }] }).actor;
  if (actor.kind !== "hub-administrator") throw new HubProtocolError("denied");
  return Object.freeze({ ...actor, person: Object.freeze(actor.person) });
};

export function bindHubDirectoryPreparation(preparation: HubDirectoryManagementPreparation, raw: Administrator,
  source: HubDirectoryAdministrationBinding): HubDirectoryPreparation {
  const actor = actorOf(raw);
  if (preparation.actor.kind !== "directory" || preparation.actor.sessionId !== actor.sessionId || preparation.requestId !== actor.requestId
    || canonicalArguments(preparation.actor.person) !== canonicalArguments(actor.person)
    || typeof preparation.assertCurrent !== "function" || typeof preparation.authorize !== "function" || typeof preparation.retire !== "function"
    || source.decisionProof !== undefined && typeof source.decisionProof !== "function"
    || actor.person.realm !== source.administrator.realm || preparation.directory !== source.directory
    || canonicalArguments(preparation.administrator) !== canonicalArguments(source.administrator)) throw new HubProtocolError("denied");
  const handle = Object.freeze({ directoryPreparation: true as const });
  preparations.set(handle, { actor, preparation, check: preparation.assertCurrent, authorize: preparation.authorize, retire: preparation.retire,
    binding: { directory: source.directory, administrator: Object.freeze(validated(person, source.administrator)), image: validated(hash, source.image), epoch: validated(epoch, source.epoch) },
    frame: source.decisionProof, retired: false, running: false });
  assertHubDirectoryPreparation(handle, actor, source); return handle;
}
function preparationState(handle: HubDirectoryPreparation, actor: HubDirectoryDecisionRequest["actor"], source: HubDirectoryAdministrationBinding): Preparation {
  const state = preparations.get(handle);
  if (!state) throw new HubProtocolError("denied");
  try {
    if (state.retired || canonicalArguments(actor) !== canonicalArguments(state.actor)
      || state.preparation.assertCurrent !== state.check || state.preparation.authorize !== state.authorize || state.preparation.retire !== state.retire
      || state.preparation.actor.kind !== "directory" || state.preparation.actor.sessionId !== state.actor.sessionId
      || state.preparation.requestId !== state.actor.requestId
      || canonicalArguments(state.preparation.actor.person) !== canonicalArguments(state.actor.person)
      || state.preparation.directory !== state.binding.directory || canonicalArguments(state.preparation.administrator) !== canonicalArguments(state.binding.administrator)
      || source.directory !== state.binding.directory || source.image !== state.binding.image || source.epoch !== state.binding.epoch
      || source.decisionProof !== state.frame || canonicalArguments(source.administrator) !== canonicalArguments(state.binding.administrator)) throw new HubProtocolError("denied");
    return state;
  } catch (error) { state.retired = true; state.retire.call(state.preparation); throw error; }
}
export function assertHubDirectoryPreparation(handle: HubDirectoryPreparation, actor: HubDirectoryDecisionRequest["actor"], source: HubDirectoryAdministrationBinding): void {
  const state = preparationState(handle, actor, source);
  try {
    synchronous(state.check.call(state.preparation)); preparationState(handle, actor, source);
  } catch (error) { state.retired = true; state.retire.call(state.preparation); throw error; }
}
/** Consumes the operation after physical eligibility settlement; only the NEW named proof reaches the writer. */
export async function authorizeHubDirectoryPreparation(handle: HubDirectoryPreparation, actor: HubDirectoryDecisionRequest["actor"],
  source: HubDirectoryAdministrationBinding): Promise<HubDirectoryAdministration> {
  assertHubDirectoryPreparation(handle, actor, source);
  const state = preparationState(handle, actor, source);
  if (state.running) throw new HubProtocolError("backpressure");
  state.running = true;
  try {
    const permit = await state.authorize.call(state.preparation); preparationState(handle, actor, source);
    return bindHubDirectoryAdministration(permit, state.actor, source);
  } finally { state.retired = true; state.retire.call(state.preparation); }
}

/** Caller has already acquired this actual session's named management permit. No role lookup is invented here. */
export function bindHubDirectoryAdministration(permit: HubManagementPermit, raw: Administrator, source: HubDirectoryAdministrationBinding): HubDirectoryAdministration {
  const actor = actorOf(raw);
  if (permit.permission !== "hub.admin" || !["roles", "legacy"].includes(permit.source) || permit.actor.kind !== "directory"
    || permit.actor.sessionId !== actor.sessionId || canonicalArguments(permit.actor.person) !== canonicalArguments(actor.person)
    || typeof permit.assertCurrent !== "function" || source.decisionProof !== undefined && typeof source.decisionProof !== "function") throw new HubProtocolError("denied");
  const handle = Object.freeze({ directoryAdministration: true as const });
  const binding = { directory: source.directory, administrator: Object.freeze(validated(person, source.administrator)), image: validated(hash, source.image), epoch: validated(epoch, source.epoch) };
  if (actor.person.realm !== binding.administrator.realm) throw new HubProtocolError("denied");
  proofs.set(handle, { actor, permit, method: permit.assertCurrent, decisionMethod: permit.assertDirectoryDecision,
    frame: source.decisionProof, image: image(permit), binding, retired: false });
  assertHubDirectoryAdministration(handle, actor, source); return handle;
}

/** Opaque identity, exact actor/request and original method; an observed failure permanently retires this operation. */
export function assertHubDirectoryAdministration(handle: HubDirectoryAdministration, raw: HubDirectoryDecisionRequest["actor"], source: HubDirectoryAdministrationBinding): number | undefined {
  const state = proofs.get(handle);
  if (!state) throw new HubProtocolError("denied");
  try {
    const check = () => {
      if (state.retired || canonicalArguments(raw) !== canonicalArguments(state.actor)
        || state.permit.assertCurrent !== state.method || state.permit.assertDirectoryDecision !== state.decisionMethod || image(state.permit) !== state.image
        || source.decisionProof !== state.frame || state.binding.directory !== source.directory || state.binding.image !== source.image || state.binding.epoch !== source.epoch
        || canonicalArguments(state.binding.administrator) !== canonicalArguments(source.administrator)) throw new HubProtocolError("denied");
    };
    check();
    const frame = state.frame ? state.frame.call(source) : null;
    synchronous(frame);
    check();
    if (frame === undefined) throw new HubProtocolError("unavailable");
    let answer: unknown;
    if (frame === null) answer = state.method.call(state.permit);
    else {
      if (typeof state.decisionMethod !== "function") throw new HubProtocolError("unavailable");
      answer = state.decisionMethod.call(state.permit, frame);
    }
    synchronous(answer);
    check();
    return typeof answer === "number" ? answer : undefined;
  } catch (error) { state.retired = true; throw error; }
}

/** The old no-witness path is configured-root/D3 only. A host identity never consumes a browser admin witness. */
export function assertHubDirectoryActor(context: { actor: HubDirectoryDecisionRequest["actor"]; administration?: HubDirectoryAdministration; preparation?: HubDirectoryPreparation },
  source: HubDirectoryAdministrationBinding, preparationOnly = false): void {
  if (context.actor.kind === "host-owner") {
    if (context.administration !== undefined || context.preparation !== undefined) throw new HubProtocolError("denied");
  } else if (context.preparation !== undefined) {
    if (!preparationOnly || context.administration !== undefined) throw new HubProtocolError("denied");
    assertHubDirectoryPreparation(context.preparation, context.actor, source);
  } else if (context.administration !== undefined) assertHubDirectoryAdministration(context.administration, context.actor, source);
  else if (canonicalArguments(context.actor.person) !== canonicalArguments(source.administrator)) throw new HubProtocolError("denied");
}
