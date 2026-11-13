/** Ephemeral server proof for directory preparation; never a request-body capability. */
import { canonicalArguments } from "../identity.js";
import { parseHubDirectoryDecisionMetadata, type HubDirectoryDecisionRequest } from "../settings-directory-decision.js";
import { epoch, hash, HubProtocolError, person, validated } from "../validation.js";
import type { HubManagementPermit } from "./authority.js";
import type { PersonKey } from "../types.js";

type Administrator = Extract<HubDirectoryDecisionRequest["actor"], { kind: "hub-administrator" }>;
export interface HubDirectoryAdministration { readonly directoryAdministration: true }
export interface HubDirectoryAdministrationBinding { directory: object; administrator: PersonKey; image: string; epoch: number }
interface Proof {
  actor: Administrator;
  permit: HubManagementPermit;
  method: HubManagementPermit["assertCurrent"];
  image: string;
  binding: HubDirectoryAdministrationBinding;
  retired: boolean;
}
const proofs = new WeakMap<HubDirectoryAdministration, Proof>();
const image = (permit: HubManagementPermit) => canonicalArguments({ actor: permit.actor, permission: permit.permission, source: permit.source, expiresAt: permit.expiresAt });
const actorOf = (raw: Administrator): Administrator => {
  const actor = parseHubDirectoryDecisionMetadata({ actor: raw, changes: ["search"], recipients: [{ kind: "host", sink: "owner" }] }).actor;
  if (actor.kind !== "hub-administrator") throw new HubProtocolError("denied");
  return Object.freeze({ ...actor, person: Object.freeze(actor.person) });
};

/** Caller has already acquired this actual session's named management permit. No role lookup is invented here. */
export function bindHubDirectoryAdministration(permit: HubManagementPermit, raw: Administrator, source: HubDirectoryAdministrationBinding): HubDirectoryAdministration {
  const actor = actorOf(raw);
  if (permit.permission !== "hub.admin" || !["roles", "legacy"].includes(permit.source) || permit.actor.kind !== "directory"
    || permit.actor.sessionId !== actor.sessionId || canonicalArguments(permit.actor.person) !== canonicalArguments(actor.person)
    || typeof permit.assertCurrent !== "function") throw new HubProtocolError("denied");
  const handle = Object.freeze({ directoryAdministration: true as const });
  const binding = { directory: source.directory, administrator: Object.freeze(validated(person, source.administrator)), image: validated(hash, source.image), epoch: validated(epoch, source.epoch) };
  if (actor.person.realm !== binding.administrator.realm) throw new HubProtocolError("denied");
  proofs.set(handle, { actor, permit, method: permit.assertCurrent, image: image(permit), binding, retired: false });
  assertHubDirectoryAdministration(handle, actor, source); return handle;
}

/** Opaque identity, exact actor/request and original method; an observed failure permanently retires this operation. */
export function assertHubDirectoryAdministration(handle: HubDirectoryAdministration, raw: HubDirectoryDecisionRequest["actor"], source: HubDirectoryAdministrationBinding): void {
  const state = proofs.get(handle);
  if (!state) throw new HubProtocolError("denied");
  try {
    if (state.retired || canonicalArguments(raw) !== canonicalArguments(state.actor)
      || state.permit.assertCurrent !== state.method || image(state.permit) !== state.image
      || state.binding.directory !== source.directory || state.binding.image !== source.image || state.binding.epoch !== source.epoch
      || canonicalArguments(state.binding.administrator) !== canonicalArguments(source.administrator)) throw new HubProtocolError("denied");
    const answer: unknown = state.method.call(state.permit);
    if (answer && (typeof answer === "object" || typeof answer === "function") && typeof (answer as { then?: unknown }).then === "function") {
      void Promise.resolve(answer).catch(() => {}); throw new HubProtocolError("unavailable");
    }
  } catch (error) { state.retired = true; throw error; }
}

/** The old no-witness path is configured-root/D3 only. A host identity never consumes a browser admin witness. */
export function assertHubDirectoryActor(context: { actor: HubDirectoryDecisionRequest["actor"]; administration?: HubDirectoryAdministration }, source: HubDirectoryAdministrationBinding): void {
  if (context.actor.kind === "host-owner") {
    if (context.administration !== undefined) throw new HubProtocolError("denied");
  } else if (context.administration !== undefined) assertHubDirectoryAdministration(context.administration, context.actor, source);
  else if (canonicalArguments(context.actor.person) !== canonicalArguments(source.administrator)) throw new HubProtocolError("denied");
}
