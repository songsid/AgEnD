import { HUB_WEB_INIT_AUDIT_MIGRATION, importHubWebInitAudit } from "../init/web-audit-import.js";
/**
 * S5b server factory (S-51; docs/design/hub-composition.md §5 "Server"). Called by S1's HubMount only after the sealed
 * manifest verified. Builds, in order: the private DB and its migrations, the Hub-instance binding, floors and content
 * key (first creation only), audit + unit of work, S1's transport store and pairing, S2's directory, S3's HTTP entry,
 * S1's member listener and the Hub web listener. Either the whole service comes back or nothing stays open.
 */
import { createPrivateKey, randomBytes } from "node:crypto";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { createHubAudit, HUB_AUDIT_MIGRATION, type HubAuditStore, type HubContentStore } from "../audit/index.js";
import {
  applyHubMigrations,
  bindHubInstance,
  createHubUnitOfWork,
  HUB_INSTANCE_MIGRATION,
  HubStateError,
  inspectStateSet,
  openHubDatabase,
  type HubHoldCode,
  type HubMigration,
} from "../db.js";
import { resolveDirectoryConfig, type HubDirectory, type HubDirectoryConfig } from "../directory/index.js";
import { groupPolicyMigration, createHubGroupPolicyStore, inspectHubGroupPolicyBinding, type HubGroupPolicyStore } from "../group-policy/store.js";
import { HUB_GROUP_RESOURCES_MIGRATION } from "../group-policy/resources.js";
import { createHubGroupAuthorization, type HubGroupAuthorization } from "../group-policy/authorization.js";
import { HUB_ENROLMENT_CODE_MIGRATION } from "../enrolment-code.js";
import { HubPairingNotices, HUB_PAIRING_NOTICES_MIGRATION } from "../pairing-notices.js";
import { createHubGroupAdminControl } from "../group-policy/admin-control.js";
import { createHubGroupAdminInventory } from "../group-policy/admin-inventory.js";
import { createHubGroupWelcome } from "../group-policy/welcome.js";
import { signAsker, canonicalArguments, sha256, personKeyString } from "../identity.js";
import { BIND_SECRET_REL, bindSecretPath } from "../init/layout.js";
import type { HubMountedService } from "../mount.js";
import { HubPairingService } from "../pairing.js";
import { ensurePrivateDirectory, readPrivateFile } from "../private-files.js";
import { HubServer, type HubLinkContext } from "../server.js";
import { HUB_TRANSPORT_MIGRATION, HubTransportStore } from "../store.js";
import { readHubIdentity } from "../tls.js";
import type { HubAskerEnvelope, HubMemberFrame, HubMode, HubPerson, HubServerFrame, HubServerTransport, HubUnitOfWork, PersonKey } from "../types.js";
import { HubFileVersionFloor } from "../version-floor.js";
import { HUB_NAME_RULE, type HubSettingsWriter } from "../settings-commit.js";
import { browserCertificateMigration, createHubBrowserCertificateControl, type HubBrowserCertificateControl } from "../browser-certificate.js";
import { createHubRetentionControl, retentionMigration, type HubRetentionControl } from "../retention.js";
import { createHubPreviewHandler, hubPreviewSettings, hubPreviewView, type HubPreviewSettings, type HubPreviewView } from "../preview.js";
import { HUB_ATTACHMENTS_MIGRATION, HubAttachmentStore } from "../attachments/store.js";
import { HUB_COMPANY_JOIN_MIGRATION } from "../join/store.js";
import { signCompanyInvitation } from "../join/invitation.js";
import { signCompanyDescriptor } from "../join/descriptor.js";
import { HubCompanyJoin } from "../join/service.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION } from "../settings-directory-decision.js";
import { HUB_DIRECTORY_RECOVERY_MIGRATION } from "../settings-directory-recovery-intent.js";
import { createHubWebAddressDecision, HUB_WEB_ADDRESS_MIGRATION, type HubWebAddressDecision } from "../settings-web-address-decision.js";
import { createHubDirectoryNotices, HUB_DIRECTORY_HOST_NOTICE_SINK, type HubDirectoryNotices } from "../settings-directory-notices.js";
import { createHubDirectoryMountBarrier } from "../settings-directory-mount.js";
import type { HubMountedDirectory, HubDirectoryBrowserSessions } from "../settings-directory-runtime.js";
import { parseGroupPolicy } from "../group-policy/model.js";
import type { HubDirectoryResponse, HubDirectoryResponseListener, HubDirectoryResponseOwner } from "../directory-response-owner.js";

import { SERVER_SET, createKeyFile, readKeyFile } from "./storage.js";
export { SERVER_SET } from "./storage.js";

/** What S3b's createHubHttp receives (agreed in cid-hub-s3b-deps). */
export interface HubHttpDeps {
  /** Host-lifetime control; acquired only after the request proves configured-admin authority. */
  directorySettings?: () => Promise<import("../settings-directory-control.js").HubDirectorySettingsControl>;
  uow: HubUnitOfWork;
  audit: HubAuditStore;
  content: HubContentStore;
  /** attachments-v1 files under the content key (absent: the Hub offers no upload). */
  attachments?: HubAttachmentStore;
  directory: HubDirectory;
  pairing: HubPairingService;
  companyJoin?: HubCompanyJoin;
  groups?: HubGroupAuthorization;
  groupHttp?: import("../group-policy/admin-api.js").GroupHttpDeps;
  pairingNotices?: HubPairingNotices;
  directoryNotices?: Pick<HubDirectoryNotices, "forSession" | "acknowledgeSession">;
  store: HubTransportStore;
  current(): HubMode;
  now?: () => number;
  /** Private physical response ownership only; the directory route must independently prove the actor and operation. */
  directoryResponse?: { capture(req: IncomingMessage, res: ServerResponse, current: () => boolean): HubDirectoryResponse };
  preview?: Readonly<HubPreviewView>;
  config: Readonly<{ hubId: string; name: string; memberOrigin: string; webOrigin: string; administrator: PersonKey }>;
  /** M-2682: Hub Administration → This Hub — what it is (read-only) and, with the host's writer, its rename. */
  hubSettings?: Readonly<{ info: Readonly<{ hubId: string; memberSpkiSha256: string; issuerKeyId: string; version: string | null; coexistence?: string | null }>; writer?: HubSettingsWriter }>;
  issuer: { keyId: string; sign(envelope: Omit<HubAskerEnvelope, "signature">): HubAskerEnvelope };
  /** null before the member listener runs and after fence/close: S3 answers "unavailable", never queues. */
  transport(): Pick<HubServerTransport, "send"> | null;
}

export interface HubHttp {
  /** Serve a request under /hub/v1/*; false if the path is not S3's. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  receive(frame: Exclude<HubMemberFrame, { type: "hello" }>, link: HubLinkContext): Promise<HubServerFrame | void>;
  close(): Promise<void>;
  /** #3298 S-89: what the Hub offers its pages ("group-policy-v1" with group permissions composed). Absent on an older entry. */
  readonly features?: readonly string[];
  /** Private adapter only; no token/ref lookup HTTP route or browser capability. */
  readonly directorySessions?: HubDirectoryBrowserSessions;
}

export interface HubHttpEntry {
  createHubHttp(deps: HubHttpDeps): HubHttp;
  migrations: readonly HubMigration[];
}

export interface HubServerComponents {
  /** S3b's entry (src/hub/http/compose.ts), imported lazily. Missing: hub-incomplete, before any I/O. */
  http?: () => Promise<HubHttpEntry>;
}

export interface HubServerFactoryOptions {
  directorySettings?: () => Promise<import("../settings-directory-control.js").HubDirectorySettingsControl>;
  home: string;
  components: HubServerComponents;
  createDirectory: (config: HubDirectoryConfig, secrets: { bindPassword: string }) => HubDirectory;
  /** The specific reason, reported before the factory throws (HubMount itself only knows service-unavailable). */
  report(code: HubHoldCode, detail: string): void;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  now?: () => number;
  /** Retention job interval; daily by default. */
  retentionEveryMs?: number;
  /** Host Settings only; the disposer removes this exact generation's control. */
  retentionReady?(control: HubRetentionControl): () => void;
  /** #3298 S-89: this Hub offers group permissions (its HTTP has "group-policy-v1"); the returned function withdraws it. */
  groupPermissionsReady?(): () => void;
  browserCertificateReady?(control: HubBrowserCertificateControl): () => void;
  /** M-2682: the host's one writer for sealed settings (settings-commit.ts); absent: Hub Administration can't rename. */
  settingsWriter?: HubSettingsWriter;
  /** Private owning-generation publication; its disposer withdraws this exact instance. */
  directoryReady?(directory: HubMountedDirectory): () => void;
  /** Physical participant remains owned until this exact database generation is closed. */
  webAddressReady?(decision: HubWebAddressDecision): () => void;
  /** Runtime-owned across server generations; absent on older/custom factories. */
  directoryResponses?: HubDirectoryResponseOwner;
  /** This AgEnD's version, shown on Hub Administration → This Hub. */
  version?: string | null;
}

interface ServerSettings {
  hubId: string;
  name: string;
  webOrigin: string;
  memberOrigin: string;
  memberListen: { host: string; port: number };
  webListen: { host: string; port: number };
  webTls: { certificateFile: string; keyFile: string };
  preview: HubPreviewSettings | null;
  directory: HubDirectoryConfig & { bindPasswordRef: string };
  administrator: PersonKey;
  retention: { contentDays: number; eventDays: number };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const listen = (v: unknown, label: string) => {
  const o = obj(v);
  if (typeof o.host !== "string" || !o.host || !Number.isInteger(o.port) || (o.port as number) < 0 || (o.port as number) > 65535) {
    throw new HubStateError("hub-unsealed", `hub.${label} is not a listener address`);
  }
  return { host: o.host, port: o.port as number };
};

/** The mount's parse of the hub.* block (exported for its tests). */
export function settingsOf(cfg: Record<string, unknown>): ServerSettings {
  const tls = obj(cfg.webTls);
  const admin = obj(cfg.administrator);
  const retention = obj(cfg.retention);
  const directory = obj(cfg.directory);
  for (const k of ["hubId", "webOrigin", "memberOrigin"]) {
    if (typeof cfg[k] !== "string" || !cfg[k]) throw new HubStateError("hub-unsealed", `hub.${k} is missing`);
  }
  // M-2682: a cleared Hub name is the key absent (the plain brand); a present one is a non-blank string (settings-commit.ts).
  if (cfg.name !== undefined && (typeof cfg.name !== "string" || !HUB_NAME_RULE.test(cfg.name) || cfg.name !== cfg.name.trim())) throw new HubStateError("hub-unsealed", "hub.name is invalid");
  if (typeof tls.certificateFile !== "string" || typeof tls.keyFile !== "string") throw new HubStateError("hub-unsealed", "hub.webTls is missing");
  if (typeof admin.realm !== "string" || typeof admin.objectId !== "string") throw new HubStateError("hub-unsealed", "hub.administrator is missing");
  if (!Number.isSafeInteger(retention.contentDays) || !Number.isSafeInteger(retention.eventDays)) throw new HubStateError("hub-unsealed", "hub.retention is missing");
  if (typeof directory.bindPasswordRef !== "string") throw new HubStateError("hub-unsealed", "hub.directory.bindPasswordRef is missing");
  const webListen = listen(cfg.webListen, "webListen"), memberListen = listen(cfg.memberListen, "memberListen");
  const preview = hubPreviewSettings({ web: cfg.web, webOrigin: cfg.webOrigin as string, memberOrigin: cfg.memberOrigin as string, webListen, memberListen });
  return {
    hubId: cfg.hubId as string,
    name: typeof cfg.name === "string" ? cfg.name : "",   // "" = no name: the plain brand
    webOrigin: cfg.webOrigin as string,
    memberOrigin: cfg.memberOrigin as string,
    memberListen,
    webListen,
    preview,
    webTls: { certificateFile: tls.certificateFile, keyFile: tls.keyFile },
    directory: directory as unknown as ServerSettings["directory"],
    administrator: { realm: admin.realm, objectId: admin.objectId },
    retention: { contentDays: retention.contentDays as number, eventDays: retention.eventDays as number },
  };
}

/** One registry for normal mount and cold recovery; recovery only validates these versions and never runs them. */
export function hubServerDatabasePlan(cfg: Record<string, unknown>, httpMigrations: readonly HubMigration[]) {
  const settings = settingsOf(cfg), resolvedDirectory = resolveDirectoryConfig(settings.directory);
  const groupGeneration = sha256(canonicalArguments({ v: 1, realm: resolvedDirectory.realm, url: resolvedDirectory.url,
    profile: resolvedDirectory.profile, baseDn: resolvedDirectory.baseDn, bindDn: resolvedDirectory.bindDn,
    loginAttribute: resolvedDirectory.loginAttribute, userFilter: resolvedDirectory.userFilter,
    caSha256: resolvedDirectory.caPem === undefined ? null : sha256(resolvedDirectory.caPem) }));
  const migrations = [HUB_INSTANCE_MIGRATION, HUB_AUDIT_MIGRATION, HUB_WEB_INIT_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, ...httpMigrations,
    retentionMigration(settings.hubId, settings.retention), browserCertificateMigration(settings.hubId), HUB_ATTACHMENTS_MIGRATION,
    groupPolicyMigration(settings.hubId, resolvedDirectory.realm, groupGeneration), HUB_GROUP_RESOURCES_MIGRATION,
    HUB_PAIRING_NOTICES_MIGRATION, HUB_COMPANY_JOIN_MIGRATION, HUB_ENROLMENT_CODE_MIGRATION, HUB_DIRECTORY_SETTINGS_MIGRATION, HUB_DIRECTORY_RECOVERY_MIGRATION, HUB_WEB_ADDRESS_MIGRATION];
  return { settings, resolvedDirectory, groupGeneration, migrations };
}

/**
 * Ordered cleanup that never pretends: steps run in reverse creation order, each at most once successfully; the first
 * failure stops the run (no dependency is closed under a component whose own close is unconfirmed) and is reported as
 * an unconfirmed shutdown. Running it again retries from the failed step.
 */
class Teardown {
  private readonly steps: { name: string; run: () => unknown; done: boolean }[] = [];
  add(name: string, run: () => unknown): void {
    this.steps.push({ name, run, done: false });
  }
  get pending(): boolean {
    return this.steps.some((s) => !s.done);
  }
  async run(): Promise<void> {
    for (let i = this.steps.length - 1; i >= 0; i -= 1) {
      const step = this.steps[i]!;
      if (step.done) continue;
      try {
        await step.run();
        step.done = true;
      } catch (err) {
        throw new HubStateError("service-unavailable", `Hub cleanup of ${step.name} is unconfirmed: ${(err as Error).message}`);
      }
    }
  }
}

export function createHubServerFactory(options: HubServerFactoryOptions) {
  const now = options.now ?? Date.now;
  /** A previous attempt whose cleanup was not confirmed: nothing new is created until it is, and Off/Stop drain it. */
  let unconfirmed: Teardown | null = null;
  const createServer = async function createServer(cfg: Record<string, unknown>, current: () => boolean): Promise<HubMountedService> {
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
        unconfirmed = teardown; // kept: retried before any replacement is created
        options.report("service-unavailable", (cleanupErr as Error).message);
        throw cleanupErr;
      }
      const code: HubHoldCode = err instanceof HubStateError ? err.code : "service-unavailable";
      options.report(code, (err as Error).message);
      throw err;
    };
    try {
      // 0. Every slice present, before any I/O: no partial server.
      if (!options.components.http) throw new HubStateError("hub-incomplete", "the Hub web service (S3) is not in this build");
      const httpEntry = await options.components.http();
      const { settings, resolvedDirectory, groupGeneration, migrations } = hubServerDatabasePlan(cfg, httpEntry.migrations);
      const previewBoot = randomBytes(16).toString("hex");

      // 1. The private state set: new (create all), complete (open), anything else refused.
      const state = inspectStateSet(options.home, SERVER_SET);
      const db: Database.Database = openHubDatabase(options.home, SERVER_SET.database, { create: state === "new" });
      teardown.add("the Hub database", () => db.close());
      const floor = new HubFileVersionFloor(options.home, SERVER_SET.floors[0]!);
      if (state === "new") {
        floor.initialize();
        createKeyFile(options.home, SERVER_SET.keys[0]!);
      }
      applyHubMigrations(db, migrations);
      bindHubInstance(db, settings.hubId, state, now());

      // 2. Audit + unit of work + S1's transport store (its audit goes through the bridge, same transaction).
      const contentKey = readKeyFile(options.home, SERVER_SET.keys[0]!);
      const audit = createHubAudit({ db, contentKey, now });
      // attachments-v1 files, under the same content key as audit content.
      const attachments = new HubAttachmentStore({ contentKey, now });
      const uow = createHubUnitOfWork(db);
      const store = new HubTransportStore(db, { floor, appendAudit: (record, database) => audit.appendInTransaction(record, database) });
      if (state === "new") store.initialize();
      // Required bootstrap evidence is durable in the Hub chain before either listener opens.
      importHubWebInitAudit({ home: options.home, db, audit, hubId: settings.hubId, version: store.read().revocationVersion });

      // Retain the existing actionable secret error before the full material barrier judges the pair.
      if (!bindSecretPath(options.home, settings.directory.bindPasswordRef)) throw new HubStateError("hub-directory-secret", "hub.directory.bindPasswordRef is not the private bind file");
      let bindPassword: string;
      try { bindPassword = readPrivateFile(options.home, BIND_SECRET_REL, 4096, { preserveBom: true }); }
      catch (err) { throw new HubStateError("hub-directory-secret", `the directory bind secret is missing or not private: ${(err as Error).message}`); }

      let memberServer: HubServer | null = null;
      let fenced = false;
      const owned = () => !fenced && current();
      let responseListener: HubDirectoryResponseListener | null = null;
      const directoryDecision = createHubDirectorySettingsDecision({ db, transport: store, hubId: settings.hubId });
      const directoryBarrier = createHubDirectoryMountBarrier({ home: options.home, hub: cfg, decision: directoryDecision, current: owned });
      teardown.add("directory material barrier", () => directoryBarrier.close());
      const addressDecision = createHubWebAddressDecision({ db, home: options.home, hubId: settings.hubId, initial: settings.webTls, audit });
      addressDecision.assertMounted(cfg);
      const addressHead = addressDecision.head();
      // A SQL decision closes old sign-in flights before any file hook, await or listener replacement.
      const live = () => {
        try { const head=addressDecision.head();return owned() && directoryBarrier.current() && head.revision === addressHead.revision && head.operationId===addressHead.operationId; }
        catch { return false; }
      };
      if (sha256(bindPassword) !== directoryBarrier.assertCurrent().bindSecretSha) throw new HubStateError("hub-directory-secret", "the directory bind secret changed while mounting");

      // 3. S2 directory with the service password from the one accepted private file.
      const { bindPasswordRef: _ref, ...directoryConfig } = settings.directory;
      const directory = options.createDirectory(directoryConfig as HubDirectoryConfig, { bindPassword });
      teardown.add("the directory client", () => (directory as { close?: () => Promise<void> }).close?.());

      // 4. S1 identity, pairing and the member listener; S3's HTTP entry in between (it supplies receive).
      const identity = readHubIdentity({ home: options.home, memberOrigin: settings.memberOrigin });
      if (identity.hubId !== settings.hubId) throw new HubStateError("hub-state-mismatch", "the Hub keys belong to another Hub");
      const issuerKey = createPrivateKey(readPrivateFile(options.home, "hub/keys/issuer-key.pem"));
      let groupPolicy: HubGroupPolicyStore | undefined;
      const policy = () => groupPolicy ??= createHubGroupPolicyStore({ db, hubId: settings.hubId, realm: resolvedDirectory.realm,
        generation: groupGeneration, directory, audit, current: live, now });
      const directoryNotices = createHubDirectoryNotices({ db, transport: store, hubId: settings.hubId,
        hostSink: HUB_DIRECTORY_HOST_NOTICE_SINK, audit, current: live, now });
      teardown.add("directory security notices", () => directoryNotices.close());
      const mountedDirectory: HubMountedDirectory = Object.freeze({
        decision: directoryDecision,
        current: live,
        source: () => db.transaction(() => {
          const stamp = directoryBarrier.capture();
          const previous = directoryDecision.proofBasis()?.policy ?? parseGroupPolicy(JSON.parse(
            (db.prepare("SELECT body FROM hub_group_policy WHERE singleton=1").get() as { body: string }).body));
          return { directory, config: structuredClone(directoryConfig), bindPassword, administrator: { ...settings.administrator },
            groups: previous.groups.map(g => ({ key: { ...g.group }, dn: g.dn })), ...stamp, current: live };
        })(),
        sessions() {
          if (!live() || !http.directorySessions) throw new HubStateError("service-unavailable", "The directory session adapter is unavailable");
          return http.directorySessions;
        },
        withDirectoryRead: <T>(person: PersonKey, work: () => Promise<T>) => policy().withDirectoryRead(person, work),
      });
      const binding = () => inspectHubGroupPolicyBinding(db, settings.hubId, resolvedDirectory.realm, groupGeneration);
      const groups = createHubGroupAuthorization({ db, administrator: settings.administrator, directory,
        policy, binding,
        audit, current: live, now, version: () => store.read().revocationVersion,
        advanceAuthorization: (database, resource) => {
          if (database !== db || !db.inTransaction) throw new HubStateError("service-unavailable", "the group authorization transaction is unavailable");
          store.mutate({ at: now(), requestId: randomBytes(16).toString("hex"), actor: { kind: "local-host" },
            action: "group-resource.authorization-changed", result: "completed",
            ...(resource.kind === "fleet" ? { fleetId: resource.id } : resource.kind === "exposure" ? { exposureId: resource.id } : {}) }, state => { state.revocationVersion++; });
        }, refreshAuthorization: () => memberServer?.refreshAuthorization() });
      teardown.add("group authorization", () => groups.close());
      const retention = createHubRetentionControl({ db, hubId: settings.hubId, audit, current: live, now });
      const pairingNotices = new HubPairingNotices({ db, store, administrator: settings.administrator, directory, audit,
        current: live, now, transport: () => memberServer });
      pairingNotices.start();
      teardown.add("pairing security notices", () => pairingNotices.close());
      const companyIdentity = { hubId: identity.hubId, spkiSha256: identity.spkiSha256, issuerPublicKey: identity.issuerPublicKey,
        webOrigin: settings.webOrigin, memberOrigin: settings.memberOrigin };
      const companyJoin = new HubCompanyJoin({ home: options.home, db, store, audit, groups, notices: pairingNotices, name: settings.name,
        refreshAuthorization: () => memberServer?.refreshAuthorization(),
        identity: companyIdentity, connected: fleetId => memberServer?.features(fleetId) !== null && memberServer?.features(fleetId) !== undefined, signInvitation: claims => signCompanyInvitation(claims, issuerKey), descriptor: signCompanyDescriptor(companyIdentity, issuerKey),
        certificatePem: readPrivateFile(options.home, "hub/keys/tls-cert.pem"), administrator: settings.administrator,
        eventDays: settings.retention.eventDays, current: live, now });
      const pairing = new HubPairingService({
        store,
        identity: { hubId: identity.hubId, memberOrigin: settings.memberOrigin, webOrigin: settings.webOrigin, spkiSha256: identity.spkiSha256, issuerPublicKey: identity.issuerPublicKey },
        directory,
        enabled: live,
        now,
        fenceFleet: (fleetId, reason) => memberServer?.fenceFleet(fleetId, reason),
        refreshAuthorization: () => memberServer?.refreshAuthorization(),
        enrollment: { prepare: (resource, ctx) => groups.prepareEnrollment(resource, ctx),
          prepareManual: (resource, approvedBy, ctx) => groups.prepareManualEnrollment(resource, approvedBy, ctx),
          atomic: work => db.transaction(() => work(db)).immediate() },
        quick: { enqueue: pairingNotices.enqueue, committed: pairingNotices.committed },
        automaticReservations: { count: owner => companyJoin.records.reservations(owner), retained: () => companyJoin.retained() },
      });
      const groupControl = createHubGroupAdminControl({ db, audit, directory, administrator: settings.administrator,
        transport: store, inventory: createHubGroupAdminInventory({ db, transport: store, realm: resolvedDirectory.realm }),
        authorization: groups, policy, binding, current: live, version: () => store.read().revocationVersion, now,
        advanceAuthorization: database => {
          if (database !== db || !db.inTransaction) throw new HubStateError("service-unavailable", "the group policy transaction is unavailable");
          store.mutate({ at: now(), requestId: randomBytes(16).toString("hex"), actor: { kind: "local-host" },
            action: "group-policy.authorization-changed", result: "completed" }, state => {
            const next = policy().read();
            companyJoin.policyUpdated(next);
            // The same policy-change transaction cancels known off/denied automatic reservations, never manual ones.
            const denied = new Set(next.denies.filter(d => d.deny.includes("pair_fleet")).map(d => personKeyString(d.person)));
            state.pairings = state.pairings.filter(p => !p.automatic || !["offered", "pending"].includes(p.state)
              || (next.state === "enabled" && !denied.has(personKeyString(p.owner))));
            state.revocationVersion++;
          });
        }, refreshAuthorization: () => memberServer?.refreshAuthorization() });
      teardown.add("group policy confirmation", () => groupControl.close());
      const groupWelcome = createHubGroupWelcome({ policy, readiness: () => {
        const state = binding();
        return state.kind === "ready" ? "ready" : state.legacy ? "never-enabled" : "unavailable";
      }, fleets: () => store.read().fleets, fleetState: async resource => groups.resourceState(resource) });
      let generation = 0;
      const mode: HubMode = { serverEnabled: live, memberEnabled: () => false, epoch: () => generation };
      const http = httpEntry.createHubHttp({
        uow,
        audit,
        content: audit.content,
        attachments,
        directory,
        pairing,
        companyJoin,
        groups,
        groupHttp: { control: groupControl, welcome: groupWelcome },
        pairingNotices,
        directoryNotices,
        ...(options.directorySettings ? { directorySettings: options.directorySettings } : {}),
        store,
        current: () => mode,
        now,
        ...(options.directoryResponses ? { directoryResponse: Object.freeze({ capture(req: IncomingMessage, res: ServerResponse, proof: () => boolean) {
          if (!live() || !responseListener) throw new HubStateError("service-unavailable", "The directory response owner is unavailable");
          return responseListener.capture(req, res, () => proof() === true && live());
        } }) } : {}),
        preview: hubPreviewView(settings.webOrigin, settings.preview, previewBoot),
        config: Object.freeze({ hubId: settings.hubId, name: settings.name, memberOrigin: settings.memberOrigin, webOrigin: settings.webOrigin, administrator: Object.freeze({ ...settings.administrator }) }),
        hubSettings: Object.freeze({ info: Object.freeze({ hubId: identity.hubId, memberSpkiSha256: identity.spkiSha256, issuerKeyId: identity.issuerKeyId, version: options.version ?? null,
          coexistence: typeof cfg.coexistence === "string" ? cfg.coexistence : null }),
          ...(options.settingsWriter ? { writer: options.settingsWriter } : {}) }),
        issuer: { keyId: identity.issuerKeyId, sign: (envelope) => signAsker(envelope, issuerKey) },
        transport: () => (live() && memberServer ? (memberServer as unknown as Pick<HubServerTransport, "send">) : null),
      });
      teardown.add("the Hub web service (S3)", () => http.close());
      memberServer = new HubServer({
        home: options.home,
        hubId: settings.hubId,
        memberOrigin: settings.memberOrigin,
        listen: settings.memberListen,
        pairing,
        companyJoin,
        current: live,
        receive: (frame, link) => http.receive(frame, link),
        hold: (fleetId, code) => options.log("warn", "Hub member link held", { fleetId, code }),
      });
      teardown.add("the member listener", () => memberServer?.close());

      // 5. The Hub web listener: every request goes to S3's handler (it serves /hub/v1/*, the Hub-only shell and its
      //    assets without fleet cookies); anything it declines is 404. The personal fleet listener is untouched.
      let web: Server | null = null;
      let preview: Server | null = null;
      const browserCertificate = createHubBrowserCertificateControl({ db, home: options.home, hubId: settings.hubId, origin: settings.webOrigin,
        initial: settings.webTls, audit, current: live, now, activate: material => {
          if (!web || !live()) throw Error("unavailable");
          web.setSecureContext({ ...material, minVersion: "TLSv1.2" });
          preview?.setSecureContext({ ...material, minVersion: "TLSv1.2" });
        } });
      teardown.add("browser certificate preparation", () => browserCertificate.close());
      let retentionTimer: NodeJS.Timeout | null = null;
      const serveWeb = (req: IncomingMessage, res: ServerResponse) => {
        if (responseListener && !responseListener.enter(req, res)) return;
        if (!live()) {
          res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end('{"code":"unavailable"}');
          return;
        }
        if (http.handle(req, res)) return;
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Not found");
      };

      return {
        async start() {
          if (!live()) throw new HubStateError("service-unavailable", "the Hub was switched off while starting");
          try {
            directoryBarrier.assertCurrent();
            await memberServer!.start();
            directoryBarrier.assertCurrent();
            if (settings.preview) {
              const server = createHttpsServer({ ...browserCertificate.material(), minVersion: "TLSv1.2" },
                createHubPreviewHandler(settings.preview, settings.webOrigin, previewBoot, live));
              preview = server;
              teardown.add("the Hub preview listener", () => {
                server.closeAllConnections?.();
                return new Promise<void>((resolve, reject) => server.close(err => err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : resolve()));
              });
              await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(settings.preview!.port, settings.preview!.host, () => { server.removeListener("error", reject); resolve(); });
              });
            }
            const server = createHttpsServer(
              { ...browserCertificate.material(), minVersion: "TLSv1.2" },
              serveWeb,
            );
            const responses = options.directoryResponses?.listener(server);
            responseListener = responses ?? null;
            teardown.add("the Hub web listener", () => {
              if (web !== server) return;
              if (responses) return responses.close();
              server.closeAllConnections?.();
              return new Promise<void>((resolve, reject) => server.close((err) => (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : resolve())));
            });
            web = server;
            await new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(settings.webListen.port, settings.webListen.host, () => {
                server.removeListener("error", reject);
                resolve();
              });
            });
            browserCertificate.activate();
            const detachCertificate = options.browserCertificateReady?.(browserCertificate);
            if (detachCertificate) teardown.add("the host browser certificate Settings", detachCertificate);
            retentionTimer = setInterval(() => {
              if (!live()) return;
              try {
                const policy = retention.read();
                audit.purge(policy);
                // Files follow the content policy; expired uploads and unfinished transfers go too.
                db.transaction(() => attachments.purge(db, now() - policy.contentDays * 86_400_000)).immediate();
              } catch (err) {
                options.log("warn", "Hub retention could not run", { err: (err as Error).message });
              }
            }, options.retentionEveryMs ?? 86_400_000);
            retentionTimer.unref();
            const timer = retentionTimer;
            teardown.add("the retention timer", () => clearInterval(timer));
            const detach = options.retentionReady?.(retention);
            if (detach) teardown.add("the host retention Settings", detach);
            if (http.features?.includes("group-policy-v1")) {
              const withdraw = options.groupPermissionsReady?.();
              if (withdraw) teardown.add("the host's group permissions mark", withdraw);
            }
            directoryBarrier.assertCurrent();
            const withdrawDirectory = options.directoryReady?.(mountedDirectory);
            if (withdrawDirectory) teardown.add("the mounted directory control", withdrawDirectory);
            const withdrawAddress = options.webAddressReady?.(addressDecision);
            if (withdrawAddress) teardown.add("the mounted web-address participant", withdrawAddress);
          } catch (err) {
            options.report(err instanceof HubStateError ? err.code : "service-unavailable", (err as Error).message);
            throw err;
          }
        },
        fence() {
          fenced = true;
          generation += 1;
          memberServer?.fence();
        },
        async close() {
          fenced = true;
          // Rejects while any step is unconfirmed; S1 keeps ownership and retries this close before any replacement.
          await teardown.run();
        },
        /** Test and diagnostics seams (not part of HubMountedService). */
        webAddress: () => web?.address() ?? null,
        memberAddress: () => memberServer?.address() ?? null,
        previewAddress: () => preview?.address() ?? null,
        audit,
      } as HubMountedService & Record<string, unknown>;
    } catch (err) {
      return fail(err);
    }
  };
  /**
   * The factory owns what a failed creation could not clean up (HubMount never received a service for it). The runtime
   * calls drain() when the Hub is switched off and when it stops: it retries that cleanup and rejects while it still
   * fails, so the leftover stays owned and reported instead of being forgotten.
   */
  const drain = async (): Promise<void> => {
    if (!unconfirmed) return;
    await unconfirmed.run();
    unconfirmed = null;
  };
  return Object.assign(createServer, { drain });
}

export type HubServerFactory = ReturnType<typeof createHubServerFactory>;

export type { HubPerson };
