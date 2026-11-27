/** Operation-owned role proofs. Management and member room-creation entry points use separate catalogues. */
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { HubDirectory } from "../directory/types.js";
import { HubGroupReadOverload, type GroupCheckContext, type HubGroupPolicyStore } from "../group-policy/store.js";
import { personKeyString } from "../identity.js";
import type { HubActor, HubRequestContext, PersonKey } from "../types.js";
import { epoch, HubProtocolError, identifier, person, validated } from "../validation.js";
import { evaluateRolePolicy, snapshotRolePersonFacts, type RolePersonFacts } from "./evaluate.js";
import { MANAGEMENT_PERMISSIONS } from "./model.js";
import type { HubCanonicalPolicy } from "./read.js";

export type HubManagementPermission = typeof MANAGEMENT_PERMISSIONS[number];
export const HUB_MANAGEMENT_PROOF_TTL = 5_000;
const issuedManagementPermits = new WeakSet<object>();
/** Private in-process adapter attestation; copied actors and shape-compatible objects confer no permission. */
function issuedPermit(permit: unknown, permission: HubManagementPermission,
  actor: { person: PersonKey; sessionId: string }): HubManagementPermit {
  if (!permit || typeof permit !== "object" || !issuedManagementPermits.has(permit)) throw new HubProtocolError("denied");
  const proof = permit as HubManagementPermit;
  if (proof.permission !== permission || personKeyString(proof.actor.person) !== personKeyString(actor.person)
    || proof.actor.sessionId !== actor.sessionId) throw new HubProtocolError("denied");
  return proof;
}
export function assertHubManagementPermit(permit: unknown, permission: HubManagementPermission,
  actor: { person: PersonKey; sessionId: string }): asserts permit is HubManagementPermit {
  issuedPermit(permit, permission, actor).assertCurrent();
}
/** For a separately bounded operation: re-prove current graph/session/expiry, never extend an effect permit. */
export function assertHubManagementAttestation(permit: unknown, permission: HubManagementPermission,
  actor: { person: PersonKey; sessionId: string }): asserts permit is HubManagementPermit {
  const proof = issuedPermit(permit, permission, actor);
  if (!proof.assertAuthority) throw new HubProtocolError("denied");
  proof.assertAuthority();
}

const PREPARATION_BUDGET = 20_000;
type DirectoryActor = Extract<HubActor, { kind: "directory" }>;
type HubRoleOperationPermission = HubManagementPermission | "rooms.create";
export type HubManagementPermit = HubRoleOperationPermit<HubManagementPermission>;
export type HubRoomCreationPermit = HubRoleOperationPermit<"rooms.create">;
interface HubRoleOperationPermit<P extends HubRoleOperationPermission> {
  readonly actor: DirectoryActor;
  readonly permission: P;
  readonly source: "legacy" | "roles";
  readonly expiresAt: number;
  /** Mandatory before each effect/disclosure, including after any await or reentrant callback. */
  assertCurrent(): void;
  /** Re-prove authority at a long operation's checkpoints. Its own lifetime/authentication budgets still apply.
   * This is NOT a replacement for assertCurrent on a short-lived effect permit. */
  assertAuthority?(): void;
}
/** First issuance only: the issuer identity comes from the server's retained approval, never browser input. */
export interface HubJoinIssuerPermit {
  readonly approvedBy: PersonKey;
  readonly source: "legacy" | "roles";
  assertCurrent(): void;
}
export interface HubManagementAuthorityOptions {
  root: PersonKey;
  policy(): HubCanonicalPolicy;
  directory: Pick<HubDirectory, "realm" | "checkEligibility" | "readPolicyGroups" | "groupPolicy">;
  reads: Pick<HubGroupPolicyStore, "withDirectoryRead">;
  current(): boolean;
  /** Existing transport version, including its independent persistent floor. */
  version(): number;
  /** The real expiry settlement's persisted clock fence; synchronous and mandatory on role images. */
  assertAuthorizationTime(): void;
  now?: () => number;
  elapsedNow?: () => number;
}
function sync(result: unknown): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void Promise.resolve(result).catch(() => undefined); throw new HubProtocolError("unavailable");
  }
}
export function createHubManagementAuthority(options: HubManagementAuthorityOptions) {
  const { policy, directory, reads, current, version, assertAuthorizationTime } = options;
  const root = Object.freeze(validated(person, options.root)), method = directory.checkEligibility, groupsMethod = directory.readPolicyGroups, groupsProfile = directory.groupPolicy;
  const clock = options.now ?? Date.now, elapsedClock = options.elapsedNow ?? (() => performance.now());
  let closed = false, clockRetired = false, latestWall = 0, latestElapsed = 0;
  const time = () => {
    const wall = validated(epoch, clock()), elapsed = elapsedClock();
    if (!Number.isFinite(elapsed) || elapsed < latestElapsed || wall < latestWall) clockRetired = true;
    if (clockRetired) throw new HubProtocolError("unavailable");
    latestWall = wall; latestElapsed = elapsed; return { wall, elapsed };
  };
  const live = () => {
    if (closed || current() !== true || directory.realm !== root.realm || directory.checkEligibility !== method) throw new HubProtocolError("unavailable");
  };
  const read = () => {
    live(); const selected = policy();
    if (selected.policy.realm !== root.realm) throw new HubProtocolError("unavailable");
    if (selected.kind === "roles") sync(assertAuthorizationTime());
    validated(epoch, version()); return selected;
  };
  async function requirePermission<P extends HubRoleOperationPermission>(incoming: HubRequestContext, cap: P): Promise<HubRoleOperationPermit<P>> {
      validated(identifier, incoming.requestId);
      if (typeof incoming.current !== "function" || typeof incoming.isCurrent !== "function"
        || typeof incoming.isIdentityCurrent !== "function") throw new HubProtocolError("unavailable");
      const authenticate = incoming.current.bind(incoming), sessionCurrent = incoming.isCurrent.bind(incoming);
      const identityCurrent = incoming.isIdentityCurrent.bind(incoming), started = time(), before = read(), authEpoch = version();
      let retired = false, issued = false, actor: DirectoryActor | null = null;
      const common = () => {
        try {
          if (retired || sessionCurrent() !== true || cap === "rooms.create" && (directory.readPolicyGroups !== groupsMethod || directory.groupPolicy !== groupsProfile)) throw new HubProtocolError("unavailable");
          const at = time();
          if ((!issued && (at.wall - started.wall >= PREPARATION_BUDGET || at.elapsed - started.elapsed >= PREPARATION_BUDGET))
            || read().raw !== before.raw || version() !== authEpoch) throw new HubProtocolError("unavailable");
          if (actor && identityCurrent(actor.person, actor.sessionId) !== true) throw new HubProtocolError("unavailable");
          return at;
        } catch (error) { retired = true; throw error; }
      };
      const identity = async () => {
        common(); const found = await authenticate(); common();
        if (found.kind !== "directory") throw new HubProtocolError("denied");
        const who = Object.freeze(validated(person, found.person)), sessionId = validated(identifier, found.sessionId);
        if (who.realm !== root.realm || actor && (personKeyString(who) !== personKeyString(actor.person) || sessionId !== actor.sessionId)
          || identityCurrent(who, sessionId) !== true) throw new HubProtocolError("unavailable");
        actor = Object.freeze({ kind: "directory", person: who, sessionId });
      };
      await identity(); common(); const who = actor!.person;
      // A negative presentation hint need not spend another directory read when no live
      // assignment could grant this member operation. This does not authorize any effect.
      if (cap === "rooms.create" && (before.kind !== "roles" || !before.policy.rolesActive
        || !before.policy.assignments.some(a => a.startsAt <= common().wall && (a.expiresAt === null || a.expiresAt > common().wall)
          && (a.subject.kind === "group" || personKeyString(a.subject.person) === personKeyString(who))
          && before.policy.roles.find(r => r.id === a.roleId)!.permissions.includes("rooms.create")))) throw new HubProtocolError("denied");
      // Management assignments are persons-only and Hub-wide in the strict graph. Fresh eligibility is
      // sufficient; never invent an empty membership set or create a second directory-admission pool.
      let result;
      try { result = await reads.withDirectoryRead(who, async () => {
        const value = await method.call(directory, Object.freeze({ ...who }));
        return value.eligible === true ? { eligible: true as const, person: validated(person, value.person.key) }
          : { eligible: false as const, reason: value.eligible === false ? value.reason : "unavailable" };
      }); }
      catch (error) {
        if (error instanceof HubGroupReadOverload) throw new HubProtocolError("backpressure");
        throw new HubProtocolError("unavailable");
      }
      const observed = common(); await identity(); common();
      if (result.eligible !== true) throw new HubProtocolError(result.reason === "gone" || result.reason === "disabled" ? "denied" : "unavailable");
      if (personKeyString(result.person) !== personKeyString(who)) throw new HubProtocolError("unavailable");
      let facts: RolePersonFacts = Object.freeze({ kind: "eligible" as const, person: who, observedAt: observed.wall });
      // Creating a room is member-level: group assignments require fresh complete AD membership,
      // through the same physical admission pool as eligibility and all other role operations.
      const needsGroups = cap === "rooms.create" && before.kind === "roles" && before.policy.assignments.some(a =>
        a.subject.kind === "group" && a.startsAt <= observed.wall && (a.expiresAt === null || a.expiresAt > observed.wall)
        && before.policy.roles.find(r => r.id === a.roleId)!.permissions.includes("rooms.create"));
      if (needsGroups) {
        if (directory.groupPolicy !== "ad-direct-guid" || !groupsMethod) throw new HubProtocolError("unavailable");
        const startedGroups = common().wall;
        let groups;
        try { groups = await reads.withDirectoryRead(who, () => groupsMethod.call(directory, Object.freeze({ ...who }))); }
        catch (error) {
          if (error instanceof HubGroupReadOverload) throw new HubProtocolError("backpressure");
          throw new HubProtocolError("unavailable");
        }
        const snapshot = snapshotRolePersonFacts(groups, who, common().wall);
        if (!snapshot || snapshot.observedAt < startedGroups) throw new HubProtocolError("unavailable");
        if (snapshot.kind === "ineligible") throw new HubProtocolError("denied");
        if (snapshot.kind !== "complete") throw new HubProtocolError("unavailable");
        facts = Object.freeze({ ...snapshot, groups: Object.freeze([...snapshot.groups]) });
        await identity(); common();
      }
      const allowed = (at: number) => before.kind === "group" ? personKeyString(who) === personKeyString(root)
        : evaluateRolePolicy(before.policy, who, cap, null, { subject: facts }, at, root).outcome === "allow";
      if (!allowed(common().wall)) throw new HubProtocolError("denied");
      const authority = () => {
        try { const at = common(); if (!allowed(at.wall)) throw new HubProtocolError("denied"); return at; }
        catch (error) { retired = true; throw error; }
      };
      issued = true;
      const permit: HubRoleOperationPermit<P> = Object.freeze({ actor: actor!, permission: cap, source: before.kind === "group" ? "legacy" : "roles",
        expiresAt: observed.wall + HUB_MANAGEMENT_PROOF_TTL,
        assertAuthority() { authority(); },
        assertCurrent() {
          try {
            const at = authority();
            if (at.wall >= observed.wall + HUB_MANAGEMENT_PROOF_TTL || at.elapsed >= observed.elapsed + HUB_MANAGEMENT_PROOF_TTL
              || !allowed(at.wall)) throw new HubProtocolError("unavailable");
          } catch (error) { retired = true; throw error; }
        },
      });
      permit.assertCurrent(); if (cap !== "rooms.create") issuedManagementPermits.add(permit); return permit;
    }
  return {
    /** No fabricated browser session. Committed receipt recovery must run before requesting this fresh proof. */
    async requireJoinIssuer(input: PersonKey, incoming: GroupCheckContext): Promise<HubJoinIssuerPermit> {
      const who = Object.freeze(validated(person, input)); validated(identifier, incoming.requestId);
      if (who.realm !== root.realm || typeof incoming.current !== "function") throw new HubProtocolError("denied");
      const caller = incoming.current.bind(incoming), started = time(), before = read(), authEpoch = version();
      let retired = false;
      const common = () => {
        try {
          if (retired || caller() !== true) throw new HubProtocolError("unavailable");
          const at = time();
          if (at.wall - started.wall >= PREPARATION_BUDGET || at.elapsed - started.elapsed >= PREPARATION_BUDGET
            || read().raw !== before.raw || version() !== authEpoch) throw new HubProtocolError("unavailable");
          return at;
        } catch (error) { retired = true; throw error; }
      };
      common();
      let result;
      try { result = await reads.withDirectoryRead(who, async () => {
        const value = await method.call(directory, Object.freeze({ ...who }));
        return value.eligible === true ? { eligible: true as const, person: validated(person, value.person.key) }
          : { eligible: false as const, reason: value.eligible === false ? value.reason : "unavailable" };
      }); } catch (error) {
        if (error instanceof HubGroupReadOverload) throw new HubProtocolError("backpressure");
        throw new HubProtocolError("unavailable");
      }
      const observed = common();
      if (result.eligible !== true) throw new HubProtocolError(result.reason === "gone" || result.reason === "disabled" ? "denied" : "unavailable");
      if (personKeyString(result.person) !== personKeyString(who)) throw new HubProtocolError("unavailable");
      const facts = Object.freeze({ kind: "eligible" as const, person: who, observedAt: observed.wall });
      const allowed = (at: number) => before.kind === "group" ? personKeyString(who) === personKeyString(root)
        : evaluateRolePolicy(before.policy, who, "join.manage", null, { subject: facts }, at, root).outcome === "allow";
      if (!allowed(observed.wall)) throw new HubProtocolError("denied");
      const permit: HubJoinIssuerPermit = Object.freeze({ approvedBy: who, source: before.kind === "group" ? "legacy" : "roles",
        assertCurrent() {
          try {
            const at = common();
            if (at.wall >= observed.wall + HUB_MANAGEMENT_PROOF_TTL || at.elapsed >= observed.elapsed + HUB_MANAGEMENT_PROOF_TTL
              || !allowed(at.wall)) throw new HubProtocolError("unavailable");
          } catch (error) { retired = true; throw error; }
        },
      });
      permit.assertCurrent(); return permit;
    },
    require(incoming: HubRequestContext, permission: HubManagementPermission): Promise<HubManagementPermit> {
      return requirePermission(incoming, validated(z.enum(MANAGEMENT_PERMISSIONS), permission));
    },
    /** Member-level permission, deliberately outside D2's person-only management catalogue. */
    requireRoomCreation(incoming: HubRequestContext): Promise<HubRoomCreationPermit> {
      return requirePermission(incoming, "rooms.create");
    },
    close() { closed = true; },
  };
}
export type HubManagementAuthority = ReturnType<typeof createHubManagementAuthority>;
