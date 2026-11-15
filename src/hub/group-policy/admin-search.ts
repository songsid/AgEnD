/** Feedback only: bounded suggestions never replace GUID resolve/preview/apply. */
import { z } from "zod";
import type { HubDirectory, PersonKey } from "../types.js";
import { personKeyString } from "../identity.js";
import { HubProtocolError, person, uuid, plain, validated } from "../validation.js";
import { DIRECTORY_FAILURES } from "../directory/groups.js";
import { createHubGroupAdminBoundary } from "./admin-context.js";
import { resolveRequest, searchRequest, type GroupAdminContext, type GroupSearchResponse, type AllowedPeopleSearchResponse } from "./admin-dto.js";
import type { HubGroupPolicyBinding, HubGroupPolicyStore } from "./store.js";
const groupShape = z.strictObject({ objectId: uuid, cn: plain(1024).refine(s => s.length > 0 && s.length <= 256 && !/[\u0000-\u001f\u007f]/.test(s)), dn: resolveRequest.shape.dn });
export function createHubGroupAdminSearch(options: {
  administrator: PersonKey; directory: HubDirectory; current(): boolean;
  binding(): HubGroupPolicyBinding; policy(): HubGroupPolicyStore; now?(): number;
}) {
  const administrator = validated(person, options.administrator), boundary = createHubGroupAdminBoundary(options);
  const { directory, binding, policy } = options;
  const searches = new Map<string, { since: number; count: number }>();
  const admit = (actor: { person: PersonKey; sessionId: string }): boolean => {
    const at = options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new HubProtocolError("unavailable");
    for (const [key, row] of searches) if (at < row.since || at - row.since >= 60_000) searches.delete(key);
    const key = JSON.stringify([personKeyString(actor.person), actor.sessionId]), bucket = searches.get(key);
    if (bucket ? bucket.count >= 30 : searches.size >= 1024) return false;
    searches.set(key, { since: bucket?.since ?? at, count: (bucket?.count ?? 0) + 1 });
    return true;
  };
  const search = async (input: unknown, incoming: GroupAdminContext): Promise<GroupSearchResponse> => {
    const request = validated(searchRequest, input), { ctx, actor } = await boundary.begin(incoming);
    if (directory.realm !== administrator.realm || directory.groupPolicy !== "ad-direct-guid"
      || typeof directory.searchPolicyGroups !== "function") return { ok: false, reason: "unsupported" };
    if (!admit(actor)) return { ok: false, reason: "limited" };
    if (binding().kind !== "ready") return { ok: false, reason: "unknown" };
    let selected: HubGroupPolicyStore, image: string, generation: string;
    try { selected = policy(); image = JSON.stringify(selected.read()); generation = JSON.stringify(binding()); }
    catch { boundary.assertCurrent(ctx); return { ok: false, reason: "unknown" }; }
    const lookup = directory.searchPolicyGroups;
    const current = () => {
      boundary.assertCurrent(ctx);
      if (policy() !== selected || JSON.stringify(selected.read()) !== image || JSON.stringify(binding()) !== generation
        || directory.searchPolicyGroups !== lookup) throw new HubProtocolError("unavailable");
    };
    let result: GroupSearchResponse = { ok: false, reason: "unknown" };
    try {
      current();
      const found = await selected.withDirectoryRead(actor.person, () => lookup.call(directory, request.q));
      if (found.ok) {
        // Snapshot before the final authentication await; mutable driver DTOs never leak through.
        const groups = validated(z.array(groupShape).max(20), found.groups);
        if (new Set(groups.map(g => g.objectId)).size !== groups.length || typeof found.truncated !== "boolean") throw new HubProtocolError("invalid");
        result = { ok: true, groups, truncated: found.truncated };
      } else if (found.reason === "unsupported") result = { ok: false, reason: "unsupported" };
      else result = { ok: false, reason: "unknown", ...(found.failure && DIRECTORY_FAILURES.includes(found.failure) ? { failure: found.failure } : {}) };
    } catch { /* The physical read AND close have settled; failures and pool overload stay bounded. */ }
    const fresh = await boundary.authenticate(ctx);
    if (fresh.sessionId !== actor.sessionId || personKeyString(fresh.person) !== personKeyString(actor.person)) throw new HubProtocolError("denied");
    current(); return result;
  };
  const searchPeople = async (input: unknown, incoming: GroupAdminContext): Promise<AllowedPeopleSearchResponse> => {
    const request = validated(searchRequest, input), { ctx, actor } = await boundary.begin(incoming);
    const lookup = directory.searchGrantPeople;
    if (directory.realm !== administrator.realm || directory.groupPolicy !== "ad-direct-guid" || !lookup) return { ok: false, reason: "unsupported" };
    if (!admit(actor)) return { ok: false, reason: "limited" };
    if (binding().kind !== "ready") return { ok: false, reason: "unknown" };
    let selected: HubGroupPolicyStore, image: string, generation: string;
    try { selected = policy(); image = JSON.stringify(selected.read()); generation = JSON.stringify(binding()); }
    catch { boundary.assertCurrent(ctx); return { ok: false, reason: "unknown" }; }
    const current = () => {
      boundary.assertCurrent(ctx);
      if (policy() !== selected || JSON.stringify(selected.read()) !== image || JSON.stringify(binding()) !== generation
        || directory.searchGrantPeople !== lookup) throw new HubProtocolError("unavailable");
    };
    let result: AllowedPeopleSearchResponse = { ok: false, reason: "unknown" };
    try {
      current(); const found = await selected.withDirectoryRead(actor.person, () => lookup.call(directory, request.q));
      if (found.ok) {
        const people = validated(z.array(z.strictObject({ person, login: plain(256).min(1), displayName: plain(256).min(1) })).max(20), found.people);
        if (people.some(row => row.person.realm !== administrator.realm) || new Set(people.map(row => personKeyString(row.person))).size !== people.length
          || typeof found.truncated !== "boolean") throw new HubProtocolError("invalid");
        result = { ok: true, people, truncated: found.truncated };
      }
    } catch { /* No lookup details or partial people escape the authenticated boundary. */ }
    const fresh = await boundary.authenticate(ctx);
    if (fresh.sessionId !== actor.sessionId || personKeyString(fresh.person) !== personKeyString(actor.person)) throw new HubProtocolError("denied");
    current(); return result;
  };
  return { search, searchPeople, close() { searches.clear(); boundary.close(); } };
}
