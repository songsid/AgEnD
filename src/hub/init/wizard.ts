/**
 * `agend hub init` (S-48 / S5a; #3095 "Installing a Hub" addendum, hub.md §5). Steps:
 *   same-account check → name and addresses → browser HTTPS certificate → directory (LDAPS) and first-admin lookup
 *   → local confirmation of that immutable identity → retention → confirm → commit (enabled last)
 *   → optional service install (explicit) → member pairing instructions.
 * No Hub is installed before final confirmation. Explicit certificate generation uses private temporary staging.
 */
import { hubHandoffLines } from "./handoff.js";
import { readHubInstallationInventory } from "./inventory.js";
import { isIP } from "node:net";
import { HUB_RETENTION_DEFAULTS } from "../../hub-retention-policy.js";
import type { createHubDirectory as CreateHubDirectory, DirectoryPerson, HubDirectoryConfig, HubDirectoryDiagnostic } from "../directory/index.js";
import { HubDirectoryConfigError, resolveDirectoryConfig } from "../directory/index.js";
import { checkBrowserTls, pemCertificates } from "./browser-tls.js";
import { listenProblems, originProblems } from "./initializer.js";
import { BIND_PASSWORD_REF } from "./layout.js";
import { WizardCancelled, type WizardIO } from "./prompt.js";
import { ht } from "./text.js";
import { HubInitError, type HubCoexistence, type HubInitializer, type HubInitPlan, type HubListen } from "./types.js";
import { directoryCaInfo, sameDirectoryFingerprint, type DirectoryCertificateProbe, type DirectoryCaBundle } from "./directory-certificate.js";
import type { HubBrowserMaterial } from "./browser-certificate.js";
import { checkHubInitNetworkForHome, type HubInitListeners, type HubNetworkCheck } from "./network.js";

export interface HubServiceControl {
  installed(): boolean;
  /** Install and start the existing AgEnD service wrapper; returns a short description. Throws on failure. */
  install(): Promise<string>;
}

export interface HubWizardDeps {
  io: WizardIO;
  home: string;
  initializer: HubInitializer;
  createDirectory: typeof CreateHubDirectory;
  readFile(path: string): string;
  readSecretFile?(path: string): string;
  service: HubServiceControl;
  now?: () => number;
  /** Default: real local TCP preflight. Isolated tests may supply an inert checker. */
  checkNetwork?: HubNetworkCheck;
  createBrowserCertificate?(origin: string): Promise<HubBrowserMaterial>;
  recoverBrowserCertificate?(plan: HubInitPlan): HubBrowserMaterial | null;
  directoryCertificates?: {
    inspect(url: string): Promise<DirectoryCertificateProbe>;
    fetch(probe: DirectoryCertificateProbe, pin: string, credentials?: { bindDn: string; password: string }): Promise<DirectoryCaBundle>;
  };
}

export type HubWizardOutcome = "initialized" | "cancelled" | "refused";

const MAX_LOOKUP_ATTEMPTS = 5;

const yes = (answer: string) => /^(y|yes|是)$/i.test(answer.trim());

function isLoopback(origin: string): boolean {
  const host = new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
}

function parseListen(text: string): HubListen | undefined {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(text) ?? /^([^:\s]+):(\d{1,5})$/.exec(text);
  return m ? { host: m[1]!, port: Number(m[2]) } : undefined;
}

function defaultListen(origin: string): string {
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port || "443";
  if (!isIP(host)) return "";
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

export async function runHubInitWizard(deps: HubWizardDeps): Promise<HubWizardOutcome> {
  const { io } = deps;
  const generated: HubBrowserMaterial[] = [];
  try {
    return await wizard({ ...deps, ...(deps.createBrowserCertificate ? { createBrowserCertificate: async (origin: string) => {
      const material = await deps.createBrowserCertificate!(origin); generated.push(material); return material;
    } } : {}), ...(deps.recoverBrowserCertificate ? { recoverBrowserCertificate: (plan: HubInitPlan) => {
      const material = deps.recoverBrowserCertificate!(plan); if (material) generated.push(material); return material;
    } } : {}) });
  } catch (err) {
    if (err instanceof WizardCancelled) {
      io.say();
      io.say(ht("cancelled"));
      return "cancelled";
    }
    throw err;
  } finally {
    if (generated.length) {
      let pending: string | undefined, uncertain = false;
      try { pending = (await deps.initializer.inspect()).incomplete?.plan.webTls.certFile; } catch { uncertain = true; }
      for (const material of generated) {
        // Interrupted initialization must retain its exact material for the existing same-plan resume.
        if (uncertain || pending === material.certFile) io.say(ht("tls_stage_kept", material.certFile));
        else try { material.cleanup(); } catch { io.say(ht("tls_stage_kept", material.certFile)); }
      }
    }
  }
}

async function wizard(deps: HubWizardDeps): Promise<HubWizardOutcome> {
  const { io, initializer } = deps;
  io.say();
  io.say(ht("title"));
  io.say(ht("intro"));
  io.say();

  const inspection = await initializer.inspect();
  if (inspection.existingHub) {
    io.say(ht("hub_exists", deps.home));
    return "refused";
  }
  if (inspection.incomplete) {
    io.say(ht("incomplete", inspection.incomplete.startedAt, inspection.incomplete.stage));
    if (!yes(await io.ask(ht("resume_q")))) {
      io.say(ht("restart_how", `${deps.home}/hub`));
      return "cancelled";
    }
    try { deps.recoverBrowserCertificate?.(inspection.incomplete.plan); }
    catch { io.say(ht("tls_stage_kept", inspection.incomplete.plan.webTls.certFile)); }
    if (!await checkNetwork(deps, inspection.incomplete.plan)) return "refused";
    const bindPassword = await askBindSecret(deps);
    if (bindPassword === undefined) return "cancelled";
    return confirmAndCommit(deps, inspection.incomplete.plan, bindPassword);
  }

  let coexistence: HubCoexistence = "dedicated";
  if (inspection.existingFleet) {
    io.say(ht("fleet_warn_title"));
    for (const e of inspection.fleetEvidence) io.say(`  • ${e}`);
    io.say(ht("fleet_warn_body"));
    if ((await io.ask(ht("fleet_confirm"))).trim() !== ht("fleet_confirm_word")) {
      io.say(ht("cancelled"));
      return "cancelled";
    }
    coexistence = "same-user-pilot";
  }

  // 1. Name and addresses.
  let name = "";
  while (!name) name = (await io.ask(ht("name_q"))).trim().slice(0, 64);
  const webOrigin = await askOrigin(deps, ht("web_origin_q"), undefined, coexistence);
  if (!webOrigin) return "cancelled";
  const suggestedMember = `https://${new URL(webOrigin).host.replace(/:\d+$/, "")}:9443`;
  const memberOrigin = await askOrigin(deps, ht("member_origin_q", suggestedMember), suggestedMember, coexistence, webOrigin);
  if (!memberOrigin) return "cancelled";
  let webListen: HubListen, memberListen: HubListen;
  for (;;) {
    webListen = await askListen(io, "web_listen_q", defaultListen(webOrigin));
    memberListen = await askListen(io, "member_listen_q", defaultListen(memberOrigin), webListen);
    if (await checkNetwork(deps, { webListen, memberListen })) break;
    if ((await io.ask(ht("retry_q"))).trim().toLowerCase() === "q") return "cancelled";
  }

  // 2. Browser HTTPS certificate (separate from the member certificate S1 generates).
  io.say();
  io.say(ht("tls_title"));
  io.say(ht("tls_intro", webOrigin));
  const webTls = await askBrowserTls(deps, webOrigin);
  if (!webTls) return "cancelled";

  // 3. Service-account lookup only; the designated person signs in later in their own browser.
  const selected = await askDirectoryAndAdministrator(deps);
  if (!selected) return "cancelled";
  const { directory, bindPassword, person } = selected;

  // 4. The local host owner approves the exact directory identity, not a mutable login label.
  const label = person.displayName ?? person.login;
  if (!yes(await io.ask(ht("admin_q", label, `${person.key.realm}/${person.key.objectId}`)))) {
    io.say(ht("cancelled"));
    return "cancelled";
  }

  // 5. Suggested retention is still included in the exact plan the owner confirms.
  io.say();
  io.say(ht("retention_title"));
  const contentDays = await askDays(io, "retention_content_q");
  const eventDays = await askDays(io, "retention_event_q");

  const plan: HubInitPlan = {
    name,
    webOrigin,
    memberOrigin,
    directory,
    bindPasswordRef: BIND_PASSWORD_REF,
    administrator: { realm: person.key.realm, objectId: person.key.objectId },
    retention: { contentDays, eventDays },
    coexistence,
    memberListen,
    webListen,
    webTls,
  };
  return confirmAndCommit(deps, plan, bindPassword);
}

async function askOrigin(deps: HubWizardDeps, question: string, fallback: string | undefined, coexistence: HubCoexistence, differentFrom?: string): Promise<string | undefined> {
  const { io } = deps;
  for (;;) {
    const raw = (await io.ask(question)).trim();
    const text = (raw || fallback || "").replace(/\/$/, "");
    if (!text) continue;
    const problems = originProblems("address", text);
    if (problems.length > 0) {
      io.say(problems.join("\n"));
      continue;
    }
    if (differentFrom && text === differentFrom) {
      io.say("the member address must differ from the web address");
      continue;
    }
    if (coexistence === "dedicated" && isLoopback(text) && !yes(await io.ask(ht("loopback_warn", text)))) continue;
    return text;
  }
}

async function askListen(io: WizardIO, key: "web_listen_q" | "member_listen_q", fallback: string, differentFrom?: HubListen): Promise<HubListen> {
  for (;;) {
    const raw = (await io.ask(ht(key, fallback))).trim() || fallback;
    const listen = parseListen(raw);
    const problems = listen ? listenProblems("listener", listen) : [ht("listen_need")];
    if (listen && differentFrom && listen.host === differentFrom.host && listen.port === differentFrom.port) problems.push("the two listeners must differ");
    if (listen && problems.length === 0) return listen;
    io.say(problems.join("\n"));
    if (!listen) continue;
    io.say(ht("listen_need"));
  }
}

async function askBrowserTls(deps: HubWizardDeps, webOrigin: string): Promise<HubInitPlan["webTls"] | undefined> {
  const { io } = deps;
  for (;;) {
    let certFile = (await io.ask(ht("tls_cert_q"))).trim();
    if (!certFile) {
      io.say(ht("tls_needed", webOrigin, new URL(webOrigin).hostname));
      return undefined;
    }
    let keyFile: string, generated = false;
    if (certFile.toLowerCase() === "generate") {
      if (!deps.createBrowserCertificate) { io.say(ht("tls_generate_unavailable")); continue; }
      try {
        const material = await deps.createBrowserCertificate(webOrigin);
        certFile = material.certFile; keyFile = material.keyFile; generated = true;
      } catch { io.say(ht("tls_generate_failed")); return undefined; }
    } else keyFile = (await io.ask(ht("tls_key_q"))).trim();
    let certPem = "";
    let keyPem = "";
    try {
      certPem = deps.readFile(certFile);
      keyPem = deps.readFile(keyFile);
    } catch (err) {
      io.say(`${ht("tls_problem")} ${(err as Error).message}`);
      if ((await io.ask(ht("retry_q"))).trim().toLowerCase() === "q") return undefined;
      continue;
    }
    const check = checkBrowserTls(certPem, keyPem, webOrigin, (deps.now ?? Date.now)());
    if (!check.ok) {
      io.say(ht("tls_problem"));
      for (const p of check.problems) io.say(`  • ${p}`);
      if ((await io.ask(ht("retry_q"))).trim().toLowerCase() === "q") return undefined;
      continue;
    }
    io.say(ht("tls_fingerprint", check.fingerprint256 ?? ""));
    io.say(ht("tls_ok", new URL(webOrigin).hostname, check.validTo ?? ""));
    if (check.selfSigned) {
      if (!yes(await io.ask(ht("tls_self_signed")))) continue;
    }
    return { certFile, keyFile, ...(generated ? { generated: true as const } : {}) };
  }
}

async function askDirectoryAndAdministrator(
  deps: HubWizardDeps,
): Promise<{ directory: HubDirectoryConfig; bindPassword: string; person: DirectoryPerson } | undefined> {
  const { io } = deps;
  let attempts = 0;
  for (;;) {
    io.say();
    io.say(ht("dir_title"));
    const settings = await askDirectorySettings(deps);
    if (!settings) return undefined;
    io.say();
    io.say(ht("signin_title"));
    for (;;) {
      attempts += 1;
      const login = (await io.ask(ht("signin_login_q"))).trim();
      let diagnostic: HubDirectoryDiagnostic | undefined;
      const directory = deps.createDirectory(settings.directory, { bindPassword: settings.bindPassword }, { onDiagnostic: (d) => (diagnostic = d) });
      let result;
      try {
        result = await directory.lookupForInitialization?.(login) ?? { ok: false as const, reason: "unavailable" as const };
      } finally {
        await directory.close();
      }
      if (result.ok) {
        io.say(ht("signin_ok", result.person.displayName ?? result.person.login, result.person.login));
        return { directory: settings.directory, bindPassword: settings.bindPassword, person: result.person };
      }
      if (result.reason === "not-found") io.say(ht("signin_invalid"));
      else if (result.reason === "not-eligible") io.say(ht("signin_not_eligible"));
      else if (result.reason === "bad-input") io.say(ht("signin_bad_input"));
      else io.say(ht("signin_unavailable", diagnostic?.error ?? "no answer"));
      if (attempts >= MAX_LOOKUP_ATTEMPTS) {
        io.say(ht("signin_too_many"));
        return undefined;
      }
      const next = (await io.ask(ht("signin_retry_q"))).trim().toLowerCase();
      if (next === "e") break;
      if (next !== "r") return undefined;
    }
  }
}

async function confirmDirectoryCa(io: WizardIO, pem: string): Promise<boolean> {
  const bundle = directoryCaInfo(pem);
  io.say(ht("dir_ca_compare"));
  for (const c of bundle.certificates) io.say(ht("dir_ca_details", c.subject, c.fingerprint256, c.validTo));
  return yes(await io.ask(ht("dir_ca_confirm_q")));
}

async function askBindSecret(deps: HubWizardDeps): Promise<string | undefined> {
  const { io } = deps;
  for (;;) {
    if (!deps.readSecretFile) return io.askHidden(ht("dir_bind_pw_q"));
    const choice = (await io.ask(ht("dir_bind_source_q"))).trim();
    if (!choice || choice === "1") return io.askHidden(ht("dir_bind_pw_q"));
    if (choice !== "2") { io.say(ht("dir_bind_source_invalid")); continue; }
    const path = (await io.ask(ht("dir_bind_file_q"))).trim();
    try { return deps.readSecretFile(path); }
    catch (err) {
      if (err instanceof WizardCancelled) throw err;
      io.say(ht("dir_bind_file_invalid"));
      if ((await io.ask(ht("retry_q"))).trim().toLowerCase() === "q") return undefined;
    }
  }
}

async function askDirectorySettings(deps: HubWizardDeps): Promise<{ directory: HubDirectoryConfig; bindPassword: string } | undefined> {
  const { io } = deps;
  for (;;) {
    const realm = (await io.ask(ht("dir_realm_q"))).trim();
    const url = (await io.ask(ht("dir_url_q"))).trim();
    const caFile = (await io.ask(ht("dir_ca_q"))).trim();
    let caPem: string | undefined, pending: { probe: DirectoryCertificateProbe; pin: string } | undefined;
    if (caFile.toLowerCase() === "fetch") {
      try {
        if (!deps.directoryCertificates) throw Error("directory_ca_unsupported");
        const probe = await deps.directoryCertificates.inspect(url);
        io.say(ht("dir_leaf_unverified"));
        io.say(ht("dir_ca_details", probe.certificate.subject, probe.certificate.fingerprint256, probe.certificate.validTo));
        const pin = await io.ask(ht("dir_leaf_confirm_q"));
        if (!sameDirectoryFingerprint(probe.certificate.fingerprint256, pin)) { io.say(ht("dir_leaf_refused")); return undefined; }
        try {
          const bundle = await deps.directoryCertificates.fetch(probe, pin);
          if (!await confirmDirectoryCa(io, bundle.pem)) return undefined;
          caPem = bundle.pem;
        } catch (err) {
          if (err instanceof Error && err.message === "directory_ca_auth_required") pending = { probe, pin };
          else throw err;
        }
      } catch (err) {
        if (err instanceof WizardCancelled) throw err;
        io.say(ht("dir_ca_fetch_failed"));
        if ((await io.ask(ht("retry_q"))).trim().toLowerCase() === "q") return undefined;
        continue;
      }
    } else if (caFile) {
      try {
        caPem = deps.readFile(caFile);
        if (!await confirmDirectoryCa(io, caPem)) return undefined;
      } catch (err) {
        if (err instanceof WizardCancelled) throw err;
        io.say(ht("dir_ca_unreadable"));
        if ((await io.ask(ht("retry_q"))).trim().toLowerCase() === "q") return undefined;
        continue;
      }
    }
    const profile = (await io.ask(ht("dir_profile_q"))).trim() === "2" ? "openldap" : "ad";
    const baseDn = (await io.ask(ht("dir_base_q"))).trim();
    const bindDn = (await io.ask(ht("dir_bind_q"))).trim();
    let directory: HubDirectoryConfig = { realm, url, ...(caPem ? { caPem } : {}), baseDn, bindDn, profile };
    try { resolveDirectoryConfig(directory); }
    catch (err) {
      io.say(ht("dir_invalid", err instanceof HubDirectoryConfigError ? err.message : String(err)));
      if ((await io.ask(ht("retry_q"))).trim().toLowerCase() === "q") return undefined;
      continue;
    }
    if (pending) io.say(ht("dir_ca_bind_needed"));
    const bindPassword = await askBindSecret(deps);
    if (bindPassword === undefined) return undefined;
    if (!bindPassword) { io.say(ht("dir_bind_empty")); continue; }
    if (pending) {
      try {
        const bundle = await deps.directoryCertificates!.fetch(pending.probe, pending.pin, { bindDn, password: bindPassword });
        if (!await confirmDirectoryCa(io, bundle.pem)) return undefined;
        directory = { ...directory, caPem: bundle.pem };
        resolveDirectoryConfig(directory);
      } catch (err) {
        if (err instanceof WizardCancelled) throw err;
        io.say(ht("dir_ca_fetch_failed"));
        if ((await io.ask(ht("retry_q"))).trim().toLowerCase() === "q") return undefined;
        continue;
      }
    }
    return { directory, bindPassword };
  }
}

async function askDays(io: WizardIO, key: "retention_content_q" | "retention_event_q"): Promise<number> {
  for (;;) {
    const suggested = key === "retention_content_q" ? HUB_RETENTION_DEFAULTS.contentDays : HUB_RETENTION_DEFAULTS.eventDays;
    const text = (await io.ask(ht(key, suggested))).trim();
    if (!text) return suggested;
    if (/^\d{1,4}$/.test(text) && Number(text) >= 1 && Number(text) <= 3650) return Number(text);
    io.say(ht("retention_need"));
  }
}

async function confirmAndCommit(deps: HubWizardDeps, plan: HubInitPlan, bindPassword: string): Promise<HubWizardOutcome> {
  const { io, initializer } = deps;
  let confirmation;
  try {
    confirmation = await initializer.prepareConfirmation(plan, { bindPassword });
  } catch (err) {
    return refused(io, err);
  }
  io.say();
  io.say(ht("summary_title"));
  for (const line of confirmation.summary.split("\n")) io.say(`  ${line}`);
  if (plan.coexistence === "same-user-pilot") io.say(`  ${ht("pilot_reminder")}`);
  if ((await io.ask(ht("confirm_q"))).trim() !== ht("confirm_word")) {
    io.say(ht("cancelled"));
    return "cancelled";
  }
  if (!await checkNetwork(deps, plan)) return "refused";
  let result;
  try {
    result = await initializer.commit(plan, confirmation.reference);
  } catch (err) {
    return refused(io, err);
  }
  io.say();
  io.say(ht("done", result.hubId));
  io.say(ht("admin_browser_next", plan.webOrigin));

  // Service: never implied by the setup itself; an exact word installs it.
  io.say();
  if (deps.service.installed()) {
    io.say(ht("service_installed"));
  } else if ((await io.ask(ht("service_q"))).trim() === ht("service_word")) {
    try {
      await deps.service.install();
      io.say(ht("service_ok"));
    } catch (err) {
      io.say(ht("service_failed", (err as Error).message));
    }
  } else {
    io.say(ht("service_skipped"));
  }

  io.say();
  try { for (const line of hubHandoffLines(deps.home, readHubInstallationInventory(deps.home))) io.say(line); }
  catch {
    // A completed initialization remains committed if an informational record cannot be read/displayed.
    io.say(ht("handoff_unavailable"));
    io.say(ht("pairing_title"));
    io.say(ht("pairing_steps", plan.webOrigin, plan.memberOrigin, result.spkiSha256));
  }
  return "initialized";
}

async function checkNetwork(deps: HubWizardDeps, listeners: HubInitListeners): Promise<boolean> {
  const { io } = deps;
  io.say(ht("network_check"));
  try {
    const problems = await (deps.checkNetwork ? deps.checkNetwork(listeners) : checkHubInitNetworkForHome(deps.home, listeners));
    for (const p of problems) io.say(ht(`network_${p.reason}`, ht(`network_${p.listener}`)));
    if (!problems.length) { io.say(ht("network_ok")); return true; }
  } catch { io.say(ht("network_unavailable", ht("network_both"))); }
  io.say(ht("network_unchanged"));
  return false;
}

function refused(io: WizardIO, err: unknown): HubWizardOutcome {
  io.say(ht("failed"));
  const problems = err instanceof HubInitError ? err.problems : [(err as Error).message];
  for (const p of problems) io.say(`  • ${p}`);
  io.say(ht("stays_off"));
  return "refused";
}
