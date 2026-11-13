/** Operation-owned management proof. Not mounted until canonical consumers and cutover are ready. */
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { HubDirectory } from "../directory/types.js";
import { HubGroupReadOverload, type GroupCheckContext, type HubGroupPolicyStore } from "../group-policy/store.js";
import { personKeyString } from "../identity.js";
import type { HubActor, HubRequestContext, PersonKey } from "../types.js";
import { epoch, HubProtocolError, identifier, person, validated } from "../validation.js";
import { evaluateRolePolicy } from "./evaluate.js";
import { MANAGEMENT_PERMISSIONS } from "./model.js";
import type { HubCanonicalPolicy } from "./read.js";
import { inspectHubDirectoryDecisionProof, type HubDirectoryDecisionProof } from "../directory-decision-proof.js";

export type HubManagementPermission = typeof MANAGEMENT_PERMISSIONS[number];
export const HUB_MANAGEMENT_PROOF_TTL = 5_000;
const PREPARATION_BUDGET = 20_000;
const DIRECTORY_OPERATION_BUDGET = 300_000;
type DirectoryActor = Extract<HubActor, { kind: "directory" }>;
export interface HubManagementPermit {
  readonly actor: DirectoryActor;
  readonly permission: HubManagementPermission;
  readonly source: "legacy" | "roles";
  readonly expiresAt: number;
  /** Mandatory before each effect/disclosure, including after any await or reentrant callback. */
  assertCurrent(): void | number;
  /** Opt-in, exact synchronous directory decision only. This does not relax assertCurrent(). */
  assertDirectoryDecision?(proof: HubDirectoryDecisionProof): void | number;
}
/** Preparation only: effects still require a newly acquired named permit. */
export interface HubDirectoryManagementPreparation {
  readonly actor: DirectoryActor;
  readonly directory: object;
  readonly administrator: PersonKey;
  assertCurrent(): void;
  authorize(): Promise<HubManagementPermit>;
  retire(): void;
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
  directory: Pick<HubDirectory, "realm" | "checkEligibility">;
  reads: Pick<HubGroupPolicyStore, "withDirectoryRead">;
  current(): boolean;
  /** Existing transport version, including its independent persistent floor. */
  version(): number;
  /** The real expiry settlement's persisted clock fence; synchronous and mandatory on role images. */
  assertAuthorizationTime(): void;
  directoryDecision?: {
    db: Database.Database; hubId: string;
    assertAuthorizationTime(proof: HubDirectoryDecisionProof): void;
  };
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
  const decision = options.directoryDecision, decisionClock = decision?.assertAuthorizationTime,
    decisionDb = decision?.db, decisionHub = decision?.hubId;
  const root = Object.freeze(validated(person, options.root)), method = directory.checkEligibility;
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
  // The longer guard is never exposed on a permit and cannot authorize an effect.
  const preparationChecks = new WeakMap<HubManagementPermit, () => void>();
  const authority = {
    async prepareDirectory(incoming: HubRequestContext): Promise<HubDirectoryManagementPreparation> {
      const require = authority.require, permit = await require(incoming, "hub.admin"), guard = preparationChecks.get(permit);
      if (!guard || authority.require !== require) throw new HubProtocolError("unavailable");
      let retired = false, running = false;
      const check = () => {
        try {
          if (retired || authority.require !== require) throw new HubProtocolError("unavailable");
          guard();
          if (authority.require !== require) throw new HubProtocolError("unavailable");
        } catch (error) { retired = true; throw error; }
      };
      return Object.freeze({ actor: permit.actor, directory, administrator: root, assertCurrent: check,
        async authorize() {
          check();
          if (running) throw new HubProtocolError("backpressure");
          running = true;
          try {
            // Same session, policy/version and provider, but a NEW physical eligibility read.
            const fresh = await require(incoming, "hub.admin"); check();
            if (fresh.permission !== "hub.admin" || fresh.source !== permit.source
              || fresh.actor.sessionId !== permit.actor.sessionId || personKeyString(fresh.actor.person) !== personKeyString(permit.actor.person)) throw new HubProtocolError("unavailable");
            fresh.assertCurrent(); check(); return fresh;
          } finally { retired = true; }
        }, retire() { retired = true; } });
    },
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
    async require(incoming: HubRequestContext, permission: HubManagementPermission): Promise<HubManagementPermit> {
      const cap = validated(z.enum(MANAGEMENT_PERMISSIONS), permission);
      const requestId = validated(identifier, incoming.requestId);
      if (typeof incoming.current !== "function" || typeof incoming.isCurrent !== "function"
        || typeof incoming.isIdentityCurrent !== "function") throw new HubProtocolError("unavailable");
      const authenticate = incoming.current.bind(incoming), sessionCurrent = incoming.isCurrent.bind(incoming);
      const identityCurrent = incoming.isIdentityCurrent.bind(incoming), started = time(), before = read(), authEpoch = version();
      const callerMethods = { current: incoming.current, isCurrent: incoming.isCurrent, isIdentityCurrent: incoming.isIdentityCurrent };
      let retired = false, actor: DirectoryActor | null = null;
      const common = (proof?: HubDirectoryDecisionProof, preparation = false) => {
        try {
          if (retired || sessionCurrent() !== true) throw new HubProtocolError("unavailable");
          let at = time();
          const budget = preparation ? DIRECTORY_OPERATION_BUDGET : PREPARATION_BUDGET;
          if (at.wall - started.wall >= budget || at.elapsed - started.elapsed >= budget) throw new HubProtocolError("unavailable");
          if (proof) {
            const decisionLive = () => {
              live();
              if (!decision || !decisionClock || cap !== "hub.admin" || !actor || options.directoryDecision !== decision
                || decision.db !== decisionDb || decision.hubId !== decisionHub || decision.assertAuthorizationTime !== decisionClock) throw new HubProtocolError("unavailable");
            };
            decisionLive();
            const inspect = () => inspectHubDirectoryDecisionProof(proof, { db: decisionDb!, hubId: decisionHub!,
              actor: { kind: "hub-administrator", person: actor!.person, sessionId: actor!.sessionId, requestId } });
            const view = inspect();
            if (view.before.raw !== before.raw || view.expected.authorizationVersion !== authEpoch
              || version() !== authEpoch + (view.phase === "final" ? 1 : 0)) throw new HubProtocolError("unavailable");
            if (before.kind === "roles") sync(decisionClock!.call(decision, proof));
            decisionLive(); inspect();
            if (sessionCurrent() !== true) throw new HubProtocolError("unavailable");
            at = time();
            if (at.wall - started.wall >= PREPARATION_BUDGET || at.elapsed - started.elapsed >= PREPARATION_BUDGET) throw new HubProtocolError("unavailable");
          } else if (read().raw !== before.raw || version() !== authEpoch) throw new HubProtocolError("unavailable");
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
      const observed = common(); await identity(); const proved = common();
      if (result.eligible !== true) throw new HubProtocolError(result.reason === "gone" || result.reason === "disabled" ? "denied" : "unavailable");
      if (personKeyString(result.person) !== personKeyString(who)) throw new HubProtocolError("unavailable");
      const facts = Object.freeze({ kind: "eligible" as const, person: who, observedAt: observed.wall });
      const allowed = (at: number) => before.kind === "group" ? personKeyString(who) === personKeyString(root)
        : evaluateRolePolicy(before.policy, who, cap, null, { subject: facts }, at, root).outcome === "allow";
      if (!allowed(proved.wall)) throw new HubProtocolError("denied");
      const permit: HubManagementPermit = Object.freeze({ actor: actor!, permission: cap, source: before.kind === "group" ? "legacy" : "roles",
        expiresAt: observed.wall + HUB_MANAGEMENT_PROOF_TTL,
        assertCurrent() {
          try {
            const at = common();
            if (at.wall >= observed.wall + HUB_MANAGEMENT_PROOF_TTL || at.elapsed >= observed.elapsed + HUB_MANAGEMENT_PROOF_TTL
              || !allowed(at.wall)) throw new HubProtocolError("unavailable");
            return at.wall;
          } catch (error) { retired = true; throw error; }
        },
        ...(decision ? { assertDirectoryDecision(proof: HubDirectoryDecisionProof) {
          try {
            if (!proof) throw new HubProtocolError("unavailable");
            const at = common(proof);
            if (at.wall >= observed.wall + HUB_MANAGEMENT_PROOF_TTL || at.elapsed >= observed.elapsed + HUB_MANAGEMENT_PROOF_TTL
              || !allowed(at.wall)) throw new HubProtocolError("unavailable");
            return at.wall; // Trusted final sample; consumers must not invoke another clock callback afterward.
          } catch (error) { retired = true; throw error; }
        } } : {}),
      });
      if (cap === "hub.admin") preparationChecks.set(permit, () => {
        try {
          const caller = () => {
            if (incoming.requestId !== requestId || incoming.current !== callerMethods.current || incoming.isCurrent !== callerMethods.isCurrent
              || incoming.isIdentityCurrent !== callerMethods.isIdentityCurrent) throw new HubProtocolError("unavailable");
          };
          caller(); const at = common(undefined, true);
          if (!allowed(at.wall)) throw new HubProtocolError("unavailable");
          caller(); const final = common(undefined, true);
          if (!allowed(final.wall)) throw new HubProtocolError("unavailable");
          caller();
        } catch (error) { retired = true; throw error; }
      });
      permit.assertCurrent(); return permit;
    },
    close() { closed = true; },
  };
  return authority;
}
export type HubManagementAuthority = ReturnType<typeof createHubManagementAuthority>;
