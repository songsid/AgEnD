/**
 * S5b server factory (S-51; docs/design/hub-composition.md §5 "Server"). Called by S1's HubMount only after the sealed
 * manifest verified. Builds, in order: the private DB and its migrations, the Hub-instance binding, floors and content
 * key (first creation only), audit + unit of work, S1's transport store and pairing, S2's directory, S3's HTTP entry,
 * S1's member listener and the Hub web listener. Either the whole service comes back or nothing stays open.
 */
import { createPrivateKey, randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
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
  type HubStateSet,
} from "../db.js";
import type { HubDirectory, HubDirectoryConfig } from "../directory/index.js";
import { signAsker } from "../identity.js";
import { BIND_SECRET_REL, bindSecretPath } from "../init/layout.js";
import type { HubMountedService } from "../mount.js";
import { HubPairingService } from "../pairing.js";
import { ensurePrivateDirectory, readPrivateFile } from "../private-files.js";
import { HubServer, type HubLinkContext } from "../server.js";
import { HUB_TRANSPORT_MIGRATION, HubTransportStore } from "../store.js";
import { readHubIdentity } from "../tls.js";
import type { HubAskerEnvelope, HubMemberFrame, HubMode, HubPerson, HubServerFrame, HubServerTransport, HubUnitOfWork, PersonKey } from "../types.js";
import { HubFileVersionFloor } from "../version-floor.js";
import { browserCertificateMigration, createHubBrowserCertificateControl, type HubBrowserCertificateControl } from "../browser-certificate.js";
import { createHubRetentionControl, retentionMigration, type HubRetentionControl } from "../retention.js";

export const SERVER_SET: HubStateSet = Object.freeze({
  database: "hub/hub.sqlite",
  floors: Object.freeze(["hub/floors/transport"]),
  keys: Object.freeze(["hub/keys/content.key"]),
});

/** What S3b's createHubHttp receives (agreed in cid-hub-s3b-deps). */
export interface HubHttpDeps {
  uow: HubUnitOfWork;
  audit: HubAuditStore;
  content: HubContentStore;
  directory: HubDirectory;
  pairing: HubPairingService;
  store: HubTransportStore;
  current(): HubMode;
  now?: () => number;
  config: Readonly<{ hubId: string; name: string; webOrigin: string; administrator: PersonKey }>;
  issuer: { keyId: string; sign(envelope: Omit<HubAskerEnvelope, "signature">): HubAskerEnvelope };
  /** null before the member listener runs and after fence/close: S3 answers "unavailable", never queues. */
  transport(): Pick<HubServerTransport, "send"> | null;
}

export interface HubHttp {
  /** Serve a request under /hub/v1/*; false if the path is not S3's. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  receive(frame: Exclude<HubMemberFrame, { type: "hello" }>, link: HubLinkContext): Promise<HubServerFrame | void>;
  close(): Promise<void>;
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
  browserCertificateReady?(control: HubBrowserCertificateControl): () => void;
}

interface ServerSettings {
  hubId: string;
  name: string;
  webOrigin: string;
  memberOrigin: string;
  memberListen: { host: string; port: number };
  webListen: { host: string; port: number };
  webTls: { certificateFile: string; keyFile: string };
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

function settingsOf(cfg: Record<string, unknown>): ServerSettings {
  const tls = obj(cfg.webTls);
  const admin = obj(cfg.administrator);
  const retention = obj(cfg.retention);
  const directory = obj(cfg.directory);
  for (const k of ["hubId", "name", "webOrigin", "memberOrigin"]) {
    if (typeof cfg[k] !== "string" || !cfg[k]) throw new HubStateError("hub-unsealed", `hub.${k} is missing`);
  }
  if (typeof tls.certificateFile !== "string" || typeof tls.keyFile !== "string") throw new HubStateError("hub-unsealed", "hub.webTls is missing");
  if (typeof admin.realm !== "string" || typeof admin.objectId !== "string") throw new HubStateError("hub-unsealed", "hub.administrator is missing");
  if (!Number.isSafeInteger(retention.contentDays) || !Number.isSafeInteger(retention.eventDays)) throw new HubStateError("hub-unsealed", "hub.retention is missing");
  if (typeof directory.bindPasswordRef !== "string") throw new HubStateError("hub-unsealed", "hub.directory.bindPasswordRef is missing");
  return {
    hubId: cfg.hubId as string,
    name: cfg.name as string,
    webOrigin: cfg.webOrigin as string,
    memberOrigin: cfg.memberOrigin as string,
    memberListen: listen(cfg.memberListen, "memberListen"),
    webListen: listen(cfg.webListen, "webListen"),
    webTls: { certificateFile: tls.certificateFile, keyFile: tls.keyFile },
    directory: directory as unknown as ServerSettings["directory"],
    administrator: { realm: admin.realm, objectId: admin.objectId },
    retention: { contentDays: retention.contentDays as number, eventDays: retention.eventDays as number },
  };
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

/** Create a private file with random bytes, exclusively (never overwrite). */
function createKeyFile(home: string, rel: string): void {
  ensurePrivateDirectory(home, rel.slice(0, rel.lastIndexOf("/")));
  const fd = openSync(`${home}/${rel}`, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(32).toString("base64"));
  } finally {
    closeSync(fd);
  }
}

function readKeyFile(home: string, rel: string): Buffer {
  const key = Buffer.from(readPrivateFile(home, rel, 256).trim(), "base64");
  if (key.length !== 32) throw new HubStateError("hub-storage", `${rel} is not a 32-byte key`);
  return key;
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
      const settings = settingsOf(cfg);

      // 1. The private state set: new (create all), complete (open), anything else refused.
      const state = inspectStateSet(options.home, SERVER_SET);
      const db: Database.Database = openHubDatabase(options.home, SERVER_SET.database, { create: state === "new" });
      teardown.add("the Hub database", () => db.close());
      const floor = new HubFileVersionFloor(options.home, SERVER_SET.floors[0]!);
      if (state === "new") {
        floor.initialize();
        createKeyFile(options.home, SERVER_SET.keys[0]!);
      }
      applyHubMigrations(db, [HUB_INSTANCE_MIGRATION, HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, ...httpEntry.migrations,
        retentionMigration(settings.hubId, settings.retention), browserCertificateMigration(settings.hubId)]);
      bindHubInstance(db, settings.hubId, state, now());

      // 2. Audit + unit of work + S1's transport store (its audit goes through the bridge, same transaction).
      const audit = createHubAudit({ db, contentKey: readKeyFile(options.home, SERVER_SET.keys[0]!), now });
      const uow = createHubUnitOfWork(db);
      const store = new HubTransportStore(db, { floor, appendAudit: (record, database) => audit.appendInTransaction(record, database) });
      if (state === "new") store.initialize();

      // 3. S2 directory with the service password from the one accepted private file.
      if (!bindSecretPath(options.home, settings.directory.bindPasswordRef)) throw new HubStateError("hub-directory-secret", "hub.directory.bindPasswordRef is not the private bind file");
      let bindPassword: string;
      try {
        bindPassword = readPrivateFile(options.home, BIND_SECRET_REL, 4096, { preserveBom: true });
      } catch (err) {
        throw new HubStateError("hub-directory-secret", `the directory bind secret is missing or not private: ${(err as Error).message}`);
      }
      const { bindPasswordRef: _ref, ...directoryConfig } = settings.directory;
      const directory = options.createDirectory(directoryConfig as HubDirectoryConfig, { bindPassword });
      teardown.add("the directory client", () => (directory as { close?: () => Promise<void> }).close?.());

      // 4. S1 identity, pairing and the member listener; S3's HTTP entry in between (it supplies receive).
      const identity = readHubIdentity({ home: options.home, memberOrigin: settings.memberOrigin });
      if (identity.hubId !== settings.hubId) throw new HubStateError("hub-state-mismatch", "the Hub keys belong to another Hub");
      const issuerKey = createPrivateKey(readPrivateFile(options.home, "hub/keys/issuer-key.pem"));
      let memberServer: HubServer | null = null;
      let fenced = false;
      const live = () => !fenced && current();
      const retention = createHubRetentionControl({ db, hubId: settings.hubId, audit, current: live, now });
      const pairing = new HubPairingService({
        store,
        identity: { hubId: identity.hubId, memberOrigin: settings.memberOrigin, webOrigin: settings.webOrigin, spkiSha256: identity.spkiSha256, issuerPublicKey: identity.issuerPublicKey },
        directory,
        enabled: live,
        now,
        fenceFleet: (fleetId, reason) => memberServer?.fenceFleet(fleetId, reason),
      });
      let generation = 0;
      const mode: HubMode = { serverEnabled: live, memberEnabled: () => false, epoch: () => generation };
      const http = httpEntry.createHubHttp({
        uow,
        audit,
        content: audit.content,
        directory,
        pairing,
        store,
        current: () => mode,
        now,
        config: Object.freeze({ hubId: settings.hubId, name: settings.name, webOrigin: settings.webOrigin, administrator: Object.freeze({ ...settings.administrator }) }),
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
        current: live,
        receive: (frame, link) => http.receive(frame, link),
        hold: (fleetId, code) => options.log("warn", "Hub member link held", { fleetId, code }),
      });
      teardown.add("the member listener", () => memberServer?.close());

      // 5. The Hub web listener: every request goes to S3's handler (it serves /hub/v1/*, the Hub-only shell and its
      //    assets without fleet cookies); anything it declines is 404. The personal fleet listener is untouched.
      let web: Server | null = null;
      const browserCertificate = createHubBrowserCertificateControl({ db, home: options.home, hubId: settings.hubId, origin: settings.webOrigin,
        initial: settings.webTls, audit, current: live, now, activate: material => {
          if (!web || !live()) throw Error("unavailable");
          web.setSecureContext({ ...material, minVersion: "TLSv1.2" });
        } });
      teardown.add("browser certificate preparation", () => browserCertificate.close());
      let retentionTimer: NodeJS.Timeout | null = null;
      const serveWeb = (req: IncomingMessage, res: ServerResponse) => {
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
            await memberServer!.start();
            const server = createHttpsServer(
              { ...browserCertificate.material(), minVersion: "TLSv1.2" },
              serveWeb,
            );
            teardown.add("the Hub web listener", () => {
              if (web !== server) return;
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
                audit.purge(retention.read());
              } catch (err) {
                options.log("warn", "Hub retention could not run", { err: (err as Error).message });
              }
            }, options.retentionEveryMs ?? 86_400_000);
            retentionTimer.unref();
            const timer = retentionTimer;
            teardown.add("the retention timer", () => clearInterval(timer));
            const detach = options.retentionReady?.(retention);
            if (detach) teardown.add("the host retention Settings", detach);
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
