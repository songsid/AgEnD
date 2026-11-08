/** Host-owned first setup. No browser-supplied paths, PersonKey, secret reference or terminal confirmation. */
import { randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { RawConfigPatch } from "../../settings-api.js";
import { canonicalArguments, personKeyString } from "../identity.js";
import { person, validated } from "../validation.js";
import { createHubDirectory, type HubDirectory, type HubDirectoryConfig, resolveDirectoryConfig } from "../directory/index.js";
import { createHubInitializer, originProblems } from "./initializer.js";
import { hubIdentityProvider } from "./identity.js";
import { realFleetProbe } from "./existing-fleet.js";
import { createBrowserCertificate, recoverBrowserCertificate, importBrowserCertificate, type HubBrowserMaterial } from "./browser-certificate.js";
import { checkHubInitNetworkForHome } from "./network.js";
import { directoryCaInfo, inspectDirectoryCertificate, fetchDirectoryCa, sameDirectoryFingerprint, type DirectoryCertificateProbe } from "./directory-certificate.js";
import { appendHubWebInitEvent, type HubWebInitEvent } from "./web-audit.js";
import { HubWebInitError, type HubWebInitCode } from "./web-error.js";
import { BIND_PASSWORD_REF } from "./layout.js";
import type { HubInitPlan, HubInitHostOwner, HubIdentityProvider } from "./types.js";
const text = (max: number) => z.string().min(1).max(max);
const listener = z.strictObject({ host: text(253), port: z.int().min(1).max(65535) });
const directorySchema = z.strictObject({ realm: text(64), url: text(2048), baseDn: text(1024), bindDn: text(1024), profile: z.enum(["ad", "openldap"]),
  caPem: z.string().max(65536).optional(), loginAttribute: text(64).optional(), userFilter: text(4096).optional(), timeoutMs: z.int().min(500).max(30000).optional() });
export const webHubInitInput = z.strictObject({ name: text(64).optional(), browserTls: z.strictObject({ certPem: text(65536), keyPem: text(16384) }).optional(), webOrigin: text(2048), memberOrigin: text(2048), webListen: listener, memberListen: listener,
  directory: directorySchema, bindPassword: text(4096), administratorLogin: text(256), confirmedCa: z.array(text(95)).max(4).optional(),
  retention: z.strictObject({ contentDays: z.int().min(1).max(3650), eventDays: z.int().min(1).max(3650) }), coexistence: z.enum(["dedicated", "same-user-pilot"]) });
type Input = z.infer<typeof webHubInitInput>;
function fail(code: HubWebInitCode): never { throw new HubWebInitError(code); }
const TTL = 5 * 60000, MAX_DRAFTS = 8, MAX_ACTIVE = 2;
type Owner = HubInitHostOwner;
interface Job {
  owner: Owner;
  image: unknown;
  createdAt: number;
  expiresAt: number;
  ref: string;
  cancelled: boolean;
  busy: boolean;
  preserveMaterial?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  input?: Input;
  plan?: HubInitPlan;
  confirmation?: string;
  material?: HubBrowserMaterial;
  probe?: DirectoryCertificateProbe;
}
export interface HubWebInitDeps {
  home: string;
  readConfig(): unknown;
  writeFleet(patches: RawConfigPatch[]): void;
  now?(): number;
  identity?: HubIdentityProvider;
  probe?: ReturnType<typeof realFleetProbe>;
  createDirectory?(config: HubDirectoryConfig, secrets: {
    bindPassword: string;
  }): HubDirectory;
  browserCertificate?(origin: string): Promise<HubBrowserMaterial>;
  checkNetwork?: typeof checkHubInitNetworkForHome;
  inspectCertificate?: typeof inspectDirectoryCertificate;
  fetchCa?: typeof fetchDirectoryCa;
  audit?(event: Omit<HubWebInitEvent, "v" | "id">): void;
  /** Physical reload after the initializer's enabling decision; never mints a Hub administrator session. */
  committed?(): void | Promise<void>;
}
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);
function applyPatches(raw: unknown, patches: RawConfigPatch[]): unknown {
  const next = structuredClone(raw) as Record<string, any>;
  for (const patch of patches) {
    let at = next;
    for (const part of patch.path.slice(0, -1)) {
      if (!at[part] || typeof at[part] !== "object")
        at[part] = {};
      at = at[part];
    }
    const key = patch.path.at(-1)!;
    if (patch.remove)
      delete at[key];
    else
      at[key] = structuredClone(patch.value);
  }
  return next;
}
export function createHubWebInitializer(deps: HubWebInitDeps) {
  const now = deps.now ?? Date.now, createDirectory = deps.createDirectory ?? createHubDirectory;
  let stopped = false, committing: Job | undefined, active = 0;
  const drafts = new Map<string, Job>(), owned = new Set<Job>(), work = new Set<Promise<unknown>>();
  const ownerCopy = (owner: Owner): Owner => ({ kind: owner.kind, ownerKey: owner.ownerKey, sessionId: owner.sessionId, authorityEpoch: owner.authorityEpoch, requestId: owner.requestId, current: owner.current.bind(owner) });
  const audit = (j: Job, operation: HubWebInitEvent["operation"], result: HubWebInitEvent["result"], reason: string, extra: Partial<HubWebInitEvent> = {}) => {
    const event = { at: now(), requestId: j.owner.requestId, sessionId: j.owner.sessionId, authorityEpoch: j.owner.authorityEpoch, operation, result, reason, ...extra };
    const value: unknown = deps.audit ? deps.audit(event) : appendHubWebInitEvent(deps.home, event);
    if (value && typeof (value as {
      then?: unknown;
    }).then === "function") {
      Promise.resolve(value).catch(() => { });
      fail("unavailable");
    }
  };
  const refusal = (j: Job, operation: HubWebInitEvent["operation"], error: unknown) => {
    try { audit(j, operation, "denied", error instanceof HubWebInitError ? error.code : "unavailable"); }
    catch { /* no allowance follows an audit failure */ }
  };
  const check = (j: Job, owner = j.owner) => {
    if (stopped || j.cancelled || owner.kind !== "host-session" || j.owner.ownerKey !== owner.ownerKey || j.owner.sessionId !== owner.sessionId || j.owner.authorityEpoch !== owner.authorityEpoch)
      fail("denied");
    for (const source of [j.owner, owner]) {
      const value: unknown = source.current();
      if (value && typeof (value as {
        then?: unknown;
      }).then === "function") {
        try {
          (value as PromiseLike<unknown>).then(undefined, () => undefined);
        }
        catch { }
        fail("denied");
      }
      if (value !== true)
        fail("denied");
    }
    if (!same(deps.readConfig(), j.image))
      fail("stale");
    const t = now();
    if (!Number.isSafeInteger(t) || t < j.createdAt || t >= j.expiresAt)
      fail("expired");
  };
  const cleanup = (j: Job) => {
    if (j.confirmation)
      initializer.discardConfirmation?.(j.confirmation);
    if (j.input) {
      j.input.bindPassword = "";
      if (j.input.browserTls)
        j.input.browserTls.keyPem = "";
    }
    // An incomplete initializer receipt owns its certificate staging for the existing CLI resume path.
    if (j.timer)
      clearTimeout(j.timer);
    if (j.material && !j.preserveMaterial)
      j.material.cleanup();
    owned.delete(j);
    drafts.delete(j.ref);
  };
  const initializer = createHubInitializer({ home: deps.home, identity: deps.identity ?? hubIdentityProvider(), probe: deps.probe ?? realFleetProbe(), now,
    writeFleet(patches) {
      const j = committing;
      if (!j)
        fail("denied");
      check(j);
      const next = applyPatches(j.image, patches);
      const written: unknown = deps.writeFleet(patches);
      if (written && typeof (written as {
        then?: unknown;
      }).then === "function") {
        Promise.resolve(written).catch(() => { });
        fail("unavailable");
      }
      if (!same(deps.readConfig(), next))
        fail("stale");
      j.image = next;
    },
    beforeEnable(event) {
      if (!committing) fail("denied");
      check(committing);
      audit(committing, "commit", "held", "authorized", { operationId: event.operationId, hubId: event.hubId,
        confirmationId: event.confirmationId, ...(event.source.kind === "host-session" ? { requestId: event.source.requestId } : {}) });
    }
  });
  const newJob = (owner: Owner) => {
    if (active >= MAX_ACTIVE)
      fail("busy");
    const createdAt = now(), j: Job = { owner: ownerCopy(owner), image: structuredClone(deps.readConfig()), createdAt, expiresAt: createdAt + TTL, ref: randomBytes(24).toString("base64url"), cancelled: false, busy: false };
    check(j);
    for (const [ref, old] of drafts)
      if (old.expiresAt <= createdAt && !old.busy) {
        old.cancelled = true;
        drafts.delete(ref);
        cleanup(old);
      }
    if (owned.size >= MAX_DRAFTS)
      fail("busy");
    owned.add(j);
    j.timer = setTimeout(() => { j.cancelled = true; drafts.delete(j.ref); if (j.confirmation)
      initializer.discardConfirmation?.(j.confirmation); if (!j.busy)
      try {
        cleanup(j);
      }
      catch { /* retain unconfirmed private ownership for close/repair */ } }, TTL);
    j.timer.unref?.();
    return j;
  };
  const get = (ref: string, owner: Owner) => {
    const j = drafts.get(ref);
    if (!j) fail("expired");
    check(j, owner);
    if (j.busy) fail("busy");
    return j;
  };
  const run = <T>(j: Job, fn: () => Promise<T>): Promise<T> => {
    if (active >= MAX_ACTIVE || j.busy)
      return Promise.reject(new HubWebInitError("busy"));
    j.busy = true;
    active++;
    const p = (async () => { try {
      return await fn();
    }
    catch (error) {
      throw error instanceof HubWebInitError ? error : new HubWebInitError("unavailable");
    }
    finally {
      active--;
      j.busy = false;
      if (j.cancelled)
        cleanup(j);
    } })();
    work.add(p);
    void p.finally(() => work.delete(p)).catch(() => { });
    return p;
  };
  const freshAdmin = async (j: Job) => {
    check(j);
    const input = j.input!, directory = createDirectory(input.directory, { bindPassword: input.bindPassword });
    try {
      const found = await directory.lookupForInitialization?.(input.administratorLogin);
      check(j);
      if (!found?.ok)
        fail("directory");
      const key = validated(person, found.person.key);
      if (key.realm !== input.directory.realm || found.person.login.toLowerCase() !== input.administratorLogin.toLowerCase())
        fail("directory");
      const eligible = await directory.checkEligibility(key);
      check(j);
      if (!eligible.eligible || personKeyString(eligible.person.key) !== personKeyString(key) || j.plan && personKeyString(j.plan.administrator) !== personKeyString(key))
        fail("directory");
      return { key, label: found.person.displayName ?? found.person.login };
    }
    finally {
      await directory.close();
    }
  };
  return {
    pending: () => committing !== undefined,
    async inspect(owner: Owner) {
      const j = newJob(owner);
      return run(j, async () => {
        try {
          const view = await initializer.inspect();
          check(j);
          return { v: 1, initialized: view.existingHub, incomplete: !!view.incomplete, existingFleet: view.existingFleet };
        }
        finally {
          j.cancelled = true;
        }
      });
    },
    async prepare(raw: unknown, owner: Owner) {
      const j = newJob(owner);
      return run(j, async () => {
        try {
          let input: Input;
          try {
            input = webHubInitInput.parse(raw);
          }
          catch {
            fail("invalid");
          }
          j.input = input;
          for (const field of ["webOrigin", "memberOrigin"] as const) {
            if (originProblems(field, input[field]).length) fail("invalid");
            input[field] = new URL(input[field]).origin;
          }
          try {
            resolveDirectoryConfig(input.directory);
          }
          catch {
            fail("invalid");
          }
          const view = await initializer.inspect();
          check(j);
          if (view.existingHub)
            fail("initialized");
          if (input.directory.caPem) {
            const ca = directoryCaInfo(input.directory.caPem, now());
            if (!input.confirmedCa || ca.certificates.length !== input.confirmedCa.length || ca.certificates.some(c => !input.confirmedCa!.some(p => sameDirectoryFingerprint(c.fingerprint256, p))))
              fail("trust");
          }
          audit(j, "prepare", "held", "checking");
          const admin = await freshAdmin(j);
          check(j);
          const network = await (deps.checkNetwork ?? checkHubInitNetworkForHome)(deps.home, input);
          check(j);
          if (network.length)
            fail("network");
          if (view.incomplete) {
            j.preserveMaterial = true;
            j.plan = structuredClone(view.incomplete.plan);
            j.material = recoverBrowserCertificate(deps.home, input.webOrigin, j.plan.webTls) ?? undefined;
            if (!j.material)
              fail("incomplete");
          }
          else if (input.browserTls) {
            try {
              j.material = importBrowserCertificate(deps.home, input.webOrigin, input.browserTls, now());
            }
            catch {
              fail("invalid");
            }
          }
          else
            j.material = await (deps.browserCertificate ?? (origin => createBrowserCertificate(deps.home, origin)))(input.webOrigin);
          check(j);
          const material = j.material;
          if (!material)
            fail("incomplete");
          const plan: HubInitPlan = { name: input.name, webOrigin: input.webOrigin, memberOrigin: input.memberOrigin, webListen: input.webListen, memberListen: input.memberListen,
            directory: input.directory, bindPasswordRef: BIND_PASSWORD_REF, administrator: admin.key, retention: input.retention, coexistence: input.coexistence,
            webTls: { certFile: material.certFile, keyFile: material.keyFile, generated: true } };
          const c = await initializer.prepareConfirmation(plan, { bindPassword: input.bindPassword }, { ...j.owner, current: () => { check(j); return true; } });
          check(j);
          j.plan = plan;
          j.confirmation = c.reference;
          drafts.set(j.ref, j);
          audit(j, "prepare", "completed", "ready");
          const cert = new X509Certificate(readFileSync(material.certFile));
          return { v: 1, ref: j.ref, expiresAt: j.expiresAt, administrator: admin.label, webOrigin: plan.webOrigin, memberOrigin: plan.memberOrigin,
            certificate: { fingerprint: cert.fingerprint256, validTo: cert.validTo }, existingFleet: view.existingFleet };
        }
        catch (error) {
          j.cancelled = true;
          try {
            audit(j, "prepare", "denied", error instanceof HubWebInitError ? error.code : "unavailable");
          }
          catch { /* original refusal still narrows */ }
          throw error;
        }
      });
    },
    async test(ref: string, owner: Owner) {
      const j = get(ref, owner);
      if (!j.plan || !j.input || !j.confirmation)
        fail("invalid");
      return run(j, async () => {
        try {
          await freshAdmin(j);
          check(j, owner);
          audit(j, "test", "completed", "verified");
          return { ok: true };
        }
        catch (error) {
          refusal(j, "test", error);
          throw error;
        }
      });
    },
    async commit(ref: string, owner: Owner) {
      const j = get(ref, owner);
      if (!j.plan || !j.input || !j.confirmation)
        fail("invalid");
      if (committing || active >= MAX_ACTIVE)
        fail("busy");
      committing = j;
      drafts.delete(ref);
      return run(j, async () => {
        try {
          check(j, owner);
          await freshAdmin(j);
          check(j, owner);
          const network = await (deps.checkNetwork ?? checkHubInitNetworkForHome)(deps.home, j.plan!);
          check(j, owner);
          if (network.length)
            fail("network");
          const result = await initializer.commit(j.plan!, j.confirmation!, { ...owner, current: () => { check(j, owner); return true; } });
          // Enabling is decided; a disconnect cannot abandon physical reload. Do not reuse an old owner proof for admission.
          await deps.committed?.();
          return { ok: true, hubId: result.hubId, webOrigin: j.plan!.webOrigin, memberFingerprint: result.spkiSha256 };
        }
        catch (error) {
          refusal(j, "commit", error);
          throw error;
        }
        finally {
          if (committing === j)
            committing = undefined;
          try {
            const state = await initializer.inspect();
            j.preserveMaterial = state.incomplete?.plan.webTls.certFile === j.material?.certFile;
          }
          catch {
            j.preserveMaterial = true;
          }
          j.cancelled = true;
        }
      });
    },
    async inspectCa(url: string, owner: Owner) {
      const j = newJob(owner);
      return run(j, async () => {
        try {
          j.probe = await (deps.inspectCertificate ?? inspectDirectoryCertificate)(url);
          check(j);
          drafts.set(j.ref, j);
          audit(j, "ca-inspect", "completed", "inspected");
          return { ref: j.ref, expiresAt: j.expiresAt, server: j.probe.url, certificate: j.probe.certificate };
        }
        catch (error) {
          j.cancelled = true;
          refusal(j, "ca-inspect", error);
          throw error;
        }
      });
    },
    async fetchCa(ref: string, pin: string, owner: Owner, credentials?: {
      bindDn: string;
      password: string;
    }) {
      const j = get(ref, owner);
      if (!j.probe)
        fail("invalid");
      return run(j, async () => {
        try {
          const result = await (deps.fetchCa ?? fetchDirectoryCa)(j.probe!, pin, credentials && { ...credentials });
          check(j, owner);
          audit(j, "ca-fetch", "completed", "verified");
          return { caPem: result.pem, certificates: result.certificates };
        }
        catch (error) {
          refusal(j, "ca-fetch", error);
          throw error;
        }
      });
    },
    cancel(ref: string, owner: Owner) {
      const j = drafts.get(ref);
      if (!j) fail("expired");
      check(j, owner);
      try { audit(j, "cancel", "completed", "cancelled"); }
      finally {
        j.cancelled = true;
        drafts.delete(ref);
        if (!j.busy) cleanup(j);
      }
    },
    async close() {
      stopped = true;
      initializer.close?.();
      for (const j of owned) j.cancelled = true;
      await Promise.allSettled([...work]);
      let failed = false;
      for (const j of [...owned]) {
        try { cleanup(j); } catch { failed = true; }
      }
      if (failed) fail("unavailable");
    },
  };
}
export type HubWebInitializer = ReturnType<typeof createHubWebInitializer>;
