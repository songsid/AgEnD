/**
 * The normalized plan digest that the initialization manifest seals and the Hub mount (S1) re-checks against the
 * current configuration (agreed in hub-s48-init). Pure and side-effect free: both sides import it.
 *
 * It covers exactly the hub.* settings initialization writes (not `enabled`), normalized: fixed key set, canonical
 * JSON (sorted keys), lowercase object id. Any later edit to these settings changes the digest, so a hand-edited
 * fleet.yaml cannot silently keep a sealed Hub enabled.
 */
import { createHash } from "node:crypto";

export const PLAN_DIGEST_LABEL = "agend-hub-init-plan-v1";

const DIRECTORY_KEYS = ["realm", "url", "caPem", "baseDn", "bindDn", "profile", "loginAttribute", "userFilter", "timeoutMs", "bindPasswordRef"] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const listen = (v: unknown) => ({ host: obj(v).host, port: obj(v).port });

/** The fields of a hub.* block that the digest covers. Unknown or extra fields are ignored; missing ones stay missing. */
export function normalizedHubSettings(hub: unknown): Record<string, unknown> {
  const h = obj(hub);
  const d = obj(h.directory);
  const admin = obj(h.administrator);
  return {
    name: h.name,
    hubId: h.hubId,
    webOrigin: h.webOrigin,
    memberOrigin: h.memberOrigin,
    memberListen: listen(h.memberListen),
    webListen: listen(h.webListen),
    webTls: { certificateFile: obj(h.webTls).certificateFile, keyFile: obj(h.webTls).keyFile },
    directory: Object.fromEntries(DIRECTORY_KEYS.map((k) => [k, d[k]])),
    administrator: { realm: admin.realm, objectId: typeof admin.objectId === "string" ? admin.objectId.toLowerCase() : admin.objectId },
    retention: { contentDays: obj(h.retention).contentDays, eventDays: obj(h.retention).eventDays },
    coexistence: h.coexistence,
  };
}

/** SHA-256 (hex) of the label and the normalized settings. */
export function hubPlanDigest(hub: unknown): string {
  return createHash("sha256").update(`${PLAN_DIGEST_LABEL}\n${canonical(normalizedHubSettings(hub))}`).digest("hex");
}
