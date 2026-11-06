/**
 * Hub P1 representative agent (docs/design/hub-representative-agent.md, decision f619f813): the one exposure
 * descriptor P1 publishes. The owner shares an existing fleet agent; Hub questions reach it through normal delivery.
 * The v1 wire shape is kept, filled with fixed values:
 *
 *   providerId "agent" (member-local) · dataViewId "agent" · allowedTools [] · policyDigest sha256(canonical {mode, agent})
 *
 * `agent` is the stable local instance name, never its label. The empty tool list means no Hub-delegated tool phases;
 * the agent keeps its ordinary Settings tools. Anything else (a legacy container row) is never this descriptor.
 */
import { canonicalArguments, sha256 } from "../identity.js";
import type { HubLocalExposure } from "../execution/service.js";

export const HUB_AGENT_MODE = "agent" as const;

/** The policy digest of `agent`'s representative exposure. */
export function agentPolicyDigest(agent: string): string {
  return sha256(canonicalArguments({ mode: HUB_AGENT_MODE, agent }));
}

/** True only for the exact representative tuple of its own agent (S5 delivers on nothing else). */
export function isAgentDescriptor(local: Pick<HubLocalExposure, "agent" | "providerId" | "exposure">): boolean {
  const e = local.exposure;
  return local.providerId === HUB_AGENT_MODE && e.dataViewId === HUB_AGENT_MODE && Array.isArray(e.allowedTools)
    && e.allowedTools.length === 0 && e.policyDigest === agentPolicyDigest(local.agent);
}
