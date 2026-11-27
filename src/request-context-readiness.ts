/** Read-only whole-Fleet preflight. A status is explanatory; only a still-current proof can reach cutover. */
import { requestContextDigest } from "./request-context-store.js";
import type { RequestMigrationSnapshot } from "./request-context-migration.js";

export const REQUEST_CONTEXT_OWNER_PORTS = ["input", "turn", "calls", "policy", "drain", "transport", "contacts", "relay", "instructions"] as const;
export type RequestContextOwnerPort = typeof REQUEST_CONTEXT_OWNER_PORTS[number];
export interface RequestContextOwnerReadiness {
  /** Server-owned configuration key, never a sender name in a tool call. */
  id: string;
  generation: string;
  revision: string;
  ports: Readonly<Partial<Record<RequestContextOwnerPort, boolean>>>;
}
export interface RequestContextPeerReadiness {
  id: string;
  generation: string;
  connected: boolean;
  requestContextVersion: number;
}
export interface RequestContextReadinessSnapshot {
  /** Durable Fleet id and the current exclusive process lease identity. */
  owner: string | null;
  lease: string | null;
  revision: string;
  shadow: RequestMigrationSnapshot;
  /** Captured under the activation update locks; no current/recoverable attempt and exact offered Go back set. */
  update: { settled: boolean; revision: string };
  requiredOwners: readonly string[];
  owners: readonly RequestContextOwnerReadiness[];
  requiredPeers: readonly string[];
  peers: readonly RequestContextPeerReadiness[];
}
export type RequestContextReadinessBlock = "legacy" | "peers" | "owners" | "update";
export interface RequestContextReadinessStatus {
  readonly ready: boolean;
  readonly blocked: readonly RequestContextReadinessBlock[];
  readonly sha256: string;
}
export interface RequestContextReadinessProof {
  readonly sha256: string;
  current(): boolean;
}
const key = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
function status(raw: RequestContextReadinessSnapshot): RequestContextReadinessStatus {
  const blocked = new Set<RequestContextReadinessBlock>();
  if (raw.update?.settled !== true || !key(raw.update.revision)) blocked.add("update");
  const unique = (values: readonly string[]) => values.every(key) && new Set(values).size === values.length;
  if (!key(raw.owner) || !key(raw.lease) || !key(raw.revision)) blocked.add("owners");
  const shadow = raw.shadow;
  const { sha256: shadowDigest, ...shadowImage } = shadow;
  if (shadow.version !== 1 || shadow.readOnly !== true || !shadow.complete || shadow.truncated || shadow.nextCursor !== null || shadow.blockers.length
    || requestContextDigest(shadowImage) !== shadowDigest
    || shadow.owner !== raw.owner || !key(shadow.policyEpoch) || !/^[a-f0-9]{64}$/.test(shadow.sha256)) blocked.add("legacy");
  const ids = raw.owners.map(owner => owner.id);
  if (!unique(raw.requiredOwners) || !unique(ids) || ids.length !== raw.requiredOwners.length
    || raw.requiredOwners.some(id => !ids.includes(id))) blocked.add("owners");
  for (const owner of raw.owners) {
    if (!key(owner.generation) || !key(owner.revision)
      || REQUEST_CONTEXT_OWNER_PORTS.some(port => owner.ports[port] !== true)) blocked.add("owners");
  }
  const peerIds = raw.peers.map(peer => peer.id);
  if (!unique(raw.requiredPeers) || !unique(peerIds) || peerIds.length !== raw.requiredPeers.length
    || raw.requiredPeers.some(id => !peerIds.includes(id))) blocked.add("peers");
  for (const peer of raw.peers) {
    if (!key(peer.generation) || peer.connected !== true || peer.requestContextVersion !== 1) blocked.add("peers");
  }
  // Sort only unordered membership lists, never the migration shadow or an operation image.
  const canonical = { ...raw, requiredOwners: [...raw.requiredOwners].sort(), requiredPeers: [...raw.requiredPeers].sort(),
    owners: [...raw.owners].sort((a, b) => a.id.localeCompare(b.id)), peers: [...raw.peers].sort((a, b) => a.id.localeCompare(b.id)) };
  return Object.freeze({ ready: blocked.size === 0, blocked: Object.freeze([...blocked].sort()), sha256: requestContextDigest(canonical) });
}
export class RequestContextReadiness {
  constructor(private readonly read: () => RequestContextReadinessSnapshot) {}
  inspect(): RequestContextReadinessStatus {
    try { return status(this.read()); }
    catch { return Object.freeze({ ready: false, blocked: Object.freeze(["owners"] as const), sha256: requestContextDigest("readiness unavailable") }); }
  }
  /** Capture after staging actual owners; re-run this immediately inside the cutover commit. */
  prove(): RequestContextReadinessProof {
    const initial = this.inspect();
    if (!initial.ready) throw Error(`Request-context readiness blocked: ${initial.blocked.join(", ")}`);
    return Object.freeze({ sha256: initial.sha256, current: () => {
      const next = this.inspect(); return next.ready && next.sha256 === initial.sha256;
    } });
  }
}
