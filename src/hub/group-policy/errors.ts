/** Shared error identity for physical admission and the operational policy readers. */
export class HubGroupPolicyError extends Error {
  constructor(readonly code: "unavailable" | "conflict" | "unsupported" | "invalid" | "audit") { super(`group_policy_${code}`); }
}
/** Capacity pressure is retryable; malformed/unknown authority remains a separate refusal. */
export class HubGroupReadOverload extends HubGroupPolicyError { constructor() { super("unavailable"); } }
