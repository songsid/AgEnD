/**
 * S3c (S-55): what the member's Settings card reads and does with its exposures — the projection S3a's client expects
 * (docs/design/hub-ui-client.md "HubExposureView", widened with web-claude: `choices` and `pending`) and the owner's
 * three operations. Local-owner only; the HTTP routes (settings-api.ts) refuse the public link, and publish/revise run
 * only as a confirmed Settings replay. Built by S5's member composition from the store, the sender and the agents.
 *
 * P1 shares a representative agent (docs/design/hub-representative-agent.md): the owner picks one of this fleet's
 * configured agents, and the only descriptor published is agent-mode.ts's exact tuple. The DTO keeps its shape for a
 * tab loaded before the change: `choices.dataViews` is the one "agent" entry and `choices.tools` is empty (an old
 * picker needs a tool, so it cannot publish), `policy.tools` is [], and refusals stay inside HubExposureError.
 * A legacy (container) mapping stays durable and withdrawable but says `republish_required` until the owner shares the
 * agent again through the same confirmed, revision-checked publish; it is never converted silently.
 */
import type { HubExecutionReadiness, HubLocalExposure } from "../execution/service.js";
import { HUB_AGENT_MODE, isAgentDescriptor } from "./agent-mode.js";
import { HubExposureRefusal, publishExposure, type HubExposureStore } from "./exposures.js";

export interface HubExposureView {
  agent: string; display: string; exposureId: string | null; revision: number;
  state: "published" | "withdrawn" | "frozen"; policy: { dataView: string; tools: string[] } | null;
  enforceable: boolean; reason?: string;
  /** What the owner can share for this agent: the agent itself (one "agent" entry) and no Hub tools. */
  choices: { dataViews: Array<{ id: string; label: string }>; tools: Array<{ name: string; label: string }> };
  /** A publish waiting for the owner's Settings confirmation (the confirmation layer's), or null. */
  pending: { expiresAt: number } | null;
}
/** One of this fleet's configured agents, as normal delivery addresses it (`name`) and the owner sees it (`display`). */
export interface HubMemberAgent { name: string; display: string }
export interface HubPublishInput { agent: string; dataViewId: string; tools: string[]; expectedRevision: number }
export interface HubMemberExposureApi {
  list(): HubExposureView[];
  /** The confirmation's summary for a publish (checked: a refusal throws HubExposureRefusal). */
  preview(input: unknown): { summary: string[] };
  /** Publish or revise (run only after the owner confirmed). */
  publish(input: unknown): HubExposureView;
  /** Withdraw at once: ok once the restrictive state is saved; the Hub learns it with the next snapshot ("pending"). */
  withdraw(exposureId: string, expectedRevision: number): Promise<{ remote: "pending" }>;
}

/** A publish request, strictly: unknown keys, odd types or a non-whole revision are refused (unknown_agent covers a bad name). */
export function publishInput(raw: unknown): HubPublishInput {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => !["agent", "dataViewId", "tools", "expectedRevision"].includes(k))) throw new HubExposureRefusal("conflict");
  if (typeof r.agent !== "string" || !r.agent || typeof r.dataViewId !== "string" || !Array.isArray(r.tools) || !r.tools.every((t) => typeof t === "string")
    || !Number.isSafeInteger(r.expectedRevision) || (r.expectedRevision as number) < 0) throw new HubExposureRefusal("conflict");
  return { agent: r.agent, dataViewId: r.dataViewId, tools: r.tools as string[], expectedRevision: r.expectedRevision as number };
}

export function createHubMemberExposureApi(deps: {
  store: HubExposureStore;
  /** This fleet's configured agents that normal delivery accepts (never the Hub's inventory, never the Hub daemon). */
  agents(): HubMemberAgent[];
  /** S1: after a commit, the snapshot to the Hub (pending). */
  afterCommit(): Promise<unknown>;
  /** The confirmation layer's pending publish for an agent, if any. */
  pending?(agent: string): { expiresAt: number } | null;
  /**
   * S5's representative adapter (optional): asked after this API's own check passes, before the stage and again INSIDE
   * the atomic publish transaction (where it may record the agent's lifecycle against candidate.consentId). Its refusal
   * refuses the publish (not_enforceable) and drops the candidate.
   */
  readinessCandidate?(candidate: HubLocalExposure): HubExecutionReadiness;
}): HubMemberExposureApi {
  const agentOf = (name: string) => deps.agents().find((a) => a.name === name) ?? null;
  /** Publish readiness (asked again inside the atomic publish): the exact descriptor of a still-configured agent. */
  const readiness = (c: HubLocalExposure): HubExecutionReadiness => {
    if (!isAgentDescriptor(c)) return { ok: false, reasonCode: "policy-unavailable" };
    if (!agentOf(c.agent)) return { ok: false, reasonCode: "provider-unavailable" };
    return deps.readinessCandidate ? deps.readinessCandidate(c) : { ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision };
  };
  const viewOf = (a: HubMemberAgent): HubExposureView => {
    const row = deps.store.list().find((r) => r.agent === a.name), c = row?.committed ?? null, e = c?.exposure ?? null;
    const legacy = !!c && !!e && e.state !== "withdrawn" && !isAgentDescriptor(c);
    return { agent: a.name, display: a.display, exposureId: e?.id ?? null, revision: e?.revision ?? 0, state: e?.state ?? "withdrawn",
      policy: e && e.state !== "withdrawn" ? { dataView: e.dataViewId, tools: [...e.allowedTools] } : null,
      enforceable: !legacy, ...(legacy ? { reason: "republish_required" } : {}),
      choices: { dataViews: [{ id: HUB_AGENT_MODE, label: a.display }], tools: [] }, pending: deps.pending?.(a.name) ?? null };
  };
  const checked = (raw: unknown) => {
    const input = publishInput(raw), a = agentOf(input.agent);
    if (!a) throw new HubExposureRefusal("unknown_agent");
    // A tab from before P1's change may still send a document view: nothing but the agent itself is shareable.
    if (input.dataViewId !== HUB_AGENT_MODE) throw new HubExposureRefusal("unknown_view");
    if (input.tools.length !== 0) throw new HubExposureRefusal("not_enforceable");
    return { input, a };
  };
  return {
    list: () => deps.agents().map(viewOf),
    preview(raw) {
      const { input, a } = checked(raw);
      return { summary: [`Share "${a.display}" with the Hub`, "Hub questions go to this agent's own conversation, with its folder and Settings tools",
        `Revision: ${input.expectedRevision + 1}`] };
    },
    publish(raw) {
      const { input, a } = checked(raw);
      publishExposure(deps.store, { agent: a.name, providerId: HUB_AGENT_MODE, displayName: a.display, dataViewId: HUB_AGENT_MODE, allowedTools: [],
        expectedRevision: input.expectedRevision }, readiness);
      void deps.afterCommit().catch(() => {});
      return viewOf(a);
    },
    async withdraw(exposureId, expectedRevision) {
      deps.store.withdraw(exposureId, expectedRevision);
      void deps.afterCommit().catch(() => {});
      return { remote: "pending" };
    },
  };
}
