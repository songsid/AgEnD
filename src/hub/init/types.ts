/**
 * Hub initialization (S-48 / S5a, hub.md §5 "S5: audit, notifications, administration and init"). HubInitPlan and
 * HubInitializer follow hub.md plus the S1 additions agreed with its author (hub-s48-init):
 * - `memberListen` / `webListen`: explicit listener addresses (no implicit all-interface exposure);
 * - `webTls`: the browser-facing HTTPS certificate the operator supplies (separate from the member certificate);
 * - `prepareConfirmation`: creates the opaque, plan-bound `localOwnerConfirmation` that `commit` requires.
 */
import type { HubDirectoryConfig, PersonKey } from "../directory/index.js";

export type HubCoexistence = "dedicated" | "same-user-pilot";

export interface HubInitPlan {
  name?: string;
  /** Browser origin (https://host[:port]) — distinct from memberOrigin. */
  webOrigin: string;
  /** Member transport origin; its host goes into the self-signed member certificate's SAN. */
  memberOrigin: string;
  directory: HubDirectoryConfig;
  bindPasswordRef: string;
  /** The immutable directory identity designated by the local owner; claimed on its first browser sign-in. */
  administrator: PersonKey;
  retention: { contentDays: number; eventDays: number };
  coexistence: HubCoexistence;
  /** Where the member transport listens (a specific interface address, never a wildcard). */
  memberListen: HubListen;
  /** Where the browser HTTPS listener listens. */
  webListen: HubListen;
  /** The operator's browser certificate chain and private key (PEM files); copied privately on commit. */
  webTls: {
    certFile: string;
    keyFile: string;
    /** Private staging owned by explicit certificate preparation, for cleanup after resume. */
    generated?: true;
  };
}

export interface HubListen {
  host: string;
  port: number;
}

export interface HubInitInspection {
  existingFleet: boolean;
  existingHub: boolean;
  /** Addition: what was found, for the wizard's warning. */
  fleetEvidence: readonly string[];
  /** Addition: an initialization that stopped part-way (a visible repair state), if any. */
  incomplete?: { startedAt: string; stage: string; plan: HubInitPlan };
}

export interface HubIdentitySummary {
  hubId: string;
  /** SHA-256 of the member certificate's SubjectPublicKeyInfo (what members pin), lowercase hex. */
  spkiSha256: string;
  issuerKeyId: string;
  /** PEM public key of the Ed25519 issuer. */
  issuerPublicKey: string;
}

/**
 * S1 owns Hub key material (hub.md §2): a TLS key + self-signed certificate with the member address in its SAN, a
 * stable random hubId and the Ed25519 issuer key. Init calls it; it never generates keys itself.
 */
export interface HubIdentityProvider {
  readonly available: boolean;
  /** Create the identity privately under the AgEnD home. Must refuse to overwrite an existing identity. */
  provision(args: { home: string; memberOrigin: string }): Promise<HubIdentitySummary>;
  /** The identity already provisioned under the home, if any (to resume an interrupted initialization). */
  read(home: string): Promise<HubIdentitySummary | undefined>;
  /**
   * S1 `sealHubInitialization` (read-only): the issuer key's Ed25519 signature over
   * JSON.stringify(["agend-hub-init-v1", 1, hubId, planDigest, committedAt, confirmationId]). S5 writes the manifest.
   * Called only after the local-owner confirmation was verified, before `hub.enabled` is published.
   */
  seal(args: { home: string; planDigest: string; confirmationId: string; committedAt: string }): string | Promise<string>;
}

export interface HubInitSecrets {
  /** The directory service account's password; written to the private file bindPasswordRef names, nowhere else. */
  bindPassword: string;
}

/** Trusted server adapter only: the host's D3 session on this computer, never parsed from a browser body. */
export interface HubInitHostOwner {
  kind: "host-session";
  ownerKey: object;
  sessionId: string;
  authorityEpoch: number;
  requestId: string;
  current(): boolean;
}
/** Durable provenance contains hashes/ids only, never the session record, cookie, callback or service password. */
export interface HubInitConfirmationProvenance {
  v: 1;
  planDigest: string;
  referenceHash: string;
  at: number;
  source: { kind: "terminal" } | { kind: "host-session"; sessionId: string; authorityEpoch: number; requestId: string };
  confirmationId: string;
}

export interface HubInitConfirmation {
  /** Opaque, single-use, expires; bound to the plan digest and to the secrets given with it. */
  reference: string;
  /** Digest of the plan and its certificate files that this confirmation is bound to (not the sealed config digest). */
  planDigest: string;
  summary: string;
}

export interface HubInitResult {
  hubId: string;
  spkiSha256: string;
  issuerKeyId: string;
  configPath: string;
}

export interface HubInitializer {
  inspect(): Promise<HubInitInspection>;
  /** Throws HubInitError with every problem; nothing is written. */
  validate(plan: HubInitPlan): Promise<void>;
  /** Addition: validate, then hold the plan + secrets in memory under a fresh reference for commit. */
  prepareConfirmation(plan: HubInitPlan, secrets: HubInitSecrets, owner?: HubInitHostOwner): Promise<HubInitConfirmation>;
  commit(plan: HubInitPlan, localOwnerConfirmation: string, owner?: HubInitHostOwner): Promise<HubInitResult>;
  /** Internal narrowing cleanup for a server-owned draft; never an HTTP bearer-authority endpoint. */
  discardConfirmation?(reference: string): void;
  close?(): void;
}

export class HubInitError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[] = [message],
  ) {
    super(message);
    this.name = "HubInitError";
  }
}
