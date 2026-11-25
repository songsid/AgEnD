import { z } from "zod";

/** Capability recognition is not permission to dispatch; the bridge advertises nothing by default. */
export const REQUEST_CONTEXT_VERSION = 1 as const;
export const REQUEST_CONTEXT_CAPABILITY = "request-context-v1" as const;
const id = z.uuid();
const text = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const person = z.strictObject({ kind: z.literal("person"), platform: z.enum(["discord", "telegram", "host"]),
  userId: text, displayName: text.optional() }).refine(value => value.platform !== "host" || value.userId === "operator");
const hub = z.strictObject({ kind: z.enum(["person", "agent", "assistant"]), platform: z.literal("hub"),
  hubId: text, id: text, displayName: text.optional() });
const unknown = z.strictObject({ kind: z.literal("unknown"),
  reason: z.enum(["unidentified", "unproved-recovery", "legacy-operation"]) });
export const RequestContextActorV1Schema = z.union([person, hub, unknown]);
/** Opaque lookup into server-owned audience evidence, not a route supplied by an Agent. */
export const RequestContextAudienceV1Schema = z.strictObject({ kind: z.enum(["room", "web", "hub", "instance"]), ref: id });
export const RequestContextRefV1Schema = z.strictObject({ version: z.literal(REQUEST_CONTEXT_VERSION),
  contextId: id, rootContextId: id, parentContextId: id.optional() }).superRefine((value, ctx) => {
    if (value.parentContextId === value.contextId || (!value.parentContextId && value.rootContextId !== value.contextId)
      || value.parentContextId && value.rootContextId === value.contextId) {
      ctx.addIssue({ code: "custom", message: "Invalid single-parent request context" });
    }
  });
/** Shape validation proves neither parentage nor human authority; admission must resolve the original evidence. */
export const RequestContextV1Schema = z.strictObject({ ref: RequestContextRefV1Schema,
  rootEvidenceRef: text, initiatingActor: RequestContextActorV1Schema,
  ingress: z.enum(["owner", "free-room", "restricted-room", "guest", "hub"]),
  source: z.strictObject({ instance: text, incarnation: text }), sourceAudience: RequestContextAudienceV1Schema,
  returnAudience: RequestContextAudienceV1Schema.optional() }).superRefine((value, ctx) => {
    const hubActor = "platform" in value.initiatingActor && value.initiatingActor.platform === "hub";
    if (hubActor && value.ingress !== "hub" || value.ingress === "hub" && !hubActor && value.initiatingActor.kind !== "unknown") {
      ctx.addIssue({ code: "custom", message: "Hub ingress cannot substitute a native owner identity" });
    }
  });
export const RequestOperationBindingV1Schema = z.strictObject({ version: z.literal(REQUEST_CONTEXT_VERSION),
  operationId: text, contextId: id, rootContextId: id,
  source: z.strictObject({ instance: text, incarnation: text }), target: z.strictObject({ instance: text, incarnation: text }),
  verb: text, payloadSha256: z.string().regex(/^[a-f0-9]{64}$/) });

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type RequestContextActorV1 = DeepReadonly<z.infer<typeof RequestContextActorV1Schema>>;
export type RequestContextRefV1 = DeepReadonly<z.infer<typeof RequestContextRefV1Schema>>;
export type RequestContextV1 = DeepReadonly<z.infer<typeof RequestContextV1Schema>>;
export type RequestOperationBindingV1 = DeepReadonly<z.infer<typeof RequestOperationBindingV1Schema>>;
