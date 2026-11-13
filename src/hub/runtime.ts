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
import type { HubDirectoryDiagnostic } from "./directory/directory.js";
import { hubPlanDigest } from "./init/plan-digest.js";
import { hubPreviewReloadKey } from "./preview.js";
import { HubMount, type HubMountedService } from "./mount.js";
import { createHubServerFactory, hubServerDatabasePlan, type HubHttpEntry, type HubServerComponents } from "./compose/server.js";
import { createHubDirectoryColdSettings, HubDirectoryColdCleanupError, withHubDirectoryRecovery, withHubWebAddressRecovery, withHubMemberAddressRecovery } from "./settings-directory-recovery.js";
import type {HubWebAddressDecision} from "./settings-web-address-decision.js";
import type { HubMemberAddressDecision } from "./settings-member-address-decision.js";
import type { HubDirectorySettingsDecision } from "./settings-directory-decision.js";
import type { HubMountedDirectory } from "./settings-directory-runtime.js";
import { canonicalArguments } from "./identity.js";
import { HubDirectoryResponseOwner } from "./directory-response-owner.js";
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
  /** Optional host factory; an absent provider keeps room assistants disabled. */
  roomAssistant?: () => import("./assistant/admin-types.js").ManagedRoomAssistant;
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
  /** M-2682: the host's one writer for sealed Hub settings (settings-commit.ts), offered to Hub Administration. */
  settingsWriter?: import("./settings-commit.js").HubSettingsWriter;
  directorySettings?: () => Promise<import("./settings-directory-control.js").HubDirectorySettingsControl>;
  /** Read the newest accepted config after the one writer publishes a startup compensation. */
  readConfig?(): { hub?: unknown; hub_member?: unknown };
  /** This AgEnD's version (Hub Administration → This Hub). */
  version?: string | null;
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

/**
 * M-2724: the running Hub's directory diagnostics, to the host log: which call failed (op), its outcome and, for a group call,
 * the step (failure). Never the server's text, which can repeat a DN or a login. Ordinary answers (a wrong password, a disabled
 * person) are not failures of the directory and are not logged.
 */
export function hubDirectoryDiagnostics(log: HubRuntimeOptions["log"]): (d: HubDirectoryDiagnostic) => void {
  return d => { if (d.outcome === "unavailable" || d.outcome === "unknown") log("warn", "Hub directory call failed", { op: d.op, outcome: d.outcome, ...(d.failure ? { failure: d.failure } : {}) }); };
}

export class HubRuntime {
  /** The mounted member, if current, can narrow only its exact confirmed local binding. */
  memberLeave(expected: import("./types.js").HubMemberLeaveBinding): Promise<boolean> { return this.mount.memberLeave(expected); }
  private readonly directoryResponses: HubDirectoryResponseOwner;
  private mountedDirectory: HubMountedDirectory | null = null;
  private coldDirectory: Awaited<ReturnType<typeof createHubDirectoryColdSettings>> | null = null;
  private coldDirectoryCleanup: HubDirectoryColdCleanupError | null = null;
  private coldDirectoryInit: Promise<HubMountedDirectory> | null = null;
  private coldDirectoryBuild: Promise<HubMountedDirectory> | null = null;
  private directoryAdmission: string | null = null;
  private directoryAdmissionTicket = 0;
  private observeDirectoryAdmission(hub: unknown): void {
    const view = canonicalArguments(hub ?? null);
    if (view !== this.directoryAdmission) {
      this.directoryAdmission = view; this.directoryAdmissionTicket++; this.coldDirectory?.fence();
    }
  }
  private async drainColdDirectory(): Promise<void> {
    const cleanup = this.coldDirectoryCleanup;
    if (cleanup) {
      await cleanup.close();
      if (this.coldDirectoryCleanup === cleanup) this.coldDirectoryCleanup = null;
    }
    const cold = this.coldDirectory;
    if (!cold) return;
    cold.fence(); await cold.close();
    if (this.coldDirectory === cold) this.coldDirectory = null;
  }
  /** Called only after a listener has proved local D3/Hub-admin authority. It never starts a listener. */
  async acquireDirectorySettings(): Promise<HubMountedDirectory> {
    if (this.stopped || this.options.settingsWriter?.pending()) throw Error("Directory settings are unavailable");
    const existing = this.directorySettings(); if (existing) return existing;
    const read = () => this.options.readConfig?.() ?? this.lastConfig ?? {};
    const snapshot = structuredClone(read()), hub = obj(snapshot.hub);
    if (!hub) throw Error("The Hub has not been initialized");
    this.observeDirectoryAdmission(hub);
    const ticket = this.directoryAdmissionTicket, admissionTicket = this.admissionTicket, view = canonicalArguments(hub);
    const current = () => !this.stopped && ticket === this.directoryAdmissionTicket && admissionTicket === this.admissionTicket && canonicalArguments(read().hub) === view;
    const pending = this.coldDirectoryInit ??= (async () => {
      await this.running;
      if (!current()) throw Error("Directory settings admission changed");
      const mounted = this.directorySettings(); if (mounted) return mounted;
      await this.drainColdDirectory();
      // Positively drain a held server before borrowing its existing state; its member connection is independent.
      await this.mount.closeServer();
      await this.drainLeftovers({ server: true, member: false }, true);
      if (!current() || this.options.settingsWriter?.pending()) throw Error("Directory settings admission changed");
      const entry = await (this.options.components ?? { http: S3B_HTTP_ENTRY }).http?.();
      if (!current() || !entry) throw Error("Directory settings admission changed");
      const { settings, groupGeneration, migrations } = hubServerDatabasePlan(hub, entry.migrations);
      // Publish the physical construction participant BEFORE invoking callbacks that may re-enter Refresh.
      let resolve!: (source: HubMountedDirectory) => void, reject!: (error: unknown) => void;
      const build = new Promise<HubMountedDirectory>((yes, no) => { resolve = yes; reject = no; });
      this.coldDirectoryBuild = build;
      void (async () => {
        let cold: Awaited<ReturnType<typeof createHubDirectoryColdSettings>>;
        try {
          cold = await createHubDirectoryColdSettings({ home: this.options.home, hubId: settings.hubId, memberOrigin: settings.memberOrigin,
            hub, generation: groupGeneration, migrations, current, createDirectory: this.options.createDirectory ?? createHubDirectory });
        } catch (error) {
          if (error instanceof HubDirectoryColdCleanupError) this.coldDirectoryCleanup = error;
          throw error;
        }
        this.coldDirectory = cold; // Retain physical ownership even when logical admission just expired.
        if (!current()) { await this.drainColdDirectory(); throw Error("Directory settings admission changed"); }
        return cold;
      })().then(resolve, reject);
      try { return await build; }
      finally { if (this.coldDirectoryBuild === build) this.coldDirectoryBuild = null; }
    })();
    try { return await pending; }
    finally { if (this.coldDirectoryInit === pending) this.coldDirectoryInit = null; }
  }
  private recoveryDirectory: HubDirectorySettingsDecision | null = null;
  private recoveryWebAddress: HubWebAddressDecision | null = null;
  private recoveryMemberAddress: HubMemberAddressDecision | null = null;
  private mountedMemberAddress: HubMemberAddressDecision | null = null;
  private mountedWebAddress: HubWebAddressDecision | null = null;
  private settingsRecoveryGeneration = 0;
  private directoryStartupAttempted = false;
  directorySettings(): HubMountedDirectory | null {
    return this.stopped ? null : this.mountedDirectory?.current() ? this.mountedDirectory : this.coldDirectory?.current() ? this.coldDirectory : null;
  }
  /** Physical completion retains its owning participant after logical epoch revocation, until the DB closes. */
  directoryDecision(): HubDirectorySettingsDecision | null { return this.recoveryDirectory ?? this.coldDirectory?.decision ?? this.mountedDirectory?.decision ?? null; }
  webAddressDecision():HubWebAddressDecision|null{return this.recoveryWebAddress??this.mountedWebAddress;}
  /** Borrow only existing state; cold access creates no listener, directory client, migration or session. */
  async withWebAddressDecision<T>(work:(decision:HubWebAddressDecision)=>T,ownerCurrent:()=>boolean):Promise<T>{
    const snapshot=structuredClone(this.options.readConfig?.()??this.lastConfig??{}),ticket=this.admissionTicket;
    const current=()=>!this.stopped&&ownerCurrent()===true&&ticket===this.admissionTicket;
    if(!current())throw Error("Web address authority changed");
    if(this.running)await this.running;
    if(!current())throw Error("Web address generation changed");
    const mounted=this.webAddressDecision();if(mounted){
      if(this.serverHealth(snapshot.hub)!=="ready")throw Error("Web address mount is changing");
      return work(mounted);
    }
    const entry=await(this.options.components??{http:S3B_HTTP_ENTRY}).http?.();
    if(!entry||!current())throw Error("Web address storage is unavailable");
    const hub=obj(snapshot.hub);if(!hub)throw Error("Hub is unavailable");
    const {settings,migrations}=hubServerDatabasePlan(hub,entry.migrations);
    return withHubWebAddressRecovery({home:this.options.home,hubId:settings.hubId,memberOrigin:settings.memberOrigin,migrations,initial:settings.webTls},decision=>{
      if(!current()||this.recoveryWebAddress)throw Error("Web address recovery is busy");
      this.recoveryWebAddress=decision;
      try{return work(decision);}finally{this.recoveryWebAddress=null;}
    });
  }
  memberAddressDecision():HubMemberAddressDecision|null{return this.recoveryMemberAddress??this.mountedMemberAddress;}
  /** Borrow only existing state; cold access creates no listener, directory client, migration or session. */
  async withMemberAddressDecision<T>(work:(decision:HubMemberAddressDecision)=>T,ownerCurrent:()=>boolean):Promise<T>{
    const snapshot=structuredClone(this.options.readConfig?.()??this.lastConfig??{}),ticket=this.admissionTicket;
    const current=()=>!this.stopped&&ownerCurrent()===true&&ticket===this.admissionTicket;
    if(!current())throw Error("Member address authority changed");
    if(this.running)await this.running;
    if(!current())throw Error("Member address generation changed");
    const mounted=this.memberAddressDecision();if(mounted){
      if(this.serverHealth(snapshot.hub)!=="ready")throw Error("Member address mount is changing");
      return work(mounted);
    }
    const entry=await(this.options.components??{http:S3B_HTTP_ENTRY}).http?.();
    if(!entry||!current())throw Error("Member address storage is unavailable");
    const hub=obj(snapshot.hub);if(!hub)throw Error("Hub is unavailable");
    const {settings,migrations}=hubServerDatabasePlan(hub,entry.migrations);
    return withHubMemberAddressRecovery({home:this.options.home,hubId:settings.hubId,memberOrigin:settings.memberOrigin,migrations},decision=>{
      if(!current()||this.recoveryMemberAddress)throw Error("Member address recovery is busy");
      this.recoveryMemberAddress=decision;
      try{return work(decision);}finally{this.recoveryMemberAddress=null;}
    });
  }
  /** Physical Save completion may borrow the exact existing state after its old listener has closed. Never migrate/create here. */
  async withDirectoryDecision<T>(hubId: string, work: (decision: HubDirectorySettingsDecision) => T, current: () => boolean): Promise<T> {
    const ticket = this.admissionTicket, directoryTicket = this.directoryAdmissionTicket, read = () => this.options.readConfig?.() ?? this.lastConfig ?? {};
    const snapshot = structuredClone(read()), view = effectiveHubView(snapshot);
    const owned = () => !this.stopped && ticket === this.admissionTicket && directoryTicket === this.directoryAdmissionTicket && current() === true;
    const run = (decision: HubDirectorySettingsDecision): T => {
      if (!owned() || decision.hubId !== hubId) throw Error("Directory decision owner changed");
      let open = true;
      const borrowed = Object.freeze(Object.fromEntries(Object.entries(decision).map(([key, value]) => [key, typeof value !== "function" ? value : (...args: unknown[]) => {
        if (!open || !owned()) throw Error("Directory decision owner changed");
        return Reflect.apply(value, decision, args);
      }]))) as HubDirectorySettingsDecision;
      try {
        const result = work(borrowed);
        if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
          open = false;
          try { (result as unknown as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refused below */ }
          throw Error("Directory decision callbacks must be synchronous");
        }
        if (!owned()) throw Error("Directory decision owner changed");
        return result;
      } finally { open = false; }
    };
    if (!owned() || obj(snapshot.hub)?.hubId !== hubId) throw Error("Directory decision owner changed");
    const mounted = this.directoryDecision();
    if (mounted) return run(mounted);
    const entry = await (this.options.components ?? { http: S3B_HTTP_ENTRY }).http?.();
    if (!owned() || effectiveHubView(read()) !== view) throw Error("Directory decision owner changed");
    const hub = obj(snapshot.hub);
    if (!hub || !entry) throw Error("The directory recovery registry is unavailable");
    const { settings, migrations } = hubServerDatabasePlan(hub, entry.migrations);
    return withHubDirectoryRecovery({ home: this.options.home, hubId: settings.hubId, memberOrigin: settings.memberOrigin, migrations }, decision => {
      this.recoveryDirectory = decision;
      try { return run(decision); } finally { this.recoveryDirectory = null; }
    });
  }
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
  private admissionTicket = 0;
  private admit(view: string | null): boolean {
    if (view === this.admitted) return false;
    this.admitted = view; this.admissionTicket++;
    return true;
  }
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
    this.directoryResponses = new HubDirectoryResponseOwner({ now });
    const composed = options.createServer
      ? null
      : createHubServerFactory({
          home: options.home,
          roomAssistant: options.roomAssistant,
          components: options.components ?? { http: S3B_HTTP_ENTRY },
          // M-2724: the running Hub's directory says in the host log which call failed and at which step (op, outcome and,
          // for a group call, the failure kind) — never the server's text, which can repeat a DN or a login.
          createDirectory: options.createDirectory ?? ((config, secrets) => createHubDirectory(config, secrets, { onDiagnostic: hubDirectoryDiagnostics(options.log) })),
          directoryResponses: this.directoryResponses,
          ...(options.settingsWriter ? { settingsWriter: options.settingsWriter } : {}),
          ...(options.directorySettings ? { directorySettings: options.directorySettings } : {}),
          directoryReady: directory => {
            this.mountedDirectory = directory;
            return () => { if (this.mountedDirectory === directory) this.mountedDirectory = null; };
          },
          webAddressReady: decision => {
            this.mountedWebAddress=decision;
            return()=>{if(this.mountedWebAddress===decision)this.mountedWebAddress=null;};
          },
          memberAddressReady: decision => {
            this.mountedMemberAddress = decision;
            return () => { if (this.mountedMemberAddress === decision) this.mountedMemberAddress = null; };
          },
          version: options.version ?? null,
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

  /** Called before apply: a recovery refusal must never fall through into normal creation/migration. */
  async recoverSettings(config: HubConfigView): Promise<boolean> {
    if (this.stopped) return false;
    const writer = this.options.settingsWriter;
    if (!writer?.pending()) return true;
    const ticket = ++this.settingsRecoveryGeneration, snapshot = structuredClone(config);
    const current = () => !this.stopped && ticket === this.settingsRecoveryGeneration;
    try {
      if (writer.pendingDirectory() || writer.pendingWebAddress?.() || writer.pendingMemberAddress?.()) {
        const entry = await (this.options.components ?? { http: S3B_HTTP_ENTRY }).http?.();
        if (!current()) return false;
        const hub = obj(snapshot.hub);
        if (!entry || !hub) throw Error("The directory recovery registry is unavailable");
        const { settings, migrations } = hubServerDatabasePlan(hub, entry.migrations);
        const options={home:this.options.home,hubId:settings.hubId,memberOrigin:settings.memberOrigin,migrations};
        if (writer.pendingMemberAddress?.()) withHubMemberAddressRecovery(options, decision => {
          this.recoveryMemberAddress = decision;
          try { writer.recover(); } finally { this.recoveryMemberAddress = null; }
        });
        else if(writer.pendingWebAddress?.())withHubWebAddressRecovery({...options,initial:settings.webTls},decision=>{
          this.recoveryWebAddress=decision;
          try{writer.recover();}finally{this.recoveryWebAddress=null;}
        });
        else withHubDirectoryRecovery(options, decision => {
          this.recoveryDirectory = decision;
          try { writer.recover(); } finally { this.recoveryDirectory = null; }
        });
      } else { writer.recover(); }
      return current();
    } catch (err) {
      if (!current()) return false;
      await this.refuseSettingsMount(snapshot, err);
      throw err;
    }
  }

  private async refuseSettingsMount(config: HubConfigView, err: unknown): Promise<void> {
    this.view = null;
    this.admit(effectiveHubView(config));
    this.addHold({ side: "server", code: "hub-storage", reason: "settings-recovery", detail: (err as Error).message,
      since: (this.options.now ?? Date.now)() });
    try { await this.mount.holdServer(config); }
    catch (cleanup) { this.options.log("warn", "Hub settings cleanup remains owned", { err: (cleanup as Error).message }); }
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
    if (this.mountedDirectory && !this.mountedDirectory.current()) return "unavailable";
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
    this.settingsRecoveryGeneration++;
    this.observeDirectoryAdmission(config.hub);
    const view = effectiveHubView(config);
    if (this.admit(view)) {
      if (this.running) {
        // A changed configuration revokes the current generation now, even while a factory or start is still held:
        // S1's fence is synchronous, and a held service must not start for a configuration that is already gone.
        const member = (raw: unknown) => obj(raw)?.enabled === true ? JSON.stringify(raw) : null;
        if (this.options.settingsWriter?.pending() && member(config.hub_member) === member(this.lastConfig?.hub_member)) this.mount.fenceServer();
        else this.mount.fence();
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
    if (this.coldDirectoryBuild) await this.coldDirectoryBuild.catch(() => {});
    if (this.coldDirectoryCleanup || this.coldDirectory && (obj(config.hub)?.enabled === true || !this.coldDirectory.current())) await this.drainColdDirectory();
    if (this.options.settingsWriter?.pending()) {
      await this.refuseSettingsMount(config, Error("Hub settings recovery must finish before mounting"));
      return;
    }
    const view = effectiveHubView(config);
    if (view === this.view) {
      if (this.leftover) await this.drainLeftovers({ server: obj(config.hub)?.enabled !== true, member: obj(config.hub_member)?.enabled !== true });
      return;
    }
    this.view = view;
    const reconcile = !this.directoryStartupAttempted && obj(config.hub)?.enabled === true
      && !this.options.createServer && !!this.options.settingsWriter?.directory;
    const admissionTicket = this.admissionTicket; // Capture before the mount/factory's first await.
    if (reconcile) this.directoryStartupAttempted = true;
    this.clearHolds();
    this.reported = null;
    try {
      await this.mount.apply(config); // fences, closes the previous services, then mounts what is on
      await this.drainLeftovers({ server: obj(config.hub)?.enabled !== true, member: obj(config.hub_member)?.enabled !== true });
      if (reconcile) await this.reconcileDirectoryStartup(structuredClone(config), view, admissionTicket);
    } catch (err) {
      // HubMount already raised its hold (service-unavailable on an unconfirmed cleanup).
      this.options.log("warn", "Hub apply did not finish cleanly", { err: (err as Error).message });
      this.view = null; // the next apply retries from scratch
    } finally {
      this.mounting = null;
    }
  }

  /** Once per runtime, after its first enabled server attempt. A live Save owns subsequent operations itself. */
  private async reconcileDirectoryStartup(config: HubConfigView, view: string, admissionTicket: number): Promise<void> {
    const current = () => !this.stopped && admissionTicket === this.admissionTicket && this.admitted === view;
    const withDecision = async <T>(work: (decision: HubDirectorySettingsDecision) => T): Promise<T> => {
      if (!current()) throw Error("Hub startup reconciliation was superseded");
      const mounted = this.directoryDecision();
      if (mounted) return work(mounted);
      const entry = await (this.options.components ?? { http: S3B_HTTP_ENTRY }).http?.();
      if (!current()) throw Error("Hub startup reconciliation was superseded");
      const hub = obj(config.hub);
      if (!entry || !hub) throw Error("The directory recovery registry is unavailable");
      const { settings, migrations } = hubServerDatabasePlan(hub, entry.migrations);
      return withHubDirectoryRecovery({ home: this.options.home, hubId: settings.hubId, memberOrigin: settings.memberOrigin, migrations }, decision => {
        this.recoveryDirectory = decision;
        try { return work(decision); } finally { this.recoveryDirectory = null; }
      });
    };
    try {
      const intent = await withDecision(decision => decision.mountRecovery());
      if (!current() || !intent || intent.state !== "pending") return;
      const mounted = this.directorySettings(), head = mounted?.decision.inspect();
      if (mounted && head?.operationId === intent.operation.id && head.directoryEpoch === intent.operation.directoryEpoch) {
        mounted.decision.completeMount(intent.operation.id, (this.options.now ?? Date.now)(), () => current() && mounted.current());
        return;
      }
      const writer = this.options.settingsWriter?.directory, read = this.options.readConfig;
      if (!writer || !read) throw Error("Startup directory restoration is unavailable");
      const restored = await withDecision(decision => {
        const result = writer.compensate(intent.operation.id, operation => current()
          && canonicalArguments(operation) === canonicalArguments(intent.operation), intent.expiresAt);
        const operation = decision.operation(result.receiptId);
        if (!current() || operation.kind !== "directory-compensation" || operation.compensates !== intent.operation.id
          || operation.directoryEpoch !== result.directoryEpoch) throw Error("Startup directory restoration changed");
        return operation;
      });
      if (!current()) return;
      const next = structuredClone(read());
      if (hubPlanDigest(next.hub) !== restored.after.configDigest) throw Error("Restored directory config is not current");
      // Queue the writer's accepted image through the ordinary serialized mount loop. No recursive compensation.
      this.mount.fenceServer();
      this.pending = next; this.lastConfig = next; this.admit(effectiveHubView(next)); this.view = null;
    } catch (err) {
      if (current()) await this.refuseSettingsMount(config, err);
    }
  }

  /**
   * The member's binding changed outside the configuration (a pairing was claimed, disconnected or cancelled): rebuild
   * from the last configuration, fencing first, even though its text is unchanged.
   */
  refresh(): Promise<void> {
    if (this.stopped || !this.lastConfig) return Promise.resolve();
    this.admit(null);
    this.view = null;
    if (this.running) this.mount.fence();
    return this.apply(this.lastConfig);
  }

  /** Synchronous: no new admission, dispatch or listener work from here on. */
  fence(): void {
    this.settingsRecoveryGeneration++;
    this.stopped = true;
    this.pending = null;
    this.directoryResponses.fence();
    this.coldDirectory?.fence();
    this.mount.fence();
  }

  async close(): Promise<void> {
    this.fence();
    try {
      await this.running;
    } catch {
      /* already reported */
    }
    try {
      await this.coldDirectoryInit?.catch(() => {});
      await this.drainColdDirectory();
      await this.mount.close();
      await this.drainLeftovers({ server: true, member: true }, true);
    } finally { await this.directoryResponses.close(); }
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
