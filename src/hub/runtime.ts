/**
 * S5b lifecycle (S-51; docs/design/hub-composition.md §2). FleetManager imports this module only when a Hub switch is
 * on (or a runtime is already live) and calls:
 *   apply(config) on start and on every configuration change (reload, Settings save, rollback),
 *   fence() synchronously when the fleet starts stopping, close() inside its drain.
 *
 * apply() is serialized (later calls coalesce to the newest configuration) and a no-op when the effective Hub view is
 * unchanged. A change fences first, then closes, then mounts again through S1's HubMount (which verifies the sealed
 * manifest). Failures never throw into the fleet: they become one visible hold with a reason code.
 */
import { createHubDirectory, type HubDirectory, type HubDirectoryConfig } from "./directory/index.js";
import { hubPlanDigest } from "./init/plan-digest.js";
import { hubPreviewReloadKey } from "./preview.js";
import { HubMount, type HubMountedService } from "./mount.js";
import { createHubServerFactory, type HubHttpEntry, type HubServerComponents } from "./compose/server.js";
import { createHubMemberFactory, type HubMemberComponents, type HubMemberFactoryOptions } from "./compose/member.js";
import type { HubViewSource } from "./compose/views.js";

/** The member side's slices (S4, S3c, S4b), imported lazily only inside the member factory. */
export const MEMBER_COMPONENTS: HubMemberComponents = {
  execution: () => import("./execution/index.js"),
  exposures: async () => {
    const [store, api] = await Promise.all([import("./member/exposures.js"), import("./member/exposure-api.js")]);
    return { store, api };
  },
  provider: async () => {
    const [cli, broker] = await Promise.all([import("./execution/cli-provider.js"), import("./execution/model-broker.js")]);
    return { createHubCliProvider: cli.createHubCliProvider, createHubModelBroker: broker.createHubModelBroker };
  },
};

/** What the fleet gives the member side (FleetManager): its binding, agents and attachment points. */
export type HubMemberHost = Pick<HubMemberFactoryOptions, "boundHub" | "agents" | "representative" | "attachExposures" | "attachAttention" | "attachPairingNotices" | "pokeAttention" | "linkState"> & {
  views?: HubViewSource;
};

/**
 * The Hub web service (S3b, src/hub/http/compose.ts), imported lazily only inside the server factory. S3b takes
 * S5's hubTxDatabase as its second argument.
 */
export const S3B_HTTP_ENTRY = async (): Promise<HubHttpEntry> => {
  const s3 = await import("./http/compose.js");
  return { migrations: s3.migrations, createHubHttp: (deps) => s3.createHubHttp(deps, hubTxDatabase) };
};
import { hubTxDatabase, type HubHoldCode } from "./db.js";

export interface HubHold {
  side: "server" | "member";
  code: HubHoldCode;
  detail: string;
  since: number;
  /** A bounded setup reason (provider holds) for localized guidance; never raw error text. */
  reason?: string;
}

export interface HubRuntimeOptions {
  home: string;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  /** Called whenever the hold set changes (FleetManager re-renders its status / Needs-you). */
  onHoldsChanged?(holds: readonly HubHold[]): void;
  now?: () => number;
  /** Test seams. */
  components?: HubServerComponents;
  createDirectory?: (config: HubDirectoryConfig, secrets: { bindPassword: string }) => HubDirectory;
  /** The fleet's side of a Hub membership; absent: the member side holds hub-incomplete. */
  member?: HubMemberHost;
  memberComponents?: HubMemberComponents;
  createServer?: (cfg: Record<string, unknown>, current: () => boolean) => Promise<HubMountedService>;
  createMember?: (cfg: Record<string, unknown>, current: () => boolean) => Promise<HubMountedService>;
}

export type HubServerHealth = "off" | "starting" | "ready" | "unavailable" | "stopped";

type HubConfigView = { hub?: unknown; hub_member?: unknown };

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** True when the raw config turns either Hub switch on (the only thing FleetManager checks before importing us). */
export function hubSwitchesOn(raw: HubConfigView | null | undefined): boolean {
  return obj(raw?.hub)?.enabled === true || obj(raw?.hub_member)?.enabled === true;
}

/** What a reload compares: switches, sealed settings, local preview opt-in, and the member section as written. */
export function effectiveHubView(raw: HubConfigView | null | undefined): string {
  const hub = obj(raw?.hub);
  const member = obj(raw?.hub_member);
  return JSON.stringify({
    server: hub?.enabled === true ? hubPlanDigest(hub) : null,
    preview: hub?.enabled === true ? hubPreviewReloadKey(hub.web) : null,
    member: member?.enabled === true ? JSON.stringify(member) : null,
  });
}

const MOUNT_CODE: Record<"initialization" | "member-pairing" | "service-unavailable", HubHoldCode> = {
  initialization: "hub-unsealed",
  "member-pairing": "hub-member-pairing",
  "service-unavailable": "service-unavailable",
};

export class HubRuntime {
  private browserCertificateControl: import("./browser-certificate.js").HubBrowserCertificateControl | null = null;
  browserCertificateSettings(): import("./browser-certificate.js").HubBrowserCertificateControl | null { return this.browserCertificateControl; }
  private retentionControl: import("./retention.js").HubRetentionControl | null = null;
  retentionSettings(): import("./retention.js").HubRetentionControl | null { return this.retentionControl; }
  /** #3298 S-89: the mounted Hub offers group permissions (S-88's control is composed). Marks this fleet's pages only. */
  private groupPermissions = 0;
  groupPermissionsAvailable(): boolean { return this.groupPermissions > 0; }
  private readonly mount: HubMount;
  private view: string | null = null;
  /** The newest configuration view asked for (admitted), which may still be waiting behind a running apply. */
  private admitted: string | null = null;
  private running: Promise<void> | null = null;
  private pending: HubConfigView | null = null;
  private lastConfig: HubConfigView | null = null;
  private stopped = false;
  private holds: HubHold[] = [];
  /** The most specific reason a factory reported for the side currently being mounted. */
  private reported: { side: "server" | "member"; code: HubHoldCode; detail: string } | null = null;
  private mounting: "server" | "member" | null = null;
  /** Retries cleanup a failed server creation could not confirm (never handed to HubMount). */
  private readonly drainServer: () => Promise<void>;
  /** The member factory's leftover (same rules), drained when the member switch is off and on Stop. */
  private readonly drainMember: () => Promise<void>;
  /** A leftover whose cleanup is still unconfirmed: every later Off (even an unchanged one) and Stop retries it. */
  private leftover = false;

  constructor(private readonly options: HubRuntimeOptions) {
    const now = options.now ?? Date.now;
    const composed = options.createServer
      ? null
      : createHubServerFactory({
          home: options.home,
          components: options.components ?? { http: S3B_HTTP_ENTRY },
          createDirectory: options.createDirectory ?? createHubDirectory,
          browserCertificateReady: control => {
            this.browserCertificateControl = control;
            return () => { if (this.browserCertificateControl === control) this.browserCertificateControl = null; };
          },
          retentionReady: control => {
            this.retentionControl = control;
            return () => { if (this.retentionControl === control) this.retentionControl = null; };
          },
          groupPermissionsReady: () => {
            this.groupPermissions++;
            let done = false;
            return () => { if (!done) { done = true; this.groupPermissions--; } };
          },
        report: (code, detail) => {
          this.reported = { side: "server", code, detail };
        },
          log: options.log,
          now,
        });
    this.drainServer = composed ? () => composed.drain() : async () => {};
    const serverFactory = options.createServer ?? composed!;
    const memberComposed = options.createMember || !options.member
      ? null
      : createHubMemberFactory({
          home: options.home,
          components: options.memberComponents ?? MEMBER_COMPONENTS,
          ...options.member,
          ...(options.member.views ? { views: options.member.views } : {}),
          report: (code, detail) => {
            this.reported = { side: "member", code, detail };
          },
          // Non-fatal: the member keeps running (no provider); the hold stays until the member is rebuilt.
          notice: (code, reason, detail) => this.addHold({ side: "member", code, detail, reason, since: now() }),
          log: options.log,
          now,
        });
    const memberFactory =
      options.createMember ??
      memberComposed ??
      (async () => {
        this.reported = { side: "member", code: "hub-incomplete", detail: "the Hub member side is not wired in this fleet" };
        throw new Error("hub-incomplete");
      });
    this.drainMember = memberComposed ? () => memberComposed.drain() : async () => {};
    this.mount = new HubMount({
      home: options.home,
      planDigest: hubPlanDigest,
      createServer: (cfg, current) => {
        this.mounting = "server";
        return serverFactory(cfg, current);
      },
      createMember: (cfg, current) => {
        this.mounting = "member";
        return memberFactory(cfg, current);
      },
      hold: (reason) => {
        const side = this.mounting ?? "server";
        const specific = this.reported && this.reported.side === side ? this.reported : null;
        this.addHold({ side, code: specific?.code ?? MOUNT_CODE[reason], detail: specific?.detail ?? reason, since: now() });
        this.reported = null;
      },
    });
  }

  currentHolds(): readonly HubHold[] {
    return this.holds;
  }

  /** Availability of the configured local server mount, not a directory/link/model or remote-reachability probe. */
  serverHealth(expected: unknown): HubServerHealth {
    const server = obj(expected);
    if (server?.enabled !== true) return "off";
    if (this.stopped) return "stopped";
    // serverEnabled is an admission fence set before the factory/start awaits: it is not readiness on its own.
    if (this.running || this.pending || this.admitted === null) return "starting";
    if (this.view === null) return "unavailable";
    try {
      // Compare the captured immutable view, not lastConfig's caller-owned object, which can change in place.
      const view = JSON.parse(this.view);
      if (hubPlanDigest(server) !== view.server || hubPreviewReloadKey(server.web) !== view.preview) return "starting";
    } catch { return "unavailable"; }
    return this.mount.serverEnabled() ? "ready" : "unavailable";
  }

  private addHold(hold: HubHold): void {
    this.holds = [...this.holds.filter((h) => h.side !== hold.side), hold];
    this.options.log("warn", "Hub unavailable", { side: hold.side, code: hold.code, detail: hold.detail });
    this.options.onHoldsChanged?.(this.holds);
  }

  private clearHolds(): void {
    if (this.holds.length === 0) return;
    this.holds = [];
    this.options.onHoldsChanged?.(this.holds);
  }

  /** Serialized: one apply at a time; calls made meanwhile coalesce to the newest configuration. */
  apply(config: HubConfigView): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const view = effectiveHubView(config);
    if (view !== this.admitted) {
      this.admitted = view;
      if (this.running) {
        // A changed configuration revokes the current generation now, even while a factory or start is still held:
        // S1's fence is synchronous, and a held service must not start for a configuration that is already gone.
        this.mount.fence();
        this.view = null; // whatever is applied next is applied for real (A → B → A must not look unchanged)
      }
    }
    this.pending = { hub: config.hub, hub_member: config.hub_member };
    this.lastConfig = this.pending;
    if (!this.running) {
      this.running = (async () => {
        try {
          while (this.pending && !this.stopped) {
            const next = this.pending;
            this.pending = null;
            await this.applyOnce(next);
          }
        } finally {
          this.running = null;
        }
      })();
    }
    return this.running;
  }

  private async applyOnce(config: HubConfigView): Promise<void> {
    const view = effectiveHubView(config);
    if (view === this.view) {
      if (this.leftover) await this.drainLeftovers({ server: obj(config.hub)?.enabled !== true, member: obj(config.hub_member)?.enabled !== true });
      return;
    }
    this.view = view;
    this.clearHolds();
    this.reported = null;
    try {
      await this.mount.apply(config); // fences, closes the previous services, then mounts what is on
      await this.drainLeftovers({ server: obj(config.hub)?.enabled !== true, member: obj(config.hub_member)?.enabled !== true });
    } catch (err) {
      // HubMount already raised its hold (service-unavailable on an unconfirmed cleanup).
      this.options.log("warn", "Hub apply did not finish cleanly", { err: (err as Error).message });
      this.view = null; // the next apply retries from scratch
    } finally {
      this.mounting = null;
    }
  }

  /**
   * The member's binding changed outside the configuration (a pairing was claimed, disconnected or cancelled): rebuild
   * from the last configuration, fencing first, even though its text is unchanged.
   */
  refresh(): Promise<void> {
    if (this.stopped || !this.lastConfig) return Promise.resolve();
    this.admitted = null;
    this.view = null;
    if (this.running) this.mount.fence();
    return this.apply(this.lastConfig);
  }

  /** Synchronous: no new admission, dispatch or listener work from here on. */
  fence(): void {
    this.stopped = true;
    this.pending = null;
    this.mount.fence();
  }

  async close(): Promise<void> {
    this.fence();
    try {
      await this.running;
    } catch {
      /* already reported */
    }
    await this.mount.close();
    await this.drainLeftovers({ server: true, member: true }, true);
  }

  /** Off/Stop: confirm a failed creation's cleanup; while it still fails it stays owned and held (and Stop rejects). */
  private async drainLeftovers(sides: { server: boolean; member: boolean }, rethrow = false): Promise<void> {
    if (!sides.server && !sides.member) return;
    try {
      if (sides.server) await this.drainServer();
      if (sides.member) await this.drainMember();
      if (this.leftover) {
        this.leftover = false;
        const rest = this.holds.filter((h) => !(h.code === "service-unavailable" && ((h.side === "server" && sides.server) || (h.side === "member" && sides.member))));
        if (rest.length !== this.holds.length) {
          this.holds = rest;
          this.options.onHoldsChanged?.(this.holds);
        }
      }
    } catch (err) {
      this.leftover = true;
      this.addHold({ side: sides.server ? "server" : "member", code: "service-unavailable", detail: (err as Error).message, since: (this.options.now ?? Date.now)() });
      if (rethrow) throw err;
    }
  }

}
