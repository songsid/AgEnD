import { z } from "zod";
import type { ContactPerson } from "./contact-auth-types.js";

const text = z.string().min(1).max(160).refine(value => !/[\r\n\x00-\x1f\x7f]/.test(value));
export const ContactPersonSchema = z.strictObject({ platform: z.enum(["discord", "telegram", "host"]),
  adapterId: text, userId: text, label: text });
const future = z.iso.datetime();
const uses = z.number().int().min(1).max(10_000).nullable();
export const ContactDecisionSchema = z.strictObject({ revision: z.number().int().positive(),
  decision: z.enum(["approve-once", "decline"]), grant: z.strictObject({ expiresAt: future, remainingUses: uses,
    personKeys: z.array(z.string().min(1).max(512)).min(1).max(16).optional() }).optional() })
  .refine(value => !value.grant || value.decision === "approve-once");
export const ContactOriginClearSchema = z.strictObject({ revision: z.number().int().nonnegative(),
  originRevision: z.number().int().nonnegative(), generation: text });
export const ContactPermissionsSchema = z.strictObject({ revision: z.number().int().nonnegative(),
  mode: z.enum(["legacy", "restricted"]).optional(), approvers: z.array(ContactPersonSchema).max(10).optional(),
  roomTools: z.strictObject({ publicRead: z.boolean(), allowedMcpTools: z.array(z.strictObject({
    name: z.string().min(1).max(240).regex(/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/),
    kind: z.literal("mcp"), usesOwnerAccount: z.boolean(), accountWarning: text.optional(),
  })).max(50) }).optional(),
  grants: z.array(z.strictObject({ id: z.string().max(80), person: ContactPersonSchema,
    source: text, target: text, verbs: z.array(z.enum(["send_to_instance", "delegate_task", "request_information", "broadcast", "report_result"])).min(1).max(5),
    expiresAt: future, remainingUses: z.number().int().min(0).max(10_000).nullable() })).max(100).optional() });

/** Compare authority identities, never mutable labels. */
export function sameContactPerson(left: ContactPerson, right: ContactPerson): boolean {
  return left.platform === right.platform && left.userId === right.userId;
}
