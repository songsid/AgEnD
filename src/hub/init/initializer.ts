/**
 * HubInitializer (S-48 / S5a; hub.md §5). Validates a plan, binds the local owner's confirmation to that exact plan,
 * then commits in durable stages under an operation receipt:
 *
 *   started → identity (S1 keys) → web-tls → secret → config (hub.* with enabled: false) → manifest → enabled
 *
 * `hub.enabled: true` is the last write. An interrupted commit leaves the Hub off and a visible repair state; it can
 * be resumed only with the same plan (the saved answers) and never overwrites another Hub identity, never repoints
 * credentials, never installs a service (the wizard asks for that separately, afterwards).
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { atomicWriteFileSync } from "../../atomic-write.js";
import { applyFleetYamlPatches } from "../../fleet-yaml-patch.js";
import { HubDirectoryConfigError, resolveDirectoryConfig } from "../directory/index.js";
import { isCanonicalObjectId } from "../directory/profiles.js";
import { checkBrowserTls, type BrowserTlsProblem } from "./browser-tls.js";
import { existingFleetEvidence, type FleetProbe } from "./existing-fleet.js";
import { BIND_PASSWORD_REF, ENABLE_PATCH, WEB_TLS_CONFIG, hubConfigPatches, hubPaths } from "./layout.js";
import { hubPlanDigest } from "./plan-digest.js";
import {
  HubInitError,
  type HubIdentityProvider,
  type HubIdentitySummary,
  type HubInitConfirmation,
  type HubInitInspection,
  type HubInitializer,
  type HubInitPlan,
  type HubInitResult,
  type HubInitSecrets,
} from "./types.js";

import { hubInstallationInventory } from "./inventory.js";

export const STAGES = ["started", "identity", "web-tls", "secret", "config", "manifest", "enabled"] as const;
export type HubInitStage = (typeof STAGES)[number];

export interface HubInitializerDeps {
  home: string;
  identity: HubIdentityProvider;
  probe: FleetProbe;
  now?: () => number;
  /** The owner private directories must have (default: this process's uid). A seam for the other-owner refusal. */
  uid?: number;
  /** Test seam: called after each stage is durably recorded; a throw simulates an interruption there. */
  afterStage?: (stage: HubInitStage) => void;
}

interface OperationReceipt {
  version: 1;
  operationId: string;
  planDigest: string;
  startedAt: string;
  plan: HubInitPlan;
  done: HubInitStage[];
  identity?: HubIdentitySummary;
}

const CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_PEM_BYTES = 1024 * 1024;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;

const TLS_TEXT: Record<BrowserTlsProblem, string> = {
  "cert-unreadable": "the certificate file is not a PEM certificate",
  "key-unreadable": "the key file is not an unencrypted PEM private key",
  "key-mismatch": "the private key does not belong to the certificate",
  "host-not-covered": "the certificate does not name the web address's host",
  "not-yet-valid": "the certificate is not valid yet",
  expired: "the certificate has expired",
  "ca-certificate": "the first certificate is a CA certificate, not the server's",
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function readPem(path: string, label: string, problems: string[]): string | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      problems.push(`${label}: not a file`);
      return undefined;
    }
    if (st.size > MAX_PEM_BYTES) {
      problems.push(`${label}: larger than 1 MB`);
      return undefined;
    }
    return readFileSync(path, "utf8");
  } catch {
    problems.push(`${label}: cannot be read`);
    return undefined;
  }
}

export function originProblems(label: string, text: string): string[] {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return [`${label}: not a URL`];
  }
  const problems: string[] = [];
  if (url.protocol !== "https:") problems.push(`${label}: must be https:// (there is no plaintext sign-in)`);
  if (url.username || url.password) problems.push(`${label}: must not carry credentials`);
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) problems.push(`${label}: must be https://host[:port] only`);
  if (!url.hostname) problems.push(`${label}: has no host`);
  if (problems.length === 0 && url.origin !== text.replace(/\/$/, "")) problems.push(`${label}: write it as ${url.origin}`);
  return problems;
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** A listener names one interface: an IP address or host name, never a wildcard (no implicit all-interface exposure). */
export function listenProblems(label: string, listen: { host: string; port: number } | undefined): string[] {
  if (!listen || typeof listen !== "object") return [`${label}: required`];
  const problems: string[] = [];
  const host = typeof listen.host === "string" ? listen.host : "";
  if (host === "0.0.0.0" || host === "::" || host === "*" || host === "") {
    problems.push(`${label}: name one interface address (a wildcard would listen on every network)`);
  } else if (!isIP(host) && !HOSTNAME.test(host)) {
    problems.push(`${label}: "${host}" is not an IP address or host name`);
  }
  if (!Number.isInteger(listen.port) || listen.port < 1 || listen.port > 65535) problems.push(`${label}: port must be 1–65535`);
  return problems;
}

/** Private directory: created 0700, never a symlink, owned by `uid`. */
function ensurePrivateDir(path: string, uid: number | undefined): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    st = lstatSync(path);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HubInitError(`${path} is not a private directory (a symlink or not a directory)`);
  if (uid !== undefined && st.uid !== uid) throw new HubInitError(`${path} is owned by another user`);
  if ((st.mode & 0o077) !== 0) throw new HubInitError(`${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)})`);
}

function writePrivate(path: string, content: string, uid: number | undefined): void {
  ensurePrivateDir(dirname(path), uid);
  atomicWriteFileSync(path, content, { mode: 0o600 });
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new HubInitError(`${path} could not be made private (mode ${mode.toString(8)})`);
}

export function createHubInitializer(deps: HubInitializerDeps): HubInitializer {
  const paths = hubPaths(deps.home);
  const now = deps.now ?? Date.now;
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const pending = new Map<string, { planDigest: string; secrets: HubInitSecrets; expiresAt: number }>();

  const readReceipt = (): OperationReceipt | undefined => {
    if (!existsSync(paths.operation)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(paths.operation, "utf8")) as OperationReceipt;
      if (parsed?.version !== 1 || typeof parsed.planDigest !== "string" || !Array.isArray(parsed.done)) throw new Error("shape");
      return parsed;
    } catch {
      throw new HubInitError(`the initialization receipt ${paths.operation} is unreadable; inspect ${paths.hub} before trying again`);
    }
  };
  const writeReceipt = (receipt: OperationReceipt) => writePrivate(paths.operation, `${JSON.stringify(receipt, null, 2)}\n`, uid);

  const hubConfigured = (): boolean => {
    if (!existsSync(paths.fleetYaml)) return false;
    try {
      return /^hub:\s*$/m.test(readFileSync(paths.fleetYaml, "utf8")) && /^\s+hubId:/m.test(readFileSync(paths.fleetYaml, "utf8"));
    } catch {
      return false;
    }
  };

  const inspect = async (): Promise<HubInitInspection> => {
    const fleetEvidence = existingFleetEvidence(deps.home, deps.probe);
    const receipt = readReceipt();
    // An unfinished receipt means incomplete, even when its manifest is already written (enabled comes after it).
    const complete = receipt ? receipt.done.includes("enabled") : existsSync(paths.manifest) || hubConfigured();
    const keysPresent = existsSync(paths.keys) || (await deps.identity.read(deps.home).catch(() => undefined)) !== undefined;
    const incomplete =
      receipt && !complete ? { startedAt: receipt.startedAt, stage: receipt.done[receipt.done.length - 1] ?? "started", plan: receipt.plan } : undefined;
    return {
      existingFleet: fleetEvidence.length > 0,
      existingHub: complete || (!receipt && keysPresent),
      fleetEvidence,
      ...(incomplete ? { incomplete } : {}),
    };
  };

  /** All problems with the plan; reads the certificate files. */
  const problemsOf = async (
    plan: HubInitPlan,
    inspection: HubInitInspection,
  ): Promise<{ problems: string[]; digestExtra?: Record<string, string>; pems?: { cert: string; key: string } }> => {
    const problems: string[] = [];
    if (!deps.identity.available) {
      problems.push("Hub key generation is not available in this build yet: it ships with the Hub transport. Nothing was changed.");
    }
    if (inspection.existingHub) problems.push(`a Hub is already initialized under ${deps.home}; initialization never replaces a Hub identity`);
    if (typeof plan.name !== "string" || !NAME.test(plan.name.trim()) || plan.name !== plan.name.trim()) problems.push("name: 1–64 characters, no control characters, no leading or trailing spaces");
    problems.push(...originProblems("web address", plan.webOrigin), ...originProblems("member address", plan.memberOrigin));
    problems.push(...listenProblems("member listener", plan.memberListen), ...listenProblems("web listener", plan.webListen));
    if (plan.memberListen && plan.webListen && plan.memberListen.host === plan.webListen.host && plan.memberListen.port === plan.webListen.port) {
      problems.push("the member listener and the web listener must use different addresses");
    }
    if (plan.webOrigin === plan.memberOrigin) problems.push("the web address and the member address must differ (browsers and members use separate origins)");
    try {
      resolveDirectoryConfig(plan.directory);
    } catch (err) {
      problems.push(err instanceof HubDirectoryConfigError ? err.message : "directory: invalid settings");
    }
    if (plan.bindPasswordRef !== BIND_PASSWORD_REF) problems.push(`bindPasswordRef must be ${BIND_PASSWORD_REF}`);
    const admin = plan.administrator;
    if (!admin || admin.realm !== plan.directory?.realm || !isCanonicalObjectId(admin.objectId ?? "")) {
      problems.push("administrator: must be the designated directory identity (same realm, immutable object id)");
    }
    for (const [key, value] of Object.entries(plan.retention ?? {})) {
      if (!Number.isInteger(value) || value < 1 || value > 3650) problems.push(`retention.${key}: a whole number of days from 1 to 3650`);
    }
    if (!plan.retention || !("contentDays" in plan.retention) || !("eventDays" in plan.retention)) problems.push("retention: both contentDays and eventDays are required (there is no default)");
    if (plan.coexistence === "dedicated" && inspection.existingFleet) {
      problems.push(`this account already runs a fleet (${inspection.fleetEvidence.join(", ")}): use a dedicated account, or confirm the same-account pilot`);
    } else if (plan.coexistence === "same-user-pilot" && !inspection.existingFleet) {
      problems.push('coexistence "same-user-pilot" is only for an account that already runs a fleet');
    } else if (plan.coexistence !== "dedicated" && plan.coexistence !== "same-user-pilot") {
      problems.push('coexistence must be "dedicated" or "same-user-pilot"');
    }

    let digestExtra: Record<string, string> | undefined;
    let pems: { cert: string; key: string } | undefined;
    const certPem = readPem(plan.webTls?.certFile ?? "", "browser certificate", problems);
    const keyPem = readPem(plan.webTls?.keyFile ?? "", "browser private key", problems);
    if (certPem !== undefined && keyPem !== undefined && originProblems("web address", plan.webOrigin).length === 0) {
      const check = checkBrowserTls(certPem, keyPem, plan.webOrigin, now());
      for (const p of check.problems) problems.push(`browser certificate: ${TLS_TEXT[p]}`);
      if (check.ok) {
        const spki = createPublicKey(createPrivateKey(keyPem)).export({ type: "spki", format: "der" });
        digestExtra = { webCertSha256: sha256(certPem), webKeySpkiSha256: sha256(spki) };
        pems = { cert: certPem, key: keyPem };
      }
    }
    return { problems, ...(digestExtra ? { digestExtra } : {}), ...(pems ? { pems } : {}) };
  };

  const digestOf = (plan: HubInitPlan, extra: Record<string, string>) => sha256(canonical({ plan, ...extra }));

  /** Validation for a commit that may resume this plan's own interrupted operation. */
  const inspectionFor = async (plan: HubInitPlan): Promise<HubInitInspection> => {
    const inspection = await inspect();
    const receipt = readReceipt();
    if (receipt && inspection.incomplete) {
      // The plan's own interrupted operation is not "another Hub"; anything else is.
      const fresh = await problemsOf(plan, { ...inspection, existingHub: false });
      if (fresh.digestExtra && digestOf(plan, fresh.digestExtra) === receipt.planDigest) return { ...inspection, existingHub: false };
      return { ...inspection, existingHub: true };
    }
    return inspection;
  };

  const validate = async (plan: HubInitPlan): Promise<void> => {
    const { problems } = await problemsOf(plan, await inspectionFor(plan));
    if (problems.length > 0) throw new HubInitError(problems[0]!, problems);
  };

  return {
    inspect,
    validate,

    async prepareConfirmation(plan: HubInitPlan, secrets: HubInitSecrets): Promise<HubInitConfirmation> {
      const inspection = await inspectionFor(plan);
      const { problems, digestExtra } = await problemsOf(plan, inspection);
      if (!secrets || typeof secrets.bindPassword !== "string" || secrets.bindPassword.length === 0) problems.push("the directory service account password is missing");
      if (problems.length > 0 || !digestExtra) throw new HubInitError(problems[0] ?? "the plan is not valid", problems);
      const planDigest = digestOf(plan, digestExtra);
      const reference = randomBytes(16).toString("hex");
      pending.set(reference, { planDigest, secrets: { bindPassword: secrets.bindPassword }, expiresAt: now() + CONFIRMATION_TTL_MS });
      const summary = [
        `Hub name: ${plan.name}`,
        `Web address (browsers): ${plan.webOrigin}`,
        `Member address (fleets connect here): ${plan.memberOrigin}`,
        `Listeners: web ${plan.webListen.host}:${plan.webListen.port}, members ${plan.memberListen.host}:${plan.memberListen.port}`,
        `Browser certificate: ${plan.webTls.certFile}`,
        `Directory: ${plan.directory.url} (realm ${plan.directory.realm}, ${plan.directory.profile})`,
        `Hub administrator: ${plan.administrator.realm}/${plan.administrator.objectId}`,
        `Retention: question/answer content ${plan.retention.contentDays} days, event records ${plan.retention.eventDays} days`,
        `Placement: ${plan.coexistence === "dedicated" ? "dedicated account" : "same account as an existing fleet (pilot only)"}`,
      ].join("\n");
      return { reference, planDigest, summary };
    },

    async commit(plan: HubInitPlan, localOwnerConfirmation: string): Promise<HubInitResult> {
      const held = pending.get(localOwnerConfirmation);
      pending.delete(localOwnerConfirmation); // single use, whatever happens next
      if (!held) throw new HubInitError("this confirmation is unknown or was already used; confirm the plan again");
      if (held.expiresAt <= now()) throw new HubInitError("this confirmation expired; confirm the plan again");

      const inspection = await inspectionFor(plan);
      const { problems, digestExtra, pems } = await problemsOf(plan, inspection);
      if (problems.length > 0 || !digestExtra || !pems) throw new HubInitError(problems[0] ?? "the plan is not valid", problems);
      const planDigest = digestOf(plan, digestExtra);
      if (planDigest !== held.planDigest) throw new HubInitError("the plan or its certificate files changed after confirmation; confirm again");

      ensurePrivateDir(paths.hub, uid);
      let receipt = readReceipt();
      if (receipt && receipt.planDigest !== planDigest) throw new HubInitError("another initialization is in progress with different answers");
      if (!receipt) {
        receipt = { version: 1, operationId: randomBytes(8).toString("hex"), planDigest, startedAt: new Date(now()).toISOString(), plan, done: ["started"] };
        writeReceipt(receipt);
        deps.afterStage?.("started");
      }
      const r = receipt;
      const mark = (stage: HubInitStage) => {
        if (!r.done.includes(stage)) r.done.push(stage);
        writeReceipt(r);
        deps.afterStage?.(stage);
      };

      // identity: S1 creates the keys; a resumed operation must find exactly the identity it created.
      let identity: HubIdentitySummary;
      if (r.done.includes("identity")) {
        const found = await deps.identity.read(deps.home);
        if (!found || !r.identity || found.hubId !== r.identity.hubId || found.spkiSha256 !== r.identity.spkiSha256) {
          throw new HubInitError("the Hub identity on disk is not the one this initialization created; nothing more was changed");
        }
        identity = found;
      } else {
        if (await deps.identity.read(deps.home)) throw new HubInitError("a Hub identity already exists that this initialization did not create; nothing was replaced");
        identity = await deps.identity.provision({ home: deps.home, memberOrigin: plan.memberOrigin });
        r.identity = identity;
        mark("identity");
      }

      if (!r.done.includes("web-tls")) {
        // The exact PEM text that was checked and bound to the confirmation (certificate hash and key SPKI): no re-read.
        writePrivate(paths.webCert, pems.cert, uid);
        writePrivate(paths.webKey, pems.key, uid);
        mark("web-tls");
      }

      // On resume the password typed now wins: an earlier run's file is rewritten when it differs.
      const storedSecret = r.done.includes("secret") && existsSync(paths.bindSecret) ? readFileSync(paths.bindSecret, "utf8") : undefined;
      if (storedSecret !== held.secrets.bindPassword) {
        writePrivate(paths.bindSecret, held.secrets.bindPassword, uid);
        mark("secret");
      }

      if (!r.done.includes("config")) {
        if (!existsSync(paths.fleetYaml)) atomicWriteFileSync(paths.fleetYaml, "hub:\n  enabled: false\n", { mode: 0o600 });
        // An existing fleet's file without hub: create the block (off) first; the patcher writes leaves under it.
        const current = yaml.load(readFileSync(paths.fleetYaml, "utf8")) as Record<string, unknown> | null;
        if (!current || typeof current !== "object" || !("hub" in current)) applyFleetYamlPatches(paths.fleetYaml, [{ path: ["hub"], value: { enabled: false } }]);
        applyFleetYamlPatches(paths.fleetYaml, hubConfigPatches(plan, identity));
        mark("config");
      }

      if (!r.done.includes("manifest")) {
        // Sealed by S1 with the issuer key over the normalized settings now in fleet.yaml; the mount re-checks both.
        const sealedDigest = hubPlanDigest({ ...hubSettingsFor(plan, identity) });
        const committedAt = new Date(now()).toISOString();
        const confirmationId = sha256(localOwnerConfirmation).slice(0, 32);
        const signature = await deps.identity.seal({ home: deps.home, planDigest: sealedDigest, confirmationId, committedAt });
        const manifest = { v: 1, hubId: identity.hubId, planDigest: sealedDigest, committedAt, confirmationId, signature };
        writePrivate(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, uid);
        mark("manifest");
      }

      if (!r.done.includes("enabled")) {
        // An unsigned, informational record alongside the sealed runtime manifest; enabled is still the last patch.
        // Also creates the record when resuming a pre-inventory operation that already completed the manifest stage.
        writePrivate(paths.inventory, `${JSON.stringify(hubInstallationInventory(plan, identity, new Date(now()).toISOString()), null, 2)}\n`, uid);
        applyFleetYamlPatches(paths.fleetYaml, [ENABLE_PATCH]);
        mark("enabled");
      }
      held.secrets.bindPassword = "";
      return { hubId: identity.hubId, spkiSha256: identity.spkiSha256, issuerKeyId: identity.issuerKeyId, configPath: paths.fleetYaml };
    },
  };
}

/** The hub.* settings exactly as hubConfigPatches writes them (for the sealed digest). */
export function hubSettingsFor(plan: HubInitPlan, identity: HubIdentitySummary): Record<string, unknown> {
  return {
    name: plan.name,
    hubId: identity.hubId,
    webOrigin: plan.webOrigin,
    memberOrigin: plan.memberOrigin,
    memberListen: plan.memberListen,
    webListen: plan.webListen,
    webTls: WEB_TLS_CONFIG,
    directory: { ...plan.directory, bindPasswordRef: plan.bindPasswordRef },
    administrator: plan.administrator,
    retention: plan.retention,
    coexistence: plan.coexistence,
  };
}

export { UNAVAILABLE_IDENTITY } from "./identity.js";
