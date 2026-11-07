/** AD group permission facts. DN labels never identify a policy group (#3298). */
import { isCanonicalObjectId } from "./profiles.js";
import type { PersonKey } from "./types.js";

export const AD_EXTENDED_DN = "1.2.840.113556.1.4.529";
export const MAX_POLICY_MEMBERSHIPS = 256;
export interface DirectoryPolicyGroup { readonly key: PersonKey; readonly dn: string }
export type PolicyGroupLookup = { readonly ok: true; readonly group: DirectoryPolicyGroup }
  | { readonly ok: false; readonly reason: "unsupported" | "invalid" | "not-found" | "not-security-group" | "unknown" };
export type PolicyGroupFacts =
  | { readonly kind: "complete"; readonly person: PersonKey; readonly groups: readonly string[]; readonly observedAt: number }
  | { readonly kind: "ineligible"; readonly person: PersonKey; readonly reason: "gone" | "disabled"; readonly observedAt: number }
  | { readonly kind: "unknown" };

/** Flags=1 requests dashed GUIDs. Plain DNs, hex-only GUIDs and partial/ranged attributes never authorize. */
export function extendedGroupIds(entry: Record<string, unknown>): readonly string[] | null {
  const keys = Object.keys(entry).filter(k => k.toLowerCase().startsWith("memberof"));
  if (keys.some(k => k.toLowerCase() !== "memberof") || keys.length > 1) return null;
  const raw = keys.length ? entry[keys[0]!] : undefined;
  if (raw === undefined) return null; // Absent/unreadable is not a complete negative membership proof.
  // ldapts fills omitted requested attributes with []; that is still unknown, not negative proof.
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0 || values.length > MAX_POLICY_MEMBERSHIPS) return null;
  const groups = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length > 2048) return null;
    const match = /^<GUID=([0-9a-f-]+)>;(?:<SID=S-[0-9-]+>;)?([^\u0000-\u001f\u007f]{1,1024})$/i.exec(value);
    const id = match?.[1]?.toLowerCase();
    if (!id || !isCanonicalObjectId(id)) return null;
    groups.add(id);
  }
  return Object.freeze([...groups].sort());
}
