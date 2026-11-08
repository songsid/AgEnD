/** Mounted directory decision/material barrier. No route or separate writer. */
import { canonicalArguments, sha256 } from "./identity.js";
import { verifyHubInitialization } from "./initialization.js";
import { HubSettingsError, readHubDirectorySettingsImage } from "./settings-commit.js";
import type { HubDirectorySettingsDecision } from "./settings-directory-decision.js";

const equal = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);
function proof(check: () => boolean): boolean {
  const value: unknown = check();
  if (value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
    try { (value as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* never an allowance */ }
    return false;
  }
  return value === true;
}

export function createHubDirectoryMountBarrier(options: {
  home: string;
  hub: Record<string, unknown>;
  decision: HubDirectorySettingsDecision;
  current(): boolean;
}) {
  // A caller replacing nested configuration or callbacks later cannot retarget this mounted generation.
  const home = options.home, hub = structuredClone(options.hub), decision = options.decision, owner = options.current.bind(options);
  if (typeof hub.hubId !== "string" || typeof hub.memberOrigin !== "string" || hub.hubId !== decision.hubId) throw new HubSettingsError("unavailable");
  const hubId = decision.hubId, inspect = decision.inspect.bind(decision), imageCurrent = decision.imageCurrent.bind(decision), proofBasis = decision.proofBasis.bind(decision);
  const installed = readHubDirectorySettingsImage(home, hub), mounted = inspect();
  let closed = false;
  const refuse = (): never => { closed = true; throw new HubSettingsError("recovery"); };
  const current = (): boolean => {
    if (closed) return false;
    try {
      const head = inspect(); // Includes the transport floor; unreadable is not a legacy/no-decision state.
      if (!proof(owner) || head.directoryEpoch !== mounted.directoryEpoch || head.operationId !== mounted.operationId) { closed = true; return false; }
      return true;
    } catch { closed = true; return false; }
  };
  const assertCurrent = () => {
    if (!current()) refuse();
    try {
      const material = readHubDirectorySettingsImage(home, hub);
      if (!equal(material, installed) || !imageCurrent(material)) refuse();
      verifyHubInitialization({ home, hubId: hub.hubId as string, memberOrigin: hub.memberOrigin as string, planDigest: material.configDigest });
      if (!current()) refuse();
      return material;
    } catch { return refuse(); }
  };
  assertCurrent();
  return Object.freeze({
    /** Admission/recovery must call this after asynchronous startup and immediately before exposing a new service. */
    assertCurrent() { return assertCurrent(); },
    /** Permanent lifetime fence; a failed generation never reopens when its old files or owner return. */
    current,
    close() { closed = true; },
    /** Internal proof-source image. Policy/transport changes invalidate a prepared proof without requiring a remount. */
    capture() {
      // A decision's own group/version update must not masquerade as an unrelated source change in its final proof.
      // Only the decision can open this callback-scoped view; it rechecks the exact resulting rows before COMMIT.
      const material = assertCurrent(), authority = proofBasis()?.expected ?? inspect();
      if (!current()) refuse();
      return Object.freeze({ epoch: mounted.directoryEpoch,
        image: sha256(canonicalArguments({ v: 1, hubId, material, authority })) });
    },
  });
}
