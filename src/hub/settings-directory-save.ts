/** #3425: private Save orchestration. The configured-admin/D3 HTTP adapters remain responsible for acquiring authority. */
import { canonicalArguments } from "./identity.js";
import { hubSetCookie } from "./sessions.js";
import { HubProtocolError } from "./validation.js";
import type { HubMountedDirectory } from "./settings-directory-runtime.js";
import type { HubDirectorySettingsDecision, HubDirectorySettingsOperation } from "./settings-directory-decision.js";
import type { HubDirectorySettingsWriter } from "./settings-commit.js";
import type { HubDirectorySettingsProof, HubDirectoryProofContext } from "./settings-directory-proof.js";
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

export function createHubDirectorySaveCoordinator(options: HubDirectorySaveDeps) {
  const deps = { ...options }, now = deps.now ?? Date.now;
  let stopped = false, running: Promise<HubDirectorySaveResult> | null = null, response: HubDirectoryResponse | null = null;
  const owned = () => deps.current() === true && !stopped;
  const fence = () => { stopped = true; deps.proof.close(); void response?.discard().catch(() => {}); };
  async function run(ref: string, raw: Parameters<HubDirectorySettingsProof["apply"]>[1], inputContext: HubDirectoryProofContext,
    delivery?: HubDirectorySaveDelivery): Promise<HubDirectorySaveResult> {
    const context = { actor: structuredClone(inputContext.actor), current: inputContext.current, signal: inputContext.signal };
    const input = { confirmation: raw.confirmation, ...(raw.credentials ? { credentials: { ...raw.credentials } } : {}) };
    const capture = delivery?.capture, rotation = delivery?.rotation;
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
      if (!mounted?.current() || mounted.decision.hubId !== deps.hubId) return null;
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
          || saved.directoryEpoch !== expected.directoryEpoch + 1) fail("conflict");
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
      if (response?.current()) {
        const exact = { receiptId: result.receiptId, directoryEpoch: result.directoryEpoch };
        await response.reply(() => {
          postDecision(); const mounted = ready(exact); if (!mounted) fail("revoked");
          const cookie = result.state === "ready" && rotation
            ? mounted.sessions().completeDirectoryRotation(rotation, result.receiptId) : undefined;
          return { status: result.state === "ready" ? 200 : 503, json: JSON.stringify(result),
            ...(cookie ? { cookie: hubSetCookie(deps.hubId, cookie.token, cookie.maxAgeMs) } : {}) };
        }, () => { postDecision(); return ready(exact) !== null; });
      }
      return result;
    } finally {
      rotation?.discard();
      await response?.discard(); response = null;
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
