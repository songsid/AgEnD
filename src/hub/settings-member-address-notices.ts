/** Original recipients can read/ack their durable notice after remount. Notice access grants no pairing authority. */
import type { HubRequestContext } from "./types.js";
import type { HubMemberAddressDecision } from "./settings-member-address-decision.js";
import { HubProtocolError } from "./validation.js";
import { personKeyString } from "./identity.js";
export function createHubMemberAddressNotices(decision: HubMemberAddressDecision, live: () => boolean) {
  const recipient = async (ctx: HubRequestContext) => {
    const who = await ctx.requirePerson(), actor = await ctx.current();
    if (!live() || ctx.isCurrent?.() !== true || actor.kind !== "directory" || personKeyString(actor.person) !== personKeyString(who)) throw new HubProtocolError("revoked");
    return { kind: "person" as const, person: who };
  };
  return {
    async forSession(ctx: HubRequestContext, before?: number) {
      const who = await recipient(ctx);
      return decision.notices(who, () => live() && ctx.isCurrent?.() === true, before);
    },
    async acknowledgeSession(ctx: HubRequestContext, id: string) {
      const who = await recipient(ctx);
      decision.acknowledge(id, who, () => live() && ctx.isCurrent?.() === true);
    },
  };
}
export type HubMemberAddressNotices = ReturnType<typeof createHubMemberAddressNotices>;
