/**
 * S5b member factory (S-51 PR 2b; docs/design/hub-composition.md §5 "Member"). Called by S1's HubMount for an enabled
 * hub_member, and only for a current, non-disconnected binding (S3c's pairing state). Builds, in order:
 *   member DB + every migration → floors and keys (first creation only) → member-local audit → S1 journal (its
 *   restricted outbox forwards to S4 once S4 exists) → S3c exposure store → S4 restricted execution (+ the optional
 *   S4b provider, only when the owner configured one) → recover() → S1 admission + client with #3116's handshake and
 *   S5's receive routing → the exposure API and Needs-you attention attached to the fleet.
 * Either the whole service comes back or nothing stays open; unconfirmed cleanup stays owned (drain()).
 * The data-view registry comes from a HubViewSource: EMPTY until the owner-approval flow exists (§7 Q2), so nothing
 * is publishable or askable — fail closed.
 */
import { createPublicKey, randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import type Database from "better-sqlite3";
import { createHubAudit, HUB_AUDIT_MIGRATION, type HubAuditStore } from "../audit/index.js";
import {
  applyHubMigrations,
  bindHubInstance,
  HUB_INSTANCE_MIGRATION,
  HubStateError,
  inspectStateSet,
  openHubDatabase,
  type HubHoldCode,
  type HubStateSet,
} from "../db.js";
import type { HubMountedService } from "../mount.js";
import { ensurePrivateDirectory, readPrivateFile } from "../private-files.js";
import { HubMemberAdmissionAdapter } from "../admission.js";
import { HubMemberClient, type HubMemberLink } from "../client.js";
import { HUB_MEMBER_JOURNAL_MIGRATION, HubMemberJournal, type HubRestrictedOutbox } from "../member-journal.js";
import { createHubMemberHandshake } from "../member-reconciliation.js";
import { HubMemberProfileStore, type HubMemberProfile } from "../profile.js";
import { createQuotaPublisher } from "../member/quota.js";
import { HubFileVersionFloor } from "../version-floor.js";
import type { HubAuditRecord, HubServerFrame } from "../types.js";
import { EMPTY_VIEW_SOURCE, type HubViewSource } from "./views.js";
import { HUB_REPRESENTATIVE_MIGRATION, HubRepresentativeExecution, type HubReportOutcome, type HubRepresentativeDelivery } from "../representative.js";
import { HUB_PROVIDER_SETUP_REASONS, hubProviderSetupReason, type HubProviderSetupReason } from "../execution/provider-setup.js";
import { HubMemberFiles } from "../member/attachments.js";
import { createHubPairingNoticeInbox, HUB_PAIRING_INBOX_MIGRATION } from "../member/pairing-notices.js";

export function memberSet(hubId: string): HubStateSet {
  const base = `hub-member/${hubId}`;
  return Object.freeze({
    database: `${base}/member.sqlite`,
    floors: Object.freeze([`${base}/floors/journal`, `${base}/floors/execution`, `${base}/floors/s3c-exposures`]),
    keys: Object.freeze([`${base}/keys/journal.key`, `${base}/keys/content.key`]),
  });
}

type Execution = typeof import("../execution/index.js");
type Exposures = typeof import("../member/exposures.js");
type ExposureApi = typeof import("../member/exposure-api.js");

/** The slices the member side needs, imported lazily inside the factory. Missing: hub-incomplete, before any I/O. */
export interface HubMemberComponents {
  execution?: () => Promise<Execution>;
  exposures?: () => Promise<{ store: Exposures; api: ExposureApi }>;
  /** S4b: only consulted when the owner configured hub_member.execution.provider. */
  provider?: () => Promise<{
    createHubCliProvider: typeof import("../execution/cli-provider.js").createHubCliProvider;
    createHubModelBroker: typeof import("../execution/model-broker.js").createHubModelBroker;
  }>;
}

export interface HubMemberFactoryOptions {
  home: string;
  components: HubMemberComponents;
  /** S3c's current binding (its pairing state): the Hub id, or null when unpaired or disconnected. */
  boundHub(): string | null;
  /** The owner's local agents, each with the S4 provider it would run under (null: none). */
  agents(): import("../member/exposure-api.js").HubMemberAgent[];
  views?: HubViewSource;
  /** P1's representative mode: the fleet's ordinary delivery, the agent lifecycle token and the report_result hook. */
  representative: HubRepresentativeHost;
  attachExposures(api: import("../member/exposure-api.js").HubMemberExposureApi | null): void;
  attachAttention(read: (() => import("../../needs-you.js").HubExecutionAttentionInput[]) | null): void;
  /** Security inbox is available to the current binding's local Settings page, on chat and web-only fleets. */
  attachPairingNotices?(read: (() => import("../types.js").HubPairingNotice[]) | null): void;
  pokeAttention(): void;
  /** The member link as S3c's pairing view shows it: online after a completed handshake, revoked when the Hub said so. */
  linkState?(state: "online" | "offline" | "revoked"): void;
  report(code: HubHoldCode, detail: string): void;
  /**
   * A non-fatal hold while the member keeps running (the provider could not be set up: every exposure stays
   * unavailable). `reason` is a bounded setup reason (PROVIDER_SETUP_REASONS) for localized guidance.
   */
  notice?(code: HubHoldCode, reason: ProviderSetupReason, detail: string): void;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  now?: () => number;
}

export interface HubRepresentativeHost {
  /** Derive only a coarse band from this agent's local CLI/profile. Never hands exact usage to the Hub layer. */
  quota?(agent: string): Promise<import("../types.js").HubQuota>;
  /** Ordinary cross-instance delivery to the published agent, with beforeInput run immediately before the IPC hand-off. */
  deliver(input: HubRepresentativeDelivery): Promise<boolean>;
  /** The agent's current lifecycle token (null: not a deliverable agent now). */
  agentToken(agent: string): string | null;
  /** attachments-v1: the agent's inbox for a question's files and its own paths for an answer's (absent: no files). */
  files?: import("../member/attachments.js").HubMemberFilesOptions;
  /** The report_result hook for HUB_REPORT_TARGET and the pane-failure hook for its correlation ids (null: detached). */
  attachReports(
    handler: ((input: { correlationId: string; caller: string; text: string; callerCurrent(): boolean; extras?: import("../../hub-report-target.js").HubReportExtras }) => Promise<HubReportOutcome> | null) | null,
    failed: ((correlationId: string, agent: string) => void) | null,
  ): void;
}

/** Ordered cleanup that stops at the first unconfirmed step (same rules as the server factory). */
class Teardown {
  private readonly steps: { name: string; run: () => unknown; done: boolean }[] = [];
  add(name: string, run: () => unknown): void {
    this.steps.push({ name, run, done: false });
  }
  async run(): Promise<void> {
    for (let i = this.steps.length - 1; i >= 0; i -= 1) {
      const step = this.steps[i]!;
      if (step.done) continue;
      try {
        await step.run();
        step.done = true;
      } catch (err) {
        throw new HubStateError("service-unavailable", `Hub member cleanup of ${step.name} is unconfirmed: ${(err as Error).message}`);
      }
    }
  }
}

function createKeyFile(home: string, rel: string): void {
  ensurePrivateDirectory(home, rel.slice(0, rel.lastIndexOf("/")));
  const fd = openSync(`${home}/${rel}`, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(32).toString("base64"));
  } finally {
    closeSync(fd);
  }
}
function readKey(home: string, rel: string): Buffer {
  const key = Buffer.from(readPrivateFile(home, rel, 256).trim(), "base64");
  if (key.length !== 32) throw new HubStateError("hub-storage", `${rel} is not a 32-byte key`);
  return key;
}

/** Bounded provider-setup reasons: S4's own list (src/hub/execution/provider-setup.ts); S4 owns the guidance text. */
export const PROVIDER_SETUP_REASONS = HUB_PROVIDER_SETUP_REASONS;
export type ProviderSetupReason = HubProviderSetupReason;
export class HubProviderSetupError extends HubStateError {
  constructor(readonly reason: ProviderSetupReason, message: string) {
    super("hub-provider-unavailable", message);
    this.name = "HubProviderSetupError";
  }
}
/** The bounded reason of any provider-setup failure: S4b's typed `.reason` when it is one of ours, else "unavailable". */
export function providerSetupReason(err: unknown): ProviderSetupReason {
  if (err instanceof HubProviderSetupError) return err.reason;
  return hubProviderSetupReason(err) ?? "unavailable";
}

const PROVIDER_KEYS = new Set(["backend", "imageId", "model", "credentialRef", "dockerSocket"]);
interface ProviderConfig {
  backend: "claude" | "codex";
  imageId: string;
  model: string;
  credentialRef: string;
  dockerSocket?: string;
}

/** hub_member.execution.provider, strictly (agreed with S4b, hub-s54-provider-composition). Absent: null. */
export function providerConfig(cfg: Record<string, unknown>, hubId: string): ProviderConfig | null {
  const execution = cfg.execution;
  if (execution === undefined) return null;
  const provider = execution && typeof execution === "object" ? (execution as Record<string, unknown>).provider : undefined;
  if (provider === undefined) return null;
  const p = provider as Record<string, unknown>;
  const bad = (why: string, reason: ProviderSetupReason = "unavailable"): never => {
    throw new HubProviderSetupError(reason, `hub_member.execution.provider: ${why}`);
  };
  if (!p || typeof p !== "object" || Array.isArray(p)) bad("must be an object");
  for (const k of Object.keys(p)) if (!PROVIDER_KEYS.has(k)) bad(`unknown setting "${k}"`);
  if (p.backend !== "claude" && p.backend !== "codex") bad('backend must be "claude" or "codex"');
  if (typeof p.imageId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(p.imageId)) bad("imageId must be sha256:<64 hex>", "image-unconfigured");
  if (typeof p.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(p.model)) bad("model is not a model id");
  if (p.credentialRef !== `file:hub-member/${hubId}/secrets/model-api`) bad(`credentialRef must be file:hub-member/${hubId}/secrets/model-api`, "credential-unconfigured");
  if (p.dockerSocket !== undefined && (typeof p.dockerSocket !== "string" || !/^\/(var\/)?run\/[A-Za-z0-9._/-]+\.sock$/.test(p.dockerSocket))) {
    bad("dockerSocket must be a local unix socket under /var/run or /run");
  }
  return p as unknown as ProviderConfig;
}

const execAction = (kind: string) => `execution.${kind.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`.slice(0, 128);

/**
 * The member's captured binding for S4 (and S1 admission): the pairing's identity plus the link it was captured on.
 * relink() starts a new generation for every (re)connect; a binding captured earlier then reads current() === false,
 * as it does after fence(). S4 keeps binding objects across awaits, so this is what fences its in-flight work.
 */
export function createMemberBinding(deps: {
  hubId: string;
  profile: Pick<HubMemberProfile, "issuerKeyId" | "fleetId" | "owner" | "hub">;
  live(): boolean;
  revocationFloor(): number;
}) {
  let generation = 0;
  let link: HubMemberLink | null = null;
  const issuerPublicKey = createPublicKey(deps.profile.hub.issuerPublicKey);
  return {
    relink(l: HubMemberLink): void {
      link = l;
      generation += 1;
    },
    fence(): void {
      generation += 1;
    },
    link: () => link,
    binding() {
      const gen = generation;
      const captured = link;
      return Object.freeze({
        hubId: deps.hubId,
        issuerKeyId: deps.profile.issuerKeyId,
        issuerPublicKey,
        fleetId: deps.profile.fleetId,
        owner: deps.profile.owner,
        revocationVersion: captured?.revocationVersion ?? deps.revocationFloor(),
        generation: gen,
        linkEpoch: captured?.linkEpoch ?? 0,
        current: () => deps.live() && generation === gen && (captured === null || (link === captured && captured.current())),
      });
    },
  };
}

/**
 * S5's receive routing for the member link (agreed with S1, hub-s51-compose): question → admit → the receipt on the
 * same link, answering the question's own requestId; revoke → fence; receipt (the Hub's ACK) → journal.acknowledge;
 * anything else is refused. Never ordinary fleet delivery.
 */
export function createMemberReceive(deps: {
  admission: Pick<HubMemberAdmissionAdapter, "admit" | "fence">;
  journal: Pick<HubMemberJournal, "acknowledge">;
  live(): boolean;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  notices?: { receive: ReturnType<typeof createHubPairingNoticeInbox>["receive"] };
}) {
  return async (frame: Exclude<HubServerFrame, { type: "welcome" }>, l: HubMemberLink): Promise<void> => {
    if (!deps.live() || !l.current()) return;
    if (frame.type === "question") {
      const receipt = await deps.admission.admit(frame.payload);
      if (!l.current()) return;
      await l.send({ v: 1, type: "receipt", requestId: frame.requestId, linkEpoch: l.linkEpoch, payload: receipt });
      return;
    }
    if (frame.type === "revoke") return deps.admission.fence(frame.payload);
    if (frame.type === "receipt") return deps.journal.acknowledge(frame.payload);
    if (frame.type === "pairing.notice" && deps.notices) return deps.notices.receive(frame.payload, l);
    deps.log("warn", "Hub frame not expected on the member", { type: frame.type });
    throw new HubStateError("service-unavailable", `unexpected ${frame.type} frame`);
  };
}

/**
 * Disconnect while the member side is not running (held, or never composed): withdraw every published exposure in the
 * member's own store, so consent never outlives the disconnect (a later re-pair to the same Hub republishes nothing).
 * Never composed (no member state): nothing was published. A partial set throws (the disconnect reports "unsaved").
 */
export async function withdrawMemberExposuresOffline(home: string, hubId: string, now: () => number = Date.now): Promise<number> {
  const set = memberSet(hubId);
  if (inspectStateSet(home, set) === "new") return 0;
  const mod = await import("../member/exposures.js");
  const db = openHubDatabase(home, set.database, { create: false });
  try {
    const audit = createHubAudit({ db, contentKey: readKey(home, set.keys[1]!), now });
    const store = new mod.HubExposureStore(db, { floor: new HubFileVersionFloor(home, set.floors[2]!), audit, binding: () => null, views: new Map(), now });
    let withdrawn = 0;
    for (const row of store.list()) {
      const committed = row.committed;
      if (committed && committed.exposure.state === "published") {
        store.withdraw(committed.exposure.id, committed.exposure.revision);
        withdrawn += 1;
      }
    }
    return withdrawn;
  } finally {
    db.close();
  }
}

export function createHubMemberFactory(options: HubMemberFactoryOptions) {
  const now = options.now ?? Date.now;
  const views = options.views ?? EMPTY_VIEW_SOURCE;
  let unconfirmed: Teardown | null = null;

  const createMember = async function createMember(cfg: Record<string, unknown>, current: () => boolean): Promise<HubMountedService> {
    if (unconfirmed) {
      try {
        await unconfirmed.run();
        unconfirmed = null;
      } catch (err) {
        options.report("service-unavailable", (err as Error).message);
        throw err;
      }
    }
    const teardown = new Teardown();
    const fail = async (err: unknown): Promise<never> => {
      try {
        await teardown.run();
      } catch (cleanupErr) {
        unconfirmed = teardown;
        options.report("service-unavailable", (cleanupErr as Error).message);
        throw cleanupErr;
      }
      options.report(err instanceof HubStateError ? err.code : "service-unavailable", (err as Error).message);
      throw err;
    };
    try {
      // 0. Every slice present and a current binding, before any I/O.
      if (!options.components.execution || !options.components.exposures) {
        throw new HubStateError("hub-incomplete", "the Hub member side (S4 / S3c) is not in this build");
      }
      const hubId = options.boundHub();
      if (!hubId) throw new HubStateError("hub-member-pairing", "this fleet is not paired with a Hub (or was disconnected)");
      let profile: HubMemberProfile;
      try {
        profile = new HubMemberProfileStore(options.home, hubId).readProfile();
      } catch (err) {
        throw new HubStateError("hub-member-pairing", `the Hub pairing is missing or invalid: ${(err as Error).message}`);
      }
      const [execution, exposureMods] = await Promise.all([options.components.execution(), options.components.exposures()]);

      // 1. The member state set: new (create all) or complete (open); partial is refused.
      const set = memberSet(hubId);
      const state = inspectStateSet(options.home, set);
      const db: Database.Database = openHubDatabase(options.home, set.database, { create: state === "new" });
      teardown.add("the member database", () => db.close());
      const [journalFloor, executionFloor, exposureFloor] = set.floors.map((f) => new HubFileVersionFloor(options.home, f));
      if (state === "new") {
        for (const floor of [journalFloor!, executionFloor!, exposureFloor!]) floor.initialize();
        for (const key of set.keys) createKeyFile(options.home, key);
      }
      applyHubMigrations(db, [
        HUB_INSTANCE_MIGRATION,
        HUB_AUDIT_MIGRATION,
        HUB_MEMBER_JOURNAL_MIGRATION,
        { component: "s4-execution", version: 1, up: execution.migrateHubExecution },
        exposureMods.store.HUB_EXPOSURE_MIGRATION,
        HUB_REPRESENTATIVE_MIGRATION,
        HUB_PAIRING_INBOX_MIGRATION,
      ]);
      bindHubInstance(db, hubId, state, now());

      // 2. Member-local audit; S1, S4 and S3c append inside their own transactions on this DB.
      const audit: HubAuditStore = createHubAudit({ db, contentKey: readKey(options.home, set.keys[1]!), now });

      // 3. S1 journal: its restricted outbox forwards to S4's, callable only once S4 exists and has recovered.
      let outbox: HubRestrictedOutbox | null = null;
      const forwarding: HubRestrictedOutbox = {
        insert: (...args) => {
          if (!outbox) throw new HubStateError("service-unavailable", "the restricted outbox is not ready");
          return outbox.insert(...args);
        },
        lookup: (...args) => {
          if (!outbox) throw new HubStateError("service-unavailable", "the restricted outbox is not ready");
          return outbox.lookup(...args);
        },
      };
      const journal = new HubMemberJournal(db, { hubId, encryptionKey: readKey(options.home, set.keys[0]!), floor: journalFloor!, outbox: forwarding, now });

      // 4. S3c exposure store over the approved views (empty until §7 Q2: nothing is publishable).
      const registry = views.load();
      const exposures = new exposureMods.store.HubExposureStore(db, {
        floor: exposureFloor!,
        audit,
        binding: () => (profile ? { owner: profile.owner, fleetId: profile.fleetId } : null),
        views: registry,
        now,
      });

      // 5. P1's only execution path: the representative adapter (docs/design/hub-representative-agent.md). No S4 service
      // or S4b provider is constructed; an old hub_member.execution.provider block is ignored (one info line, no hold).
      if (state === "new") {
        journal.initialize();
        exposures.initialize();
      }
      if ((cfg as { execution?: { provider?: unknown } }).execution?.provider !== undefined) {
        options.log("info", "hub_member.execution.provider is ignored: P1 Hub answers come from the published agent (representative mode)");
      }
      let fenced = false;
      const live = () => !fenced && current();
      const links = createMemberBinding({
        hubId,
        profile,
        live,
        revocationFloor: () => journal.revocationVersion(),
      });
      const binding = links.binding;
      let client: HubMemberClient | null = null;
      let online: HubMemberLink | null = null;
      const service = new HubRepresentativeExecution({
        db,
        journal,
        binding,
        localExposure: (id) => exposures.localExposure(id),
        agentToken: (agent) => options.representative.agentToken(agent),
        authorize: (request) => (client ? client.authorize(request) : Promise.reject(new HubStateError("service-unavailable", "not connected"))),
        link: () => (online && online.current() && links.link() === online ? online : null),
        deliver: (input) => options.representative.deliver(input),
        ...(options.representative.files ? { files: new HubMemberFiles(options.representative.files) } : {}),
        audit: (event, database) =>
          audit.appendInTransaction(
            {
              id: randomBytes(16).toString("hex"),
              sequence: 0,
              at: now(),
              requestId: event.messageId ?? "s5-representative",
              actor: { kind: "local-host" },
              action: event.action,
              result: event.result,
              policyVersion: 0,
              ...(event.messageId ? { messageId: event.messageId } : {}),
              ...(event.exposureId ? { exposureId: event.exposureId } : {}),
              ...(event.reasonCode ? { reasonCode: event.reasonCode.slice(0, 64) } : {}),
            } as HubAuditRecord,
            database,
          ),
        attentionChanged: () => options.pokeAttention(),
        log: options.log,
        now,
      });
      teardown.add("the representative adapter", () => service.close());
      service.recover();
      outbox = service.restrictedOutbox();

      // 6. S1 admission + client: #3116's handshake on (re)connect, S5's receive routing.
      const sender = exposureMods.store.exposureSnapshotSender(exposures);
      const quota = createQuotaPublisher({
        exposures: () => exposures.list().flatMap(row => row.committed?.exposure.state === "published"
          ? [{ exposureId: row.committed.exposure.id, agent: row.agent }] : []),
        read: agent => options.representative.quota?.(agent) ?? Promise.resolve({ band: "unknown" }),
        now,
      });
      teardown.add("quota updates", () => quota.stop());
      const handshake = createHubMemberHandshake({ journal, publishSnapshot: (l) => sender.publishSnapshot(l) });
      const admission = new HubMemberAdmissionAdapter({
        journal,
        transport: { start: async () => {}, send: (f) => client!.send(f), authorize: (r) => client!.authorize(r), close: async () => {} },
        binding: () => {
          const captured = links.link();
          return { profile, linkEpoch: captured?.linkEpoch ?? 0, revocationVersion: captured?.revocationVersion ?? journal.revocationVersion(), current: () => live() && !!captured && links.link() === captured && captured.current() };
        },
        exposure: (id) => exposures.exposure(id),
        fenceLocal: (messageId) => service.fence(messageId),
        hold: (messageId, reason) => options.log("warn", "Hub question held", { messageId, reason }),
        now,
      });
      const notices = createHubPairingNoticeInbox({ db, audit, current: live, now,
        changed: () => options.pokeAttention() });
      options.attachPairingNotices?.(() => notices.list());
      teardown.add("security notices", () => options.attachPairingNotices?.(null));
      const receive = createMemberReceive({ admission, journal, live, log: options.log, notices });
      client = new HubMemberClient({
        home: options.home,
        hubId,
        memberOrigin: profile.hub.memberOrigin,
        current: live,
        reconcile: async (l) => {
          links.relink(l);
          online = null;
          await handshake(l);
          if (l.current() && live()) {
            online = l;
            quota.start(l);
            options.linkState?.("online");
            // Questions admitted while offline (or before a restart, with no input yet) go out on this link.
            service.pump();
          }
        },
        receive,
        hold: (code) => {
          quota.stop();
          options.linkState?.(code === "revoked" ? "revoked" : "offline");
          options.log("warn", "Hub link held", { code });
        },
        now,
      });
      teardown.add("the Hub connection", () => client?.close());

      const api = exposureMods.api.createHubMemberExposureApi({
        store: exposures,
        // P1 representative agent (docs/design/hub-representative-agent.md): the owner shares a configured agent.
        agents: options.agents,
        afterCommit: () => sender.afterCommit(),
        // S5's readiness: the agent's lifecycle token, recorded against the consent inside S3c's atomic publish.
        readinessCandidate: (candidate) => service.readinessCandidate(candidate),
      });

      return {
        async start() {
          if (!live()) throw new HubStateError("service-unavailable", "the Hub member was switched off while starting");
          options.attachAttention(() => service.attentionItems());
          options.attachExposures(api);
          options.representative.attachReports((input) => service.report(input), (cid, agent) => service.deliveryFailed(cid, agent));
          teardown.add("the fleet attachments", () => {
            options.representative.attachReports(null, null);
            options.attachExposures(null);
            options.attachAttention(null);
          });
          await client!.start();
        },
        fence() {
          fenced = true;
          quota.stop();
          links.fence();
          client?.fence();
          options.representative.attachReports(null, null);
          options.attachExposures(null);
          options.linkState?.("offline");
        },
        async close() {
          fenced = true;
          await teardown.run();
        },
        /** Diagnostics seams (not part of HubMountedService). */
        binding,
        representative: service,
      } as HubMountedService & Record<string, unknown>;
    } catch (err) {
      return fail(err);
    }
  };
  const drain = async (): Promise<void> => {
    if (!unconfirmed) return;
    await unconfirmed.run();
    unconfirmed = null;
  };
  return Object.assign(createMember, { drain });
}
