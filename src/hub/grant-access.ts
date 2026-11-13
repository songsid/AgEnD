/** One operation's owner-grant subject proof. No ambient membership cache or browser-session dependency in durable phases. */
import { personKeyString } from "./identity.js";
import { HubProtocolError, person, uuid, validated } from "./validation.js";
import type { HubGrant, PersonKey } from "./types.js";
import type { GroupCheckContext } from "./group-policy/store.js";
import type { PolicyGroupFacts } from "./directory/groups.js";
import type { HubCore, HubOperationPermit } from "./http/core.js";
import { grantOf, readGrant } from "./catalog.js";

export interface HubGrantSubjectProof extends HubOperationPermit {
  readonly expiresAt: number;
  allows(grant: HubGrant, asker: PersonKey): boolean;
}
const same = (a: PersonKey, b: PersonKey) => personKeyString(a) === personKeyString(b);
const bytes = (g: HubGrant) => JSON.stringify(g);
/** One bounded directory observation can prove several grant subjects for the SAME asker in one catalog operation. */
export async function prepareGrantAccess(core: HubCore, ids: readonly string[], input: PersonKey, incoming: GroupCheckContext): Promise<HubGrantSubjectProof> {
  const time = () => { const at = core.now(); if (!Number.isSafeInteger(at) || at < 0) throw new HubProtocolError("unavailable"); return at; };
  const asker = Object.freeze({ ...validated(person, input) }), current = incoming.current.bind(incoming);
  const ctx = { requestId: incoming.requestId, current: () => core.live() && current() === true };
  const assertContext = () => { core.check(); if (!ctx.current()) throw new HubProtocolError("revoked"); };
  assertContext();
  const grants = core.atomic(db => new Map([...new Set(ids.map(id => validated(uuid, id)))].map(id => {
    const row = readGrant(db, id); return [id, row ? grantOf(row) : null] as const;
  })));
  const epoch = core.revocationVersion(), directory = core.deps.directory, read = directory.readPolicyGroups;
  const groupNeeded = [...grants.values()].some(g => g?.subject.kind === "group" && g.state === "active" && g.startsAt <= time() && time() < g.expiresAt);
  let facts: PolicyGroupFacts = { kind: "unknown" }, physical: HubOperationPermit | undefined;
  if (groupNeeded) {
    if (directory.groupPolicy !== "ad-direct-guid" || !read || directory.realm !== asker.realm) throw new HubProtocolError("unavailable");
    const started = time();
    const observed = await core.grantDirectoryRead(asker, ctx, () => read.call(directory, asker));
    physical = observed.permit; const value = observed.value, finished = time();
    if (value.kind === "unknown" || !same(validated(person, value.person), asker) || !Number.isSafeInteger(value.observedAt)
      || value.observedAt < started || value.observedAt > finished) throw new HubProtocolError("unavailable");
    if (value.kind === "ineligible") {
      if (value.reason !== "gone" && value.reason !== "disabled") throw new HubProtocolError("unavailable");
      throw new HubProtocolError("revoked");
    }
    if (!Array.isArray(value.groups) || value.groups.length > 256 || value.groups.some(id => !uuid.safeParse(id).success)) throw new HubProtocolError("unavailable");
    facts = { kind: "complete", person: asker, groups: Object.freeze([...new Set(value.groups)]), observedAt: value.observedAt };
  }
  // A finite operation proof, not a session grant. Each use is also bounded by THAT grant's own recorded expiry.
  const created = time();
  let deadline = Math.min(created + 5_000, facts.kind === "complete" ? facts.observedAt + 5_000 : Infinity);
  for (const g of grants.values()) if (g && g.state === "active" && g.startsAt <= created && created < g.expiresAt
    && (g.subject.kind === "person" ? same(g.subject.person, asker) : facts.kind === "complete" && g.subject.group.realm === asker.realm && facts.groups.includes(g.subject.group.objectId))) deadline = Math.min(deadline, g.expiresAt);
  if (facts.kind === "complete" && facts.observedAt > created) throw new HubProtocolError("unavailable");
  const used = new Map<string, HubGrant>();
  const assertCurrent = () => {
    assertContext(); physical?.assertCurrent();
    core.atomic(db => { for (const [id, g] of used) {
      const row = readGrant(db, id);
      if (!row || bytes(grantOf(row)) !== bytes(g) || time() < g.startsAt || time() >= g.expiresAt) throw new HubProtocolError("revoked");
    } });
    if (time() < created || time() >= deadline || core.revocationVersion() !== epoch || core.deps.directory !== directory
      || (groupNeeded && directory.readPolicyGroups !== read)) throw new HubProtocolError("unavailable");
  };
  const proof: HubGrantSubjectProof = { expiresAt: deadline, assertCurrent, allows(g, who) {
    assertCurrent();
    const captured = grants.get(g.id), now = time();
    if (!same(who, asker) || !captured || bytes(captured) !== bytes(g) || g.state !== "active" || now < g.startsAt || now >= g.expiresAt) return false;
    const match = g.subject.kind === "person" ? same(g.subject.person, asker)
      : g.subject.group.realm === asker.realm && facts.kind === "complete" && facts.groups.includes(g.subject.group.objectId);
    if (!match) return false;
    const fresh = core.atomic(db => readGrant(db, g.id));
    if (!fresh || bytes(grantOf(fresh)) !== bytes(g)) return false;
    used.set(g.id, g); return true;
  } };
  assertCurrent(); return Object.freeze(proof);
}
