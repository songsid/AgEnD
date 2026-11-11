/** Narrow composition gate. No network/store/key/directory import or I/O on the ordinary off path. */
import type { HubMode, HubMemberLeaveBinding } from "./types.js";
export interface HubMountedService { start(): Promise<void>; fence(): void; close(): Promise<void>; leave?(expected: HubMemberLeaveBinding): Promise<boolean> }
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
  private serverGeneration = 0;
  private memberConfiguration: string | null = null;
  private serverOn = false;
  private memberOn = false;
  private server: HubMountedService | null = null;
  private member: HubMountedService | null = null;
  // Includes factories and startup: close must drain their eventual physical resources too.
  private transition: Promise<void> = Promise.resolve();
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.transition.then(work);
    this.transition = result.catch(() => {});
    return result;
  }
  private async drain(kinds: readonly ("server" | "member")[] = ["server", "member"]): Promise<void> {
    const owned = kinds.filter(kind => this[kind] !== null);
    const results = await Promise.allSettled(owned.map(async kind => {
      const service = this[kind]!; service.fence(); await service.close();
      if (this[kind] === service) this[kind] = null; // Retain ownership until positive shutdown.
    }));
    if (results.some(r => r.status === "rejected")) { this.options.hold("service-unavailable"); throw Error("Hub cleanup is unconfirmed"); }
  }
  constructor(private readonly options: HubMountOptions) {}
  epoch(): number { return this.generation; }
  serverEnabled(): boolean { return this.serverOn; }
  memberEnabled(): boolean { return this.memberOn; }
  async memberLeave(expected: HubMemberLeaveBinding): Promise<boolean> {
    const selected = this.member, generation = this.generation;
    if (!this.memberOn || !selected?.leave) return false;
    try { return await selected.leave(expected) === true && this.memberOn && this.member === selected && this.generation === generation; }
    catch { return false; }
  }
  /** Revocation is synchronous, before asynchronous stop/import/start work. */
  fenceServer(): void {
    this.serverGeneration++; this.serverOn = false; this.server?.fence();
  }
  fence(): void {
    this.generation++; this.fenceServer(); this.memberOn = false; this.member?.fence();
  }
  /** A local server journal has no authority over an unchanged membership in another Hub. */
  holdServer(input: { hub_member?: unknown }): Promise<void> {
    const member = record(input.hub_member) && input.hub_member.enabled === true ? JSON.stringify(input.hub_member) : null;
    // Still honor an explicit member disconnect/rebind, including first startup, without attempting the held server.
    if (member !== this.memberConfiguration) return this.apply({ hub_member: input.hub_member });
    this.fenceServer(); return this.enqueue(() => this.drain(["server"]));
  }
  /** Local settings recovery may drain this Hub's server without admitting or changing a member link. */
  closeServer(): Promise<void> {
    this.fenceServer(); return this.enqueue(() => this.drain(["server"]));
  }
  close(): Promise<void> {
    this.fence(); return this.enqueue(() => this.drain());
  }
  apply(input: { hub?: unknown; hub_member?: unknown }): Promise<void> {
    // Revoke synchronously, even while a previous factory/start/cleanup is still awaiting.
    this.fence(); const generation = this.generation, serverGeneration = this.serverGeneration, snapshot = structuredClone(input);
    this.memberConfiguration = record(snapshot.hub_member) && snapshot.hub_member.enabled === true ? JSON.stringify(snapshot.hub_member) : null;
    return this.enqueue(() => this.applyOwned(snapshot, generation, serverGeneration));
  }
  private async applyOwned(input: { hub?: unknown; hub_member?: unknown }, generation: number, serverGeneration: number): Promise<void> {
    await this.drain();
    if (generation !== this.generation) return;
    const server = record(input.hub) && input.hub.enabled === true ? structuredClone(input.hub) : null;
    const member = record(input.hub_member) && input.hub_member.enabled === true ? structuredClone(input.hub_member) : null;
    if (!server && !member) return;
    if (server && serverGeneration === this.serverGeneration) await (async () => {
      let reason: "initialization" | "service-unavailable" = "initialization";
      try {
        if (typeof server.hubId !== "string" || typeof server.memberOrigin !== "string") throw Error("Invalid Hub configuration");
        const digest = this.options.planDigest(server);
        const { verifyHubInitialization } = await import("./initialization.js");
        if (generation !== this.generation || serverGeneration !== this.serverGeneration) return;
        verifyHubInitialization({ home: this.options.home, hubId: server.hubId, memberOrigin: server.memberOrigin, planDigest: digest });
        reason = "service-unavailable"; this.serverOn = true;
        const current = () => this.serverOn && generation === this.generation && serverGeneration === this.serverGeneration;
        const service = await this.options.createServer(server, current);
        this.server = service;
        if (!current()) { await this.drain(["server"]); return; }
        await service.start();
        if (!current()) { await this.drain(["server"]); return; }
      } catch {
        if (generation === this.generation && serverGeneration === this.serverGeneration) { this.serverOn = false; this.options.hold(reason); }
        await this.drain(["server"]);
      }
    })();
    if (member && generation === this.generation) {
      let reason: "member-pairing" | "service-unavailable" = "member-pairing";
      try {
        // The member factory owns validation of its atomic pairing receipt and consent generation.
        this.memberOn = true;
        const current = () => this.memberOn && generation === this.generation;
        const service = await this.options.createMember(member, current);
        reason = "service-unavailable"; this.member = service;
        if (!current()) { await this.drain(); return; }
        await service.start();
        if (!current()) { await this.drain(); return; }
      } catch {
        if (generation === this.generation) { this.memberOn = false; this.options.hold(reason); }
        await this.drain();
      }
    }
  }
}
