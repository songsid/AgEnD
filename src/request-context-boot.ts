/** Startup inspection precedes the outbox's writable open, recovery and all owner launches. */
import Database from "better-sqlite3";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { RequestContextPublication, readRequestContextInstallation, type RequestContextInstallationState } from "./request-context-installation.js";
import { RequestContextPolicyError, type RequestContextPolicyPort, type RequestContextOperation } from "./request-context-policy.js";

export interface RequestContextFleetLease { readonly id: string; current(): boolean }
export interface RequestContextServingIngress {
 readonly relay:import("./request-context-relay.js").RequestContextRelayPort;
 readonly human:(instance:string,payload:Record<string,unknown>,origin:import("./human-delivery-receipts.js").HumanOrigin,body:string)=>ReturnType<import("./delivery-outbox.js").DeliveryOutbox["createHumanReceipt"]>;
 readonly hub:(input:import("./hub/representative.js").HubRepresentativeDelivery)=>ReturnType<import("./request-context-hub-resolver.js").RequestHubInputResolver["capture"]>;
 readonly api:import("./request-contact-api.js").RequestContactApiHost;
 readonly cards:import("./request-contact-card.js").RequestContactCards;
 current():boolean;
}
export interface RequestContextBootPorts { readonly policy: RequestContextPolicyPort; readonly serving?:RequestContextServingIngress }
/** Missing is legacy. Unreadable, redirected, partial or malformed is never legacy. Live DB only, never a snapshot. */
export function readRequestContextBootState(dataDir: string): RequestContextInstallationState | null {
  const path = join(dataDir, "delivery-outbox.db");
  let before;
  try { before = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const suffix of ["-wal", "-shm"]) {
      try { lstatSync(path + suffix); }
      catch (sidecar) { if ((sidecar as NodeJS.ErrnoException).code === "ENOENT") continue; throw sidecar; }
      throw Error("Request-context database is missing but its journal remains");
    }
    return null;
  }
  const parent = realpathSync(dataDir);
  if (!before.isFile() || before.nlink !== 1 || realpathSync(path) !== join(parent, "delivery-outbox.db")) throw Error("Request-context database path differs");
  for (const suffix of ["-wal", "-shm"]) {
    try { const sidecar = lstatSync(path + suffix); if (!sidecar.isFile() || sidecar.nlink !== 1) throw Error("Request-context database sidecar differs"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const value = readRequestContextInstallation(db), after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) throw Error("Request-context database changed during startup");
    return value;
  } finally { db.close(); }
}
/** An activated boot never creates a legacy owner while the capable installer is unavailable. */
export class RequestContextBoot {
  readonly publication: RequestContextPublication<RequestContextBootPorts>;
  readonly owner: { readonly owner: string; current(): boolean };
  readonly policy: RequestContextPolicyPort;
  constructor(readonly initial: RequestContextInstallationState, lease: RequestContextFleetLease) {
    if (!lease.current()) throw Error("Request-context Fleet lease unavailable");
    // Durable Fleet identity belongs to the retained installation; currentness belongs to this exact process lock.
    this.owner = Object.freeze({ owner: initial.owner, current: () => lease.current() });
    this.publication = new RequestContextPublication(this.owner, true);
    this.policy = Object.freeze({
      assert: (input: RequestContextOperation) => {
        const covered=input.admission?.coverage==="covered"?input.admission.lease:null;
        if(covered&&!covered.current())throw new RequestContextPolicyError("stale");
        const installed = covered?this.publication.captureExecution():this.publication.capture();
        if (!installed) throw new RequestContextPolicyError("uncovered");
        const permit=installed.ports.policy.assert(input);
        if(covered? !covered.current()||!installed.executionCurrent():!installed.current())throw new RequestContextPolicyError("stale");
        return permit;
      },
      installedMode: () => this.publication.installedMode(),
    });
  }
  readonly recoveryCurrent = (): boolean => this.publication.recoveryAvailable();
  requirePreparedOwner(): never { throw Error("Request-context owner preparation unavailable"); }
}
