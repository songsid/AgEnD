/**
 * #3298 S-89 / S-88 seam (agreed cid-s89-seams): the HTTP shapes of Hub Administration → Group permissions and of the signed-in
 * welcome, and the control the server implements behind them. Behaviour-free: nothing here is composed, mounted or called yet.
 *
 * - The routes are mounted only when the Hub composes `deps.groups.admin` (S-88), which happens only once activation and
 *   enrollment are complete. Until then they are absent (404) and the session carries no `group-policy-v1` mark.
 * - The control owns every decision: who is the configured directory administrator (`requireAdmin`), which group a DN is (a fresh
 *   LDAPS read; a client id is only an intended-identity assertion), the effect of a change, and applying it. The HTTP layer only
 *   validates these shapes and presents the answers.
 * - Save applies only the server's own short-lived, session-bound sealed candidate for the previewed policy and digest.
 * - The welcome (S-89's projection over store.describe) is display only, for any signed-in person: one bounded fresh read, no
 *   audit, no provenance, no permit, and no GUID or DN evidence.
 */
import { z } from "zod";
import { identifier, person } from "../validation.js";
import { parseGroupPolicy, type GroupCapability, type HubGroupPolicy } from "./model.js";
import type { HubActor } from "../types.js";

const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const dn = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * POST /hub/v1/admin/group-policy/resolve — input feedback only, never authority. The control uses the DN only as the base of a
 * scope-base read of that one object, never interpolated into an LDAP filter (so it needs no filter escaping).
 */
export const resolveRequest = z.strictObject({ dn });
export type GroupResolveRequest = z.infer<typeof resolveRequest>;
export type GroupResolveResponse =
  | { readonly ok: true; readonly realm: string; readonly objectId: string; readonly dn: string }
  | { readonly ok: false; readonly reason: "unsupported" | "invalid" | "not-found" | "not-security-group" | "unknown" };

/**
 * POST /hub/v1/admin/group-policy/preview `{ policy }` — the whole proposed HubGroupPolicy (its revision is the compare-and-set).
 * Each group keeps the key the admin selected (from resolve) with its DN: the control resolves every DN again at preview AND at
 * apply and binds a row only when the fresh GUID equals that key, so a DN that AD recreated or reused never inherits a row. A
 * mismatched or unresolvable row is refused and has to be re-selected. The client's key is an intended-identity assertion only.
 */
/** The model's own closed check, as a schema step: a policy that doesn't parse is an ordinary refusal, not a thrown error. */
const policyField = z.unknown().transform((value, ctx): HubGroupPolicy => {
  try { return parseGroupPolicy(value); } catch { ctx.addIssue({ code: "custom", message: "invalid policy" }); return z.NEVER; }
});
export const previewRequest = z.strictObject({ policy: policyField });
export type GroupPreviewRequest = { readonly policy: HubGroupPolicy };
/** A person in an impact list. `personId` is the canonical "realm/objectId" string; name and login are display only, null if never signed in. */
export interface GroupImpactPerson { readonly personId: string; readonly name: string | null; readonly login: string | null; readonly capabilities?: readonly GroupCapability[] }
export interface GroupImpactResource { readonly kind: "fleet" | "exposure" | "asker"; readonly id: string; readonly revision: number; readonly label: string | null; readonly owner: { readonly name: string | null } | null }
/** Typed by the S-88 control; the editor shows each list. */
export interface GroupImpact {
  /** Every affected ask-grant holder and operational-action loser, the configured admin included. */
  readonly losingActions: readonly GroupImpactPerson[];
  /** Owners who can no longer publish new or revised agents. */
  readonly losingPublication: readonly GroupImpactPerson[];
  /** Exact manual revisions kept as they are. */
  readonly grandfathered: readonly GroupImpactResource[];
  /** Resources this change would suspend. */
  readonly suspendedOnSave: readonly GroupImpactResource[];
  /** The configured administrator is in no `ask_agents` group after this change. */
  readonly adminLosesChat: boolean;
}
export type GroupPreviewResponse =
  | { readonly ok: true; readonly previewDigest: string; readonly expiresAt: number; readonly policyRevision: number; readonly authorizationVersion: number; readonly impact: GroupImpact }
  | { readonly ok: false; readonly code: "conflict" | "unsupported" | "invalid" | "unknown" | "repair-required" | "group-mismatch" };

/**
 * PUT /hub/v1/admin/group-policy `{ policy, previewDigest }` — the policy that was previewed and that preview's digest. The control
 * applies only its own short-lived, session-bound sealed candidate for them (re-resolving every group again); a different policy,
 * changed impact or revision means preview again. The preview on screen and Save are the confirmation; no extra dialog.
 */
export const applyRequest = z.strictObject({ policy: policyField, previewDigest: digest });
export type GroupApplyRequest = { readonly policy: HubGroupPolicy; readonly previewDigest: string };
export type GroupApplyResponse =
  | { readonly ok: true; readonly policyRevision: number; readonly state: HubGroupPolicy["state"] }
  | { readonly ok: false; readonly code: "conflict" | "stale-preview" | "expired" | "unknown" | "unsupported" | "repair-required" | "group-mismatch" };

/**
 * POST /hub/v1/admin/group-policy/resources/resume — one exact paused resource and the revisions the admin was shown: the
 * resource's own (in `resource`), the policy's, and its suspension record's (lifecycle), which change independently. The owner is
 * derived from the persisted resource, never from the request. Rejoining a group or switching policy on never resumes anything.
 */
export const resumeRequest = z.strictObject({ resource: z.strictObject({ kind: z.enum(["fleet", "exposure", "asker"]), id: identifier, revision }),
  expectedPolicyRevision: revision, expectedLifecycleRevision: revision });
export type GroupResumeRequest = z.infer<typeof resumeRequest>;
export type GroupResumeResponse =
  | { readonly ok: true; readonly resource: GroupResumeRequest["resource"]; readonly state: "active"; readonly policyRevision: number; readonly lifecycleRevision: number }
  | { readonly ok: false; readonly code: "conflict" | "denied" | "unknown" };

/** A paused row the editor lists, with both revisions the resume compares. */
export interface GroupPausedRow extends Omit<GroupImpactResource, "kind" | "id" | "revision"> { readonly resource: GroupResumeRequest["resource"]; readonly lifecycleRevision: number }
/**
 * GET /hub/v1/admin/group-policy. `binding: "repair-required"` is readable without constructing the mismatched strict store:
 * policy is then null, never an empty editable policy. `supported: false` (no AD direct-GUID reader, non-AD realm) is read-only.
 */
export type GroupPolicyReadResponse = {
  readonly ok: true; readonly groupPolicyV1: true; readonly supported: boolean; readonly binding: "ready" | "repair-required";
  readonly policy: HubGroupPolicy | null; readonly paused: readonly GroupPausedRow[];
};

/** GET /hub/v1/me/welcome — display only, for the signed-in person. No GUIDs or DNs. Legacy keeps today's grants and manual pairing. */
export type WelcomeEntry = { readonly state: "allow" | "deny" | "unknown"; readonly reason?: "group" | "person-denied" | "no-group" | "ineligible" | "unknown" | "suspended" };
export type GroupWelcomeResponse = {
  readonly ok: true; readonly v: 1; readonly mode: "legacy" | "enabled" | "suspended";
  readonly chat: WelcomeEntry; readonly publish: WelcomeEntry;
  readonly connect: WelcomeEntry & { readonly maxFleets: number; readonly fleets: readonly { readonly id: string; readonly label: string | null; readonly status: "active" | "suspended" | "revoked" }[] };
};

/** Server-bound context of an admin call: the control itself calls `requireAdmin` (a supplied actor alone cannot re-authenticate). */
export interface GroupAdminContext { readonly requestId: string; current(): boolean; requireAdmin(): Promise<HubActor> }
/**
 * Context of a welcome read (S-89): the welcome reveals one person's allow/deny per capability, so its subject is never a value
 * passed in. The projection calls `requirePerson()` itself: the request's own current session's person, fresh (Fable #3356 N1).
 */
export interface GroupWelcomeContext { readonly requestId: string; current(): boolean; requirePerson(): Promise<z.infer<typeof person>> }

/**
 * Implemented by S-88 (preview/apply/resume are the authoritative control). The HTTP layer validates the request shapes above
 * before calling and sends only these answers. The welcome projection is S-89's own (store.describe), not part of this control.
 */
export interface HubGroupAdminControl {
  read(ctx: GroupAdminContext): Promise<GroupPolicyReadResponse>;
  resolve(input: GroupResolveRequest, ctx: GroupAdminContext): Promise<GroupResolveResponse>;
  preview(input: GroupPreviewRequest, ctx: GroupAdminContext): Promise<GroupPreviewResponse>;
  apply(input: GroupApplyRequest, ctx: GroupAdminContext): Promise<GroupApplyResponse>;
  resume(input: GroupResumeRequest, ctx: GroupAdminContext): Promise<GroupResumeResponse>;
}
