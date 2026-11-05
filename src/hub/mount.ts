/** Narrow composition gate. No network/store/key/directory import or I/O on the ordinary off path. */
import type { HubMode } from "./types.js";
export interface HubMountedService { start(): Promise<void>; fence(): void; close(): Promise<void> }
export interface HubMountOptions {
  home: string;
  /** S5's pure hub/init/plan-digest.ts canonical config projection. Never hash a caller-selected subset. */
  planDigest(configuration: Record<string, unknown>): string;
  createServer(configuration: Record<string, unknown>, current: () => boolean): Promise<HubMountedService>;
  /** Must validate the member's locally confirmed private pairing receipt; YAML alone is insufficient. */
  createMember(configuration: Record<string, unknown>, current: () => boolean): Promise<HubMountedService>;
  hold(reason: "initialization" | "member-pairing" | "service-unavailable"): void;
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
export class HubMount implements HubMode {
  private generation = 0;
  private serverOn = false;
  private memberOn = false;
  private server: HubMountedService | null = null;
  private member: HubMountedService | null = null;
  constructor(private readonly options: HubMountOptions) {}
  epoch(): number { return this.generation; }
  serverEnabled(): boolean { return this.serverOn; }
  memberEnabled(): boolean { return this.memberOn; }
  /** Revocation is synchronous, before asynchronous stop/import/start work. */
  fence(): void {
    this.generation++; this.serverOn = this.memberOn = false;
    this.server?.fence(); this.member?.fence();
  }
  async close(): Promise<void> {
    this.fence(); const server = this.server, member = this.member; this.server = this.member = null;
    const results = await Promise.allSettled([server?.close(), member?.close()]);
    if (results.some(r => r.status === "rejected")) { this.options.hold("service-unavailable"); throw Error("Hub cleanup is unconfirmed"); }
  }
  async apply(input: { hub?: unknown; hub_member?: unknown }): Promise<void> {
    // Neither a query parameter, env variable nor a page mark reaches this branch.
    this.fence(); const generation = this.generation;
    const oldServer = this.server, oldMember = this.member; this.server = this.member = null;
    try { await Promise.all([oldServer?.close(), oldMember?.close()]); }
    catch { if (generation === this.generation) this.options.hold("service-unavailable"); throw Error("Hub cleanup is unconfirmed"); }
    if (generation !== this.generation) return;
    const server = record(input.hub) && input.hub.enabled === true ? structuredClone(input.hub) : null;
    const member = record(input.hub_member) && input.hub_member.enabled === true ? structuredClone(input.hub_member) : null;
    if (!server && !member) return;
    if (server) {
      let reason: "initialization" | "service-unavailable" = "initialization";
      try {
        if (typeof server.hubId !== "string" || typeof server.memberOrigin !== "string") throw Error("Invalid Hub configuration");
        const digest = this.options.planDigest(server);
        const { verifyHubInitialization } = await import("./initialization.js");
        if (generation !== this.generation) return;
        verifyHubInitialization({ home: this.options.home, hubId: server.hubId, memberOrigin: server.memberOrigin, planDigest: digest });
        reason = "service-unavailable"; this.serverOn = true;
        const current = () => this.serverOn && generation === this.generation;
        const service = await this.options.createServer(server, current);
        if (!current()) { service.fence(); await service.close(); return; }
        this.server = service; await service.start();
        if (!current()) { service.fence(); await service.close(); return; }
      } catch {
        if (generation === this.generation) { this.serverOn = false; this.server?.fence(); await this.server?.close().catch(() => {}); this.server = null; this.options.hold(reason); }
      }
    }
    if (member && generation === this.generation) {
      let reason: "member-pairing" | "service-unavailable" = "member-pairing";
      try {
        // The member factory owns validation of its atomic pairing receipt and consent generation.
        this.memberOn = true;
        const current = () => this.memberOn && generation === this.generation;
        const service = await this.options.createMember(member, current);
        if (!current()) { service.fence(); await service.close(); return; }
        reason = "service-unavailable"; this.member = service; await service.start();
        if (!current()) { service.fence(); await service.close(); return; }
      } catch {
        if (generation === this.generation) { this.memberOn = false; this.member?.fence(); await this.member?.close().catch(() => {}); this.member = null; this.options.hold(reason); }
      }
    }
  }
}
