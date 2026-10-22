import { createHmac } from "node:crypto";

/** Stable across restarts/port moves. Rotation already invalidates sessions and devices.
 * Domain separation keeps the public suffix unrelated to any authentication proof.
 * Without a key this helper describes a legacy name (migration/tests only).
 */
export function fleetCookieName(legacyName: string, webToken?: string | null): string {
  if (!webToken) return legacyName;
  const suffix = createHmac("sha256", webToken).update("agend fleet cookie names v1").digest("hex").slice(0, 16);
  return `${legacyName}_${suffix}`;
}
