/** Cosmetic owner inventory. No folder, configuration, content or local lifecycle token crosses the link. */
import { createHash, randomUUID } from "node:crypto";
import { canonicalArguments } from "../identity.js";
import { validated } from "../validation.js";
import { agentCatalogSchema, HUB_AGENT_CATALOG_CAPABILITY, type HubAgentCatalog, type HubAgentCatalogRow } from "../agent-catalog-model.js";
import type { HubMemberLink } from "../client.js";

export type MemberCatalogAgent = HubAgentCatalogRow & { incarnation: string | null };
export function hubPageSharingEnabled(member: Record<string, unknown>): boolean {
  if (member.share_from_hub !== undefined && typeof member.share_from_hub !== "boolean") throw Error("invalid_hub_page_sharing");
  return member.share_from_hub !== false;
}
export function memberAgentCatalog(enabled: boolean, sources: readonly MemberCatalogAgent[]): HubAgentCatalog {
  const sorted = enabled ? [...sources].sort((a,b) => a.instance.localeCompare(b.instance,"en")) : [];
  const text = (s: string, max: number) => {
    let out = s.replace(/[\u0000-\u001f\u007f]/g, " ");
    while (Buffer.byteLength(out, "utf8") > max) out = [...out].slice(0, -1).join("");
    return out;
  };
  const agents = sorted.map(({ incarnation: _private, ...row }) => ({ ...row,
    displayName: text(row.displayName, 256), description: text(row.description, 512) }));
  const revision = createHash("sha256").update(canonicalArguments({ enabled, requests: false, agents: sorted })).digest("hex");
  return validated(agentCatalogSchema, { enabled, requests: false, agents, revision });
}
export class HubMemberAgentCatalog {
  private link: HubMemberLink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private sent: string | null = null;
  private dirty = false;
  private stopped = false;
  constructor(private readonly options: { current(): boolean; enabled: boolean; agents(): MemberCatalogAgent[]; failed?(): void }) {}
  connected(link: HubMemberLink): void {
    if (this.stopped || !this.options.current() || !link.current() || !link.features.has(HUB_AGENT_CATALOG_CAPABILITY)) return;
    this.link = link; this.sent = null;
    if (!this.timer) { this.timer = setInterval(() => { void this.refresh(); }, 3_000); this.timer.unref(); }
    void this.refresh();
  }
  disconnected(): void { this.link = null; this.sent = null; if (this.timer) clearInterval(this.timer); this.timer = null; }
  refresh(force = false): Promise<void> {
    if (force) this.sent = null;
    this.dirty = true;
    if (this.running) return this.running;
    this.running = this.flush().catch(() => { try { this.options.failed?.(); } catch { /* optional diagnostic */ } })
      .finally(() => { this.running = null; if (this.dirty && this.link?.current()) void this.refresh(); });
    return this.running;
  }
  private async flush(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const link = this.link;
      if (this.stopped || !link?.current() || !this.options.current()) return;
      const body = memberAgentCatalog(this.options.enabled, this.options.enabled ? this.options.agents() : []);
      if (this.sent === body.revision) return;
      if (this.link !== link || !link.current() || !this.options.current()) return;
      await link.send({ v: 1, type: "agent.catalog", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: body });
      if (this.link === link && link.current() && this.options.current()) this.sent = body.revision;
    }
  }
  close(): void { this.stopped = true; this.disconnected(); }
}
