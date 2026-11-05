/**
 * S3c (S-55): what the member's Settings card reads and does with its exposures — the projection S3a's client expects
 * (docs/design/hub-ui-client.md "HubExposureView", widened with web-claude: `choices` and `pending`) and the owner's
 * three operations. Local-owner only; the HTTP routes (settings-api.ts) refuse the public link, and publish/revise run
 * only as a confirmed Settings replay. Built by S5's member composition from the store, the sender, S4 and the agents.
 */
import { HUB_READ_TOOLS, type HubDocumentView } from "../execution/views.js";
import type { HubExecutionReadiness, HubLocalExposure } from "../execution/service.js";
import { isHubProviderSetupReason, type HubProviderSetupReason } from "../execution/provider-setup.js";
import { HubExposureRefusal, publishExposure, type HubExposureStore } from "./exposures.js";

export interface HubExposureView {
  agent: string; display: string; exposureId: string | null; revision: number;
  state: "published" | "withdrawn" | "frozen"; policy: { dataView: string; tools: string[] } | null;
  enforceable: boolean; reason?: string;
  /** The owner's locally approved choices for this agent (empty: none — not shareable). */
  choices: { dataViews: Array<{ id: string; label: string }>; tools: Array<{ name: string; label: string }> };
  /** A publish waiting for the owner's Settings confirmation (the confirmation layer's), or null. */
  pending: { expiresAt: number } | null;
}
export interface HubMemberAgent { name: string; display: string; providerId: string | null }
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

const TOOL_LABEL: Record<string, string> = { "documents.list": "List documents", "documents.read": "Read documents" };
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
  /** S4: readinessCandidate (a candidate) and readiness (a committed mapping). */
  readinessCandidate(candidate: HubLocalExposure): HubExecutionReadiness;
  readiness(exposureId: string, expectedRevision: number): HubExecutionReadiness;
  /** S4 provider availability, including unpublished agents. Metadata only; publish still checks its exact candidate. */
  providerReason?(agent: HubMemberAgent): HubProviderSetupReason | "provider-unavailable" | null;
  /** The local owner's agents (never the Hub's inventory), with the S4 provider each would run under (null: none). */
  agents(): HubMemberAgent[];
  /** The same approved-view registry S4 has. */
  views: ReadonlyMap<string, HubDocumentView>;
  /** S1: after a commit, the snapshot to the Hub (pending). */
  afterCommit(): Promise<unknown>;
  /** The confirmation layer's pending publish for an agent, if any. */
  pending?(agent: string): { expiresAt: number } | null;
}): HubMemberExposureApi {
  const agentOf = (name: string) => deps.agents().find((a) => a.name === name) ?? null;
  const choices = (a: HubMemberAgent): HubExposureView["choices"] => a.providerId
    ? { dataViews: [...deps.views.values()].map((v) => ({ id: v.id, label: v.id })), tools: HUB_READ_TOOLS.map((name) => ({ name, label: TOOL_LABEL[name] ?? name })) }
    : { dataViews: [], tools: [] };
  const viewOf = (a: HubMemberAgent): HubExposureView => {
    const row = deps.store.list().find((r) => r.agent === a.name), c = row?.committed ?? null, e = c?.exposure ?? null;
    const ready = e && e.state === "published" ? deps.readiness(e.id, e.revision) : null;
    let providerReason: HubProviderSetupReason | "provider-unavailable" | null = null;
    try {
      const reason = deps.providerReason?.(a);
      if (reason != null) providerReason = isHubProviderSetupReason(reason) ? reason : "provider-unavailable";
    } catch { providerReason = "provider-unavailable"; }
    const enforceable = !providerReason && !!a.providerId && deps.views.size > 0 && (ready ? ready.ok : true);
    return { agent: a.name, display: a.display, exposureId: e?.id ?? null, revision: e?.revision ?? 0, state: e?.state ?? "withdrawn",
      policy: e && e.state !== "withdrawn" ? { dataView: e.dataViewId, tools: [...e.allowedTools] } : null,
      enforceable, ...(enforceable ? {} : { reason: providerReason ?? (!a.providerId ? "no_restricted_provider" : deps.views.size === 0 ? "no_approved_view" : (ready && !ready.ok ? ready.reasonCode : "unavailable")) }),
      choices: choices(a), pending: deps.pending?.(a.name) ?? null };
  };
  const checked = (raw: unknown) => {
    const input = publishInput(raw), a = agentOf(input.agent);
    if (!a) throw new HubExposureRefusal("unknown_agent");
    if (!a.providerId) throw new HubExposureRefusal("not_enforceable");
    return { input, a };
  };
  return {
    list: () => deps.agents().map(viewOf),
    preview(raw) {
      const { input, a } = checked(raw);
      if (!deps.views.get(input.dataViewId)) throw new HubExposureRefusal("unknown_view");
      return { summary: [`Share "${a.display}" with the Hub`, `Data view: ${input.dataViewId}`, `Tools: ${[...input.tools].sort().join(", ") || "none"}`, `Revision: ${input.expectedRevision + 1}`] };
    },
    publish(raw) {
      const { input, a } = checked(raw);
      publishExposure(deps.store, { agent: a.name, providerId: a.providerId!, displayName: a.display, dataViewId: input.dataViewId, allowedTools: input.tools,
        expectedRevision: input.expectedRevision }, deps.readinessCandidate);
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
