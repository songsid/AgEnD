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
import { createHubDirectory } from "./directory/index.js";
import { hubPlanDigest } from "./init/plan-digest.js";
import { HubMount, type HubMountedService } from "./mount.js";
import { createHubServerFactory, type HubServerComponents } from "./compose/server.js";
import type { HubHoldCode } from "./db.js";

export interface HubHold {
  side: "server" | "member";
  code: HubHoldCode;
  detail: string;
  since: number;
}

export interface HubRuntimeOptions {
  home: string;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  /** Called whenever the hold set changes (FleetManager re-renders its status / Needs-you). */
  onHoldsChanged?(holds: readonly HubHold[]): void;
  now?: () => number;
  /** Test seams. */
  components?: HubServerComponents;
  createServer?: (cfg: Record<string, unknown>, current: () => boolean) => Promise<HubMountedService>;
  createMember?: (cfg: Record<string, unknown>, current: () => boolean) => Promise<HubMountedService>;
}

type HubConfigView = { hub?: unknown; hub_member?: unknown };

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** True when the raw config turns either Hub switch on (the only thing FleetManager checks before importing us). */
export function hubSwitchesOn(raw: HubConfigView | null | undefined): boolean {
  return obj(raw?.hub)?.enabled === true || obj(raw?.hub_member)?.enabled === true;
}

/** What a reload compares: switches, the sealed settings' digest, and the member section as written. */
export function effectiveHubView(raw: HubConfigView | null | undefined): string {
  const hub = obj(raw?.hub);
  const member = obj(raw?.hub_member);
  return JSON.stringify({
    server: hub?.enabled === true ? hubPlanDigest(hub) : null,
    member: member?.enabled === true ? JSON.stringify(member) : null,
  });
}

const MOUNT_CODE: Record<"initialization" | "member-pairing" | "service-unavailable", HubHoldCode> = {
  initialization: "hub-unsealed",
  "member-pairing": "hub-member-pairing",
  "service-unavailable": "service-unavailable",
};

export class HubRuntime {
  private readonly mount: HubMount;
  private view: string | null = null;
  private running: Promise<void> | null = null;
  private pending: HubConfigView | null = null;
  private stopped = false;
  private holds: HubHold[] = [];
  /** The most specific reason a factory reported for the side currently being mounted. */
  private reported: { side: "server" | "member"; code: HubHoldCode; detail: string } | null = null;
  private mounting: "server" | "member" | null = null;

  constructor(private readonly options: HubRuntimeOptions) {
    const now = options.now ?? Date.now;
    const serverFactory =
      options.createServer ??
      createHubServerFactory({
        home: options.home,
        components: options.components ?? {},
        createDirectory: createHubDirectory,
        report: (code, detail) => {
          this.reported = { side: "server", code, detail };
        },
        log: options.log,
        now,
      });
    const memberFactory =
      options.createMember ??
      (async () => {
        // The member side composes S4's restricted execution (hub-composition.md §5 "Member"), wired with S4.
        this.reported = { side: "member", code: "hub-incomplete", detail: "the Hub member side (S4) is not in this build" };
        throw new Error("hub-incomplete");
      });
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
    this.pending = { hub: config.hub, hub_member: config.hub_member };
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
    if (view === this.view) return;
    this.view = view;
    this.clearHolds();
    this.reported = null;
    try {
      await this.mount.apply(config); // fences, closes the previous services, then mounts what is on
    } catch (err) {
      // HubMount already raised its hold (service-unavailable on an unconfirmed cleanup).
      this.options.log("warn", "Hub apply did not finish cleanly", { err: (err as Error).message });
      this.view = null; // the next apply retries from scratch
    } finally {
      this.mounting = null;
    }
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
  }
}
