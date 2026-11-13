/** #3425: private Save orchestration. The configured-admin/D3 HTTP adapters remain responsible for acquiring authority. */
import { canonicalArguments } from "./identity.js";
import { hubSetCookie } from "./sessions.js";
import { HubProtocolError } from "./validation.js";
import { HubSettingsError } from "./settings-commit.js";
import { HubDirectoryProofError } from "./settings-directory-proof.js";
import type { HubMountedDirectory } from "./settings-directory-runtime.js";
import type { HubDirectorySettingsDecision, HubDirectorySettingsOperation } from "./settings-directory-decision.js";
import type { HubDirectorySettingsWriter } from "./settings-commit.js";
import { captureHubDirectoryProofContext, type HubDirectorySettingsProof, type HubDirectoryProofContext } from "./settings-directory-proof.js";
import type { HubDirectorySessionRotation } from "./session-directory-transition.js";
import type { HubDirectoryResponse } from "./directory-response-owner.js";

type Applied = { receiptId: string; directoryEpoch: number };
export type HubDirectorySaveResult = Applied & { state: "ready" | "restored" };
export interface HubDirectorySaveDeps {
  hubId: string;
  proof: HubDirectorySettingsProof;
  mounted(): HubMountedDirectory | null;
  writer(): HubDirectorySettingsWriter;
  /** Existing live participant or validated cold recovery; work is synchronous and uses that SAME writer participant. */
  withDecision<T>(work: (decision: HubDirectorySettingsDecision) => T): Promise<T>;
  /** Apply the host's latest accepted config through its existing serialized lifecycle; never a caller-supplied old config. */
  remount(): Promise<void>;
  /** Permanent host/runtime lifetime only. The old browser/generation is expected to be revoked by the decision. */
  current(): boolean;
  now?(): number;
}
export interface HubDirectorySaveDelivery {
  /** Captures the original fully consumed request; it must not admit any other browser/response. */
  capture(): HubDirectoryResponse;
  rotation?: HubDirectorySessionRotation;
}

const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);
function fail(code: "revoked" | "backpressure" | "invalid" | "conflict" | "unavailable"): never { throw new HubProtocolError(code); }
const REFUSAL_STATUS: Readonly<Record<string, number>> = Object.freeze({ invalid: 400, denied: 403, reauthentication: 403,
  stale: 409, expired: 409, trust: 409, busy: 409, conflict: 409, revoked: 403, unavailable: 503, recovery: 503, uncertain: 503 });
function refusal(error: unknown): { status: number; code: string } {
  const code = error instanceof HubSettingsError || error instanceof HubDirectoryProofError || error instanceof HubProtocolError
    ? error.code : "unavailable";
  return Object.hasOwn(REFUSAL_STATUS, code) ? { status: REFUSAL_STATUS[code]!, code } : { status: 503, code: "unavailable" };
}

export function createHubDirectorySaveCoordinator(options: HubDirectorySaveDeps) {
  const deps = { ...options }, now = deps.now ?? Date.now;
  let stopped = false, running: Promise<HubDirectorySaveResult> | null = null, response: HubDirectoryResponse | null = null;
  const owned = () => deps.current() === true && !stopped;
  const fence = () => { stopped = true; deps.proof.close(); void response?.discard().catch(() => {}); };
  async function run(ref: string, raw: Parameters<HubDirectorySettingsProof["apply"]>[1], inputContext: HubDirectoryProofContext,
    delivery?: HubDirectorySaveDelivery): Promise<HubDirectorySaveResult> {
    const context = captureHubDirectoryProofContext(inputContext);
    const input = { confirmation: raw.confirmation, ...(raw.credentials ? { credentials: { ...raw.credentials } } : {}) };
    const capture = delivery?.capture, rotation = delivery?.rotation;
    const roleSuccessor = context.administration !== undefined || context.preparation !== undefined;
    let discardSuccessor: (() => void) | undefined;
    const old = deps.mounted();
    let at: number | undefined, expected: ReturnType<HubDirectorySettingsDecision["inspect"]> | undefined;
    const current = () => context.current() === true && owned();
    const postDecision = () => {
      if (!owned()) fail("revoked");
      const time = now();
      if (at === undefined || !Number.isSafeInteger(time) || time < at || time - at >= 300_000) fail("revoked");
    };
    const ready = (saved: Applied): HubMountedDirectory | null => {
      const mounted = deps.mounted();
      if (!mounted?.current() || mounted.decision.hubId !== deps.hubId || mounted.recoveryMode === "held") return null;
      const head = mounted.decision.inspect();
      return head.operationId === saved.receiptId && head.directoryEpoch === saved.directoryEpoch && mounted.current() ? mounted : null;
    };
    try {
      if (context.actor.kind === "hub-administrator" ? !capture || !rotation : rotation !== undefined) fail("invalid");
      if (!old?.current() || old.decision.hubId !== deps.hubId || !current()) fail("revoked");
      const saved = await deps.proof.apply(ref, input, { ...context, current }, rotation, () => {
        if (!old.current() || !current()) fail("revoked");
        expected = structuredClone(old.decision.inspect());
        at = now(); if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(at + 300_000)) fail("invalid");
        if (capture) { response = capture(); if (!response.current()) fail("revoked"); }
        if (!current()) fail("revoked");
        return at + 300_000;
      });
      postDecision();
      // From the SQL decision onward, a disconnect cannot cancel physical completion or its fixed recovery intent.
      try { await deps.remount(); } catch { /* Judge the exact resulting mount, not a transient promise result. */ }
      postDecision();
      const original = await deps.withDecision(decision => {
        postDecision(); if (decision.hubId !== deps.hubId) fail("conflict");
        const operation = decision.operation(saved.receiptId);
        if (!expected || !same(operation.expected, expected) || operation.kind !== "directory" || operation.compensates !== null
          || !same(operation.actor, context.actor) || operation.directoryEpoch !== saved.directoryEpoch
          || saved.directoryEpoch !== expected.directoryEpoch + 1 || !operation.recovery
          || operation.recovery.expiresAt <= at! || operation.recovery.expiresAt > at! + 300_000) fail("conflict");
        return structuredClone(operation);
      });
      postDecision();
      let result: HubDirectorySaveResult = { receiptId: saved.receiptId, directoryEpoch: saved.directoryEpoch, state: "ready" };
      if (!ready(saved)) {
        rotation?.discard();
        const compensated = await deps.withDecision(decision => {
          postDecision();
          if (decision.hubId !== deps.hubId || decision.inspect().operationId !== original.id) fail("conflict");
          const intent = (candidate: HubDirectorySettingsOperation) => { postDecision(); return same(candidate, original); };
          return deps.writer().compensate(original.id, intent, at! + 300_000);
        });
        postDecision();
        try { await deps.remount(); } catch { /* A failed restoration remains held, never reported ready. */ }
        postDecision();
        if (!ready(compensated)) fail("unavailable");
        result = { receiptId: compensated.receiptId, directoryEpoch: compensated.directoryEpoch, state: "restored" };
      }
      // Durable successful outcome closes the old-content restoration allowance before any success/cookie is released.
      const settled = ready({ receiptId: result.receiptId, directoryEpoch: result.directoryEpoch });
      if (!settled) fail("unavailable");
      if (result.state === "ready") {
        const intent = settled.decision.mountRecovery();
        if (!intent || !same(intent.operation, original) || intent.state === "compensated") fail("conflict");
        if (intent.state === "pending") settled.decision.completeMount(result.receiptId, now(), () => { postDecision(); return settled.current(); });
        if (settled.decision.mountRecovery()?.state !== "ready") fail("unavailable");
      }
      if (response?.current()) {
        const exact = { receiptId: result.receiptId, directoryEpoch: result.directoryEpoch };
        let assertSuccessor: (() => void) | undefined;
        let releaseSuccessor: (() => { token: string; maxAgeMs: number }) | undefined;
        if (result.state === "ready" && rotation && roleSuccessor) {
          const mounted = ready(exact); if (!mounted) fail("revoked");
          const provider = mounted.sessions, sessions = provider.call(mounted), prepare = sessions.prepareRoleDirectoryRotationRelease;
          if (typeof prepare !== "function") fail("unavailable");
          const bound = () => {
            postDecision();
            if (ready(exact) !== mounted || mounted.sessions !== provider || provider.call(mounted) !== sessions
              || sessions.prepareRoleDirectoryRotationRelease !== prepare) fail("revoked");
          };
          bound();
          const successor = await prepare.call(sessions, rotation, result.receiptId);
          if (!successor || !Object.isFrozen(successor) || typeof successor.assertCurrent !== "function"
            || typeof successor.release !== "function" || typeof successor.discard !== "function") fail("unavailable");
          const assert = successor.assertCurrent, release = successor.release, discard = successor.discard;
          discardSuccessor = () => discard.call(successor);
          const methods = () => {
            if (successor.assertCurrent !== assert || successor.release !== release || successor.discard !== discard) fail("revoked");
          };
          assertSuccessor = () => {
            bound(); methods();
            const answer: unknown = assert.call(successor);
            if (answer !== undefined) fail("unavailable");
            methods(); bound();
          };
          releaseSuccessor = () => {
            assertSuccessor!(); const cookie = release.call(successor); assertSuccessor!(); return cookie;
          };
          assertSuccessor();
        }
        const disclosureCurrent = () => { postDecision(); if (!ready(exact)) return false; assertSuccessor?.(); return true; };
        await response.reply(() => {
          if (!disclosureCurrent()) fail("revoked");
          const mounted = ready(exact); if (!mounted) fail("revoked");
          const cookie = result.state === "ready" && rotation
            ? releaseSuccessor ? releaseSuccessor() : mounted.sessions().completeDirectoryRotation(rotation, result.receiptId) : undefined;
          return { status: result.state === "ready" ? 200 : 503, json: JSON.stringify(result),
            ...(cookie ? { cookie: hubSetCookie(deps.hubId, cookie.token, cookie.maxAgeMs) } : {}) };
        }, disclosureCurrent);
      }
      return result;
    } catch (error) {
      // A captured socket is not evidence of a commit. Only the exact unchanged authority image proves no decision.
      const unchanged = () => current() && old?.current() === true && old.decision.hubId === deps.hubId
        && expected !== undefined && same(old.decision.inspect(), expected);
      if (response && expected !== undefined) {
        try {
          if (response.current() && current()) {
            const proven = await deps.withDecision(decision => current() && decision.hubId === deps.hubId && same(decision.inspect(), expected));
            if (proven && unchanged()) {
              const bounded = refusal(error);
              await response.reply(() => {
                if (!unchanged()) fail("revoked");
                return { status: bounded.status, json: JSON.stringify({ ok: false, code: bounded.code, committed: false }) };
              }, unchanged);
            }
          }
        } catch { /* A changed/uncertain floor or lost response is discarded; never guess an outcome. */ }
      }
      throw error;
    } finally {
      try { discardSuccessor?.(); }
      finally {
        rotation?.discard();
        await response?.discard(); response = null;
      }
    }
  }
  return {
    apply(ref: string, input: Parameters<HubDirectorySettingsProof["apply"]>[1], context: HubDirectoryProofContext, delivery?: HubDirectorySaveDelivery) {
      if (!owned()) return Promise.reject(new HubProtocolError("revoked"));
      if (running) return Promise.reject(new HubProtocolError("backpressure"));
      const work = run(ref, input, context, delivery); running = work;
      void work.finally(() => { if (running === work) running = null; }).catch(() => {});
      return work;
    },
    fence,
    async close() { fence(); await running?.catch(() => {}); await response?.discard(); response = null; },
  };
}
