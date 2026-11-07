/** Read, bounded group resolution and exact-resource resume. Preview/apply and HTTP composition live in the next slice. */
import type { HubDirectory } from "../directory/types.js";
import { personKeyString } from "../identity.js";
import { HubProtocolError, person, validated } from "../validation.js";
import { createHubGroupAdminBoundary } from "./admin-context.js";
import type { HubGroupAdminInventory } from "./admin-inventory.js";
import type { HubGroupAuthorization } from "./authorization.js";
import { HubGroupAuthorizationError } from "./authorization.js";
import type { HubGroupPolicyBinding, HubGroupPolicyStore } from "./store.js";
import { HubGroupPolicyError } from "./store.js";
import { resolveRequest, resumeRequest, type GroupPolicyReadResponse, type GroupResolveResponse,
  type GroupResumeResponse, type HubGroupAdminControl } from "./admin-dto.js";
import type { PersonKey } from "../types.js";

export function createHubGroupAdminReads(options: {
  administrator: PersonKey; directory: HubDirectory; current(): boolean;
  binding(): HubGroupPolicyBinding; policy(): HubGroupPolicyStore;
  inventory: HubGroupAdminInventory; authorization: Pick<HubGroupAuthorization, "resume">;
}) {
  const administrator = validated(person, options.administrator), boundary = createHubGroupAdminBoundary(options);
  const { directory, inventory, authorization, binding, policy } = options;
  const supported = () => directory.realm === administrator.realm && directory.groupPolicy === "ad-direct-guid"
    && typeof directory.resolvePolicyGroup === "function" && typeof directory.readPolicyGroups === "function";
  const read: HubGroupAdminControl["read"] = async (incoming): Promise<GroupPolicyReadResponse> => {
    const { ctx } = await boundary.begin(incoming);
    if (binding().kind !== "ready") return { ok: true, groupPolicyV1: true, supported: supported(), binding: "repair-required", policy: null, paused: [] };
    const selected = policy(), saved = selected.read(), paused = inventory.paused().map(({ item, lifecycleRevision }) => ({
      resource: { kind: item.resource.kind, id: item.resource.id, revision: item.resource.revision },
      label: item.display.label, owner: item.display.owner, lifecycleRevision }));
    boundary.assertCurrent(ctx);
    if (binding().kind !== "ready" || policy() !== selected || JSON.stringify(selected.read()) !== JSON.stringify(saved)) throw new HubGroupPolicyError("conflict");
    return { ok: true, groupPolicyV1: true, supported: supported(), binding: "ready", policy: saved, paused };
  };
  const resolve: HubGroupAdminControl["resolve"] = async (input, incoming): Promise<GroupResolveResponse> => {
    const request = validated(resolveRequest, input), { ctx } = await boundary.begin(incoming);
    if (!supported()) return { ok: false, reason: "unsupported" };
    let result: GroupResolveResponse = { ok: false, reason: "unknown" };
    try {
      const found = await directory.resolvePolicyGroup!(request.dn);
      if (found.ok) {
        const key = validated(person, found.group.key), canonical = validated(resolveRequest, { dn: found.group.dn }).dn;
        if (key.realm === administrator.realm) result = { ok: true, realm: key.realm, objectId: key.objectId, dn: canonical };
      } else if (["unsupported", "invalid", "not-found", "not-security-group", "unknown"].includes(found.reason)) result = { ok: false, reason: found.reason };
    } catch { /* A failed or malformed driver result is bounded unknown, never a diagnostic string. */ }
    // Authentication/eligibility are rechecked after directory I/O, never inferred from the typed DN.
    await boundary.authenticate(ctx); boundary.assertCurrent(ctx);
    return result;
  };
  const resume: HubGroupAdminControl["resume"] = async (input, incoming): Promise<GroupResumeResponse> => {
    const request = validated(resumeRequest, input), { ctx, actor } = await boundary.begin(incoming);
    if (!supported() || binding().kind !== "ready") return { ok: false, code: "unknown" };
    const selected = policy(), saved = selected.read(), item = inventory.current(request.resource), row = inventory.ledger(request.resource);
    if (saved.revision !== request.expectedPolicyRevision || !item || !row || row.state !== "suspended"
      || row.revision !== request.expectedLifecycleRevision || JSON.stringify(row.resource) !== JSON.stringify(item.resource)) return { ok: false, code: "conflict" };
    const stillCurrent = () => {
      try {
        boundary.assertCurrent(ctx);
        return binding().kind === "ready" && policy() === selected && selected.read().revision === saved.revision
          && inventory.current(request.resource)?.fingerprint === item.fingerprint;
      } catch { return false; }
    };
    try {
      const permit = await authorization.resume(item.resource, { requestId: ctx.requestId, current: stillCurrent, async requireAdmin() {
        const fresh = await boundary.authenticate(ctx);
        if (fresh.sessionId !== actor.sessionId || personKeyString(fresh.person) !== personKeyString(actor.person)) throw new HubProtocolError("denied");
        return fresh;
      } });
      permit.assertCurrent(); boundary.assertCurrent(ctx);
      const after = inventory.ledger(request.resource);
      if (!stillCurrent() || !after || after.state !== "active" || after.revision !== request.expectedLifecycleRevision + 1) throw new HubGroupPolicyError("conflict");
      return { ok: true, resource: request.resource, state: "active", policyRevision: saved.revision, lifecycleRevision: after.revision };
    } catch (error) {
      if (error instanceof HubGroupAuthorizationError) return { ok: false, code: error.reason === "denied" ? "denied" : "unknown" };
      if (error instanceof HubGroupPolicyError) return { ok: false, code: error.code === "conflict" || error.code === "invalid" ? "conflict" : "unknown" };
      if (error instanceof HubProtocolError && error.code === "denied") return { ok: false, code: "denied" };
      throw error;
    }
  };
  return { read, resolve, resume, close: () => boundary.close() };
}
