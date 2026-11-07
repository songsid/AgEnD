/**
 * The Hub's directory client (S-43). Every operation opens its own connection, proves it is verified TLS before any
 * bind, and closes it; nothing is cached, so each Hub request sees the directory's current answer (design #3095 §4).
 *
 * Transport rules:
 * - ldaps:// only (decision 7e5b8a8f); the certificate is verified against the configured CA (or Node's roots) and the
 *   host name, always. A plain ldap:// socket is never created: createConnection refuses outright.
 * - One TLS connection per client. ldapts would otherwise reconnect transparently after a drop; every operation is a
 *   fresh session instead, and a bind is sent only on the verified socket this session opened.
 * - The library is imported lazily, so it never loads while the Hub is off.
 *
 * Passwords: the user's password is used for exactly one bind and is never stored, logged or returned. An empty
 * password is refused before the network (to LDAP it would be an unauthenticated bind that "succeeds").
 */
import { isIP } from "node:net";
import { AD_EXTENDED_DN, extendedGroupIds, type PolicyGroupLookup, type PolicyGroupFacts } from "./groups.js";
import * as net from "node:net";
import * as tls from "node:tls";
import type { Client as LdapClient, Control, Entry, Filter } from "ldapts";
import { HubDirectoryConfigError, resolveDirectoryConfig, type ResolvedDirectoryConfig } from "./config.js";
import { PROFILES, escapeFilterValue, isDisabled, objectIdMatch, readObjectId, readText, readTextList } from "./profiles.js";
import type { DirectoryPerson, DirectoryLookupResult, Eligibility, HubDirectory, InitializationLookupResult, PersonKey, SignInResult } from "./types.js";

export interface HubDirectorySecrets {
  /** The service account's password (resolved by the caller from the Hub's secret store). */
  readonly bindPassword: string;
}

export interface HubDirectoryDiagnostic {
  readonly op: "sign-in" | "eligibility" | "initialization-lookup" | "pairing-owner-lookup" | "group-lookup" | "group-membership";
  readonly outcome: string;
  /** The underlying error's message, for the technical log. Never contains a password. */
  readonly error?: string;
}

export interface HubDirectoryOptions {
  /** Called once per refused or failed operation. */
  readonly onDiagnostic?: (event: HubDirectoryDiagnostic) => void;
  /** Test seam for expiry checks. */
  readonly now?: () => number;
}

class InsecureTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureTransportError";
  }
}

/** Compare base RDN boundaries, tolerating formatting after commas without splitting escaped commas. */
function withinGroupBase(dn: string, base: string): boolean {
  const parts = (text: string): string[] => {
    const out: string[] = []; let part = "", escaped = false;
    for (const c of text) {
      if (c === "," && !escaped) { out.push(part.trimStart().toLowerCase()); part = ""; }
      else part += c;
      escaped = c === "\\" && !escaped;
    }
    out.push(part.trimStart().toLowerCase()); return out;
  };
  const child = parts(dn), parent = parts(base);
  return child.length > parent.length && parent.every((rdn, i) => rdn.length > 0 && child[child.length - parent.length + i] === rdn);
}

type Ldapts = typeof import("ldapts");
let ldaptsModule: Promise<Ldapts> | undefined;
function loadLdapts(): Promise<Ldapts> {
  ldaptsModule ??= import("ldapts");
  return ldaptsModule;
}

const LOGIN_MAX = 256;
const PASSWORD_MAX = 1024;
// A login is matched by the directory, not parsed by us; refuse only what can never be a login.
const LOGIN_SHAPE = /^[^\u0000-\u001f\u007f\s](?:[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f\s])?$/;

function validLogin(login: unknown): login is string {
  return typeof login === "string" && login.length > 0 && login.length <= LOGIN_MAX && LOGIN_SHAPE.test(login);
}

function validPassword(password: unknown): password is string {
  return typeof password === "string" && password.length > 0 && password.length <= PASSWORD_MAX && !password.includes("\u0000");
}

/** One verified-TLS LDAP connection that refuses to reconnect. */
class Session {
  private connections = 0;
  private tlsSocket: tls.TLSSocket | undefined;

  private constructor(
    private readonly cfg: ResolvedDirectoryConfig,
    readonly client: LdapClient,
  ) {}

  static async open(cfg: ResolvedDirectoryConfig): Promise<Session> {
    const { Client } = await loadLdapts();
    let session: Session | undefined;
    const tlsOptions = (): tls.ConnectionOptions => ({
      ...(cfg.caPem !== undefined ? { ca: cfg.caPem } : {}),
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      host: cfg.host,
      ...(isIP(cfg.host) ? {} : { servername: cfg.host }),
      checkServerIdentity: tls.checkServerIdentity,
    });
    const client = new Client({
      url: cfg.url,
      timeout: cfg.timeoutMs,
      connectTimeout: cfg.timeoutMs,
      strictDN: true,
      autoRebind: false,
      // Never a plaintext socket, whatever the URL parsing inside the library decides.
      createConnection: (() => {
        throw new InsecureTransportError("hub directory: refusing a plaintext LDAP connection");
      }) as typeof net.connect,
      // Verification settings come from here only; anything the library passes is ignored.
      createSecureConnection: (() => {
        session!.claimConnection();
        const socket = tls.connect({ ...tlsOptions(), port: cfg.port });
        session!.tlsSocket = socket;
        return socket;
      }) as typeof tls.connect,
    });
    session = new Session(cfg, client);
    return session;
  }

  private claimConnection(): void {
    this.connections += 1;
    if (this.connections > 1) throw new InsecureTransportError("hub directory: connection lost; refusing to reconnect within one operation");
  }

  /** Throws unless the live connection is the one verified TLS socket this session made. */
  private assertSecure(): void {
    const s = this.tlsSocket;
    if (!s || s.destroyed || !s.authorized || !s.encrypted || this.connections !== 1 || !this.client.isConnected) {
      throw new InsecureTransportError("hub directory: no verified TLS connection; refusing to send credentials");
    }
  }

  async bind(dn: string, password: string): Promise<void> {
    // ldapts connects lazily inside bind(): a fresh session's first bind opens the socket through
    // createSecureConnection above (verified TLS, or no connection at all), and the bind is written only after
    // 'secureConnect'. A session that already has a socket must still be on that one verified socket.
    if (this.connections > 0) this.assertSecure();
    await this.client.bind(dn, password);
    this.assertSecure();
  }

  async search(filter: string | Filter, attributes: string[], binary: readonly string[], scope: "sub" | "base" = "sub", base = this.cfg.baseDn, controls?: Control[], complete = false): Promise<Entry[]> {
    this.assertSecure();
    const { searchEntries, searchReferences } = await this.client.search(base, {
      scope,
      filter,
      attributes,
      explicitBufferAttributes: [...binary],
      sizeLimit: 2,
      derefAliases: "never",
    }, controls);
    if (complete && searchReferences?.length) throw new Error("incomplete group result");
    return searchEntries;
  }

  async close(): Promise<void> {
    try {
      await this.client.unbind();
    } catch {
      /* already closed */
    }
  }
}

export function createHubDirectory(config: unknown, secrets: HubDirectorySecrets, options: HubDirectoryOptions = {}): HubDirectory {
  const cfg = resolveDirectoryConfig(config);
  if (!secrets || typeof secrets.bindPassword !== "string" || !validPassword(secrets.bindPassword)) {
    throw new HubDirectoryConfigError("hub directory: the service account password is missing");
  }
  const bindPassword = secrets.bindPassword;
  const shape = PROFILES[cfg.profile];
  const now = options.now ?? Date.now;
  const attributes = [shape.idAttribute, cfg.loginAttribute, "displayName", "cn", "mail", shape.departmentAttribute, "memberOf", ...shape.statusAttributes];
  const report = (op: HubDirectoryDiagnostic["op"], outcome: string, error?: unknown) => {
    if (!options.onDiagnostic) return;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : error === undefined ? undefined : String(error);
    try {
      options.onDiagnostic({ op, outcome, ...(message !== undefined ? { error: message } : {}) });
    } catch {
      /* a diagnostic sink never changes the answer */
    }
  };

  const toPerson = (entry: Entry, objectId: string): DirectoryPerson => {
    const displayName = readText(entry, "displayName") ?? readText(entry, "cn");
    const email = readText(entry, "mail");
    const department = readText(entry, shape.departmentAttribute);
    return Object.freeze({
      key: Object.freeze({ realm: cfg.realm, objectId }),
      login: readText(entry, cfg.loginAttribute) ?? "",
      dn: entry.dn,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(department !== undefined ? { department } : {}),
      groups: Object.freeze(readTextList(entry, "memberOf")),
    });
  };

  const openService = async (): Promise<Session> => {
    const session = await Session.open(cfg);
    try {
      await session.bind(cfg.bindDn, bindPassword);
      return session;
    } catch (err) {
      await session.close();
      throw err;
    }
  };

  const findById = async (session: Session, objectId: string): Promise<Entry[]> => {
    const match = objectIdMatch(cfg.profile, objectId);
    if (!match) return [];
    const { AndFilter, EqualityFilter, FilterParser } = await loadLdapts();
    const filter = new AndFilter({ filters: [FilterParser.parseString(cfg.userFilter), new EqualityFilter(match)] });
    return session.search(filter, attributes, shape.binaryAttributes);
  };

  let closed = false;

  type Selection = { ok: true; entry: Entry; objectId: string }
    | { ok: false; reason: "not-found" | "not-eligible" | "unavailable"; detail?: string };
  // Shared with sign-in so local designation never acquires a weaker identity/eligibility rule.
  const selectLogin = async (service: Session, login: string): Promise<Selection> => {
    const found = await service.search(`(&${cfg.userFilter}(${cfg.loginAttribute}=${escapeFilterValue(login)}))`, attributes, shape.binaryAttributes);
    if (closed) return { ok: false, reason: "unavailable" };
    if (found.length === 0) return { ok: false, reason: "not-found" };
    if (found.length !== 1) return { ok: false, reason: "unavailable", detail: "the login matches more than one entry" };
    const entry = found[0]!, objectId = readObjectId(cfg.profile, entry);
    if (!objectId) return { ok: false, reason: "unavailable", detail: `the entry has no usable ${shape.idAttribute}` };
    if (isDisabled(cfg.profile, entry, now())) return { ok: false, reason: "not-eligible" };
    return { ok: true, entry, objectId };
  };
  const recheck = async (service: Session, entry: Entry, objectId: string, expectedLogin?: string): Promise<InitializationLookupResult> => {
    const again = await findById(service, objectId), current = again.length === 1 ? again[0] : undefined;
    if (closed || !current || readObjectId(cfg.profile, current) !== objectId
      || current.dn.toLowerCase() !== entry.dn.toLowerCase()
      || (expectedLogin !== undefined && readText(current, cfg.loginAttribute)?.toLowerCase() !== expectedLogin.toLowerCase())) return { ok: false, reason: "unavailable" };
    if (isDisabled(cfg.profile, current, now())) return { ok: false, reason: "not-eligible" };
    return { ok: true, person: toPerson(current, objectId) };
  };

  const lookup = async (login: string, operation: "initialization-lookup" | "pairing-owner-lookup"): Promise<DirectoryLookupResult> => {
    if (closed) return { ok: false, reason: "unavailable" };
    if (!validLogin(login)) return { ok: false, reason: "bad-input" };
    let service: Session | undefined;
    try {
      service = await openService();
      const selected = await selectLogin(service, login);
      if (!selected.ok) return { ok: false, reason: selected.reason };
      // Re-read by immutable id; a rename, deletion or replacement never retargets the selected identity.
      return await recheck(service, selected.entry, selected.objectId, login);
    } catch (err) {
      // Server-supplied exception text can repeat a login or DN; diagnostics stay bounded.
      const certificate = err instanceof Error && /certificate|self.signed|verify/i.test(err.message);
      report(operation, "unavailable", certificate ? "directory certificate verification failed" : "directory lookup failed");
      return { ok: false, reason: "unavailable" };
    } finally { await service?.close(); }
  };

  const groupSupport = cfg.profile === "ad" && cfg.port === 636;
  const securityGroup = (entry: Entry): boolean => {
    const raw = readText(entry, "groupType");
    const n = raw !== undefined && /^-?\d{1,11}$/.test(raw) ? Number(raw) : NaN;
    return Number.isInteger(n) && n >= -2147483648 && n <= 4294967295 && ((n >>> 0) & 0x80000000) !== 0;
  };
  const groupEntry = (entry: Entry, expectedId?: string) => {
    const id = readObjectId("ad", entry);
    return id && (!expectedId || id === expectedId) && securityGroup(entry) ? id : undefined;
  };

  return {
    realm: cfg.realm,
    ...(groupSupport ? { groupPolicy: "ad-direct-guid" as const } : {}),

    async resolvePolicyGroup(dn: string): Promise<PolicyGroupLookup> {
      if (!groupSupport) return { ok: false, reason: "unsupported" };
      if (closed) return { ok: false, reason: "unknown" };
      if (typeof dn !== "string" || !/^[^\u0000-\u001f\u007f]{1,1024}$/.test(dn)
        || !withinGroupBase(dn, cfg.baseDn)) return { ok: false, reason: "invalid" };
      let service: Session | undefined;
      try {
        service = await openService();
        const attrs = ["objectGUID", "groupType"];
        const found = await service.search("(objectClass=group)", attrs, ["objectGUID"], "base", dn, undefined, true);
        if (closed || found.length > 1) return { ok: false, reason: "unknown" };
        const entry = found[0];
        if (!entry) return { ok: false, reason: "not-found" };
        if (!withinGroupBase(entry.dn, cfg.baseDn)) return { ok: false, reason: "invalid" };
        const id = groupEntry(entry);
        if (!id) return { ok: false, reason: "not-security-group" };
        const { AndFilter, EqualityFilter, FilterParser } = await loadLdapts();
        const filter = new AndFilter({ filters: [FilterParser.parseString("(objectClass=group)"), new EqualityFilter(objectIdMatch("ad", id)!)] });
        const again = await service.search(filter, attrs, ["objectGUID"], "sub", cfg.baseDn, undefined, true);
        if (closed || again.length !== 1 || !groupEntry(again[0]!, id) || again[0]!.dn.toLowerCase() !== entry.dn.toLowerCase()) return { ok: false, reason: "unknown" };
        return { ok: true, group: Object.freeze({ key: Object.freeze({ realm: cfg.realm, objectId: id }), dn: again[0]!.dn }) };
      } catch { report("group-lookup", "unknown"); return { ok: false, reason: "unknown" }; }
      finally { await service?.close(); }
    },

    async readPolicyGroups(key: PersonKey): Promise<PolicyGroupFacts> {
      // Capture caller-owned identity before any await; later replacement cannot retarget a result.
      const who = key && Object.freeze({ realm: key.realm, objectId: key.objectId });
      if (!groupSupport || closed || !who || who.realm !== cfg.realm || !objectIdMatch("ad", who.objectId)) return { kind: "unknown" };
      let service: Session | undefined;
      try {
        service = await openService();
        const { Control, AndFilter, EqualityFilter, FilterParser } = await loadLdapts();
        class ExtendedDn extends Control {
          constructor() { super(AD_EXTENDED_DN, { critical: true }); }
          protected override writeControl(writer: import("ldapts").BerWriter): void {
            // LDAP controlValue OCTET STRING contains SEQUENCE { Flags INTEGER(1) }.
            writer.writeBuffer(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]), 0x04);
          }
        }
        const filter = new AndFilter({ filters: [FilterParser.parseString(cfg.userFilter), new EqualityFilter(objectIdMatch("ad", who.objectId)!)] });
        const found = await service.search(filter, attributes, ["objectGUID"], "sub", cfg.baseDn, [new ExtendedDn()], true);
        if (closed || found.length > 1) return { kind: "unknown" };
        const entry = found[0], observedAt = now();
        if (!entry) return { kind: "ineligible", person: who, reason: "gone", observedAt };
        if (readObjectId("ad", entry) !== who.objectId) return { kind: "unknown" };
        if (isDisabled("ad", entry, observedAt)) return { kind: "ineligible", person: who, reason: "disabled", observedAt };
        const groups = extendedGroupIds(entry);
        if (!groups) return { kind: "unknown" };
        return Object.freeze({ kind: "complete", person: who, groups, observedAt });
      } catch { report("group-membership", "unknown"); return { kind: "unknown" }; }
      finally { await service?.close(); }
    },

    async close(): Promise<void> {
      // Nothing is pooled; after close every call refuses (fail closed) instead of opening a new connection.
      closed = true;
    },

    lookupForInitialization(login: string): Promise<InitializationLookupResult> {
      return lookup(login, "initialization-lookup");
    },
    lookupForPairing(login: string): Promise<DirectoryLookupResult> {
      return lookup(login, "pairing-owner-lookup");
    },

    async signIn(login: string, password: string): Promise<SignInResult> {
      if (closed) return { ok: false, reason: "unavailable" };
      if (!validLogin(login) || !validPassword(password)) {
        report("sign-in", "bad-input");
        return { ok: false, reason: "bad-input" };
      }
      let service: Session | undefined;
      try {
        service = await openService();
        const selected = await selectLogin(service, login);
        if (!selected.ok) {
          const reason = selected.reason === "not-found" ? "invalid-credentials" : selected.reason;
          report("sign-in", reason, selected.detail);
          return { ok: false, reason };
        }
        const { entry, objectId } = selected;

        // The password goes to the directory once, on its own connection, for the DN the service search found.
        const user = await Session.open(cfg);
        try {
          await user.bind(entry.dn, password);
        } catch (err) {
          const { InvalidCredentialsError } = await loadLdapts();
          if (err instanceof InvalidCredentialsError) {
            report("sign-in", "invalid-credentials");
            return { ok: false, reason: "invalid-credentials" };
          }
          throw err;
        } finally {
          await user.close();
        }

        // The bound DN must still be the same object, still enabled (closes a delete/recreate race during the bind).
        const checked = await recheck(service, entry, objectId);
        if (!checked.ok) {
          const reason = checked.reason === "not-eligible" ? "not-eligible" : "unavailable";
          report("sign-in", reason, reason === "unavailable" ? "the entry changed during sign-in" : undefined);
          return { ok: false, reason };
        }
        return checked;
      } catch (err) {
        report("sign-in", "unavailable", err);
        return { ok: false, reason: "unavailable" };
      } finally {
        await service?.close();
      }
    },

    async checkEligibility(key: PersonKey): Promise<Eligibility> {
      if (closed) return { eligible: false, reason: "unavailable" };
      if (!key || key.realm !== cfg.realm || typeof key.objectId !== "string" || !objectIdMatch(cfg.profile, key.objectId)) {
        report("eligibility", "gone", "not a person key of this realm");
        return { eligible: false, reason: "gone" };
      }
      let service: Session | undefined;
      try {
        service = await openService();
        const found = await findById(service, key.objectId);
        if (found.length > 1) {
          report("eligibility", "unavailable", "the object id matches more than one entry");
          return { eligible: false, reason: "unavailable" };
        }
        const entry = found[0];
        if (!entry || readObjectId(cfg.profile, entry) !== key.objectId) {
          report("eligibility", "gone");
          return { eligible: false, reason: "gone" };
        }
        if (isDisabled(cfg.profile, entry, now())) {
          report("eligibility", "disabled");
          return { eligible: false, reason: "disabled" };
        }
        return { eligible: true, person: toPerson(entry, key.objectId) };
      } catch (err) {
        report("eligibility", "unavailable", err);
        return { eligible: false, reason: "unavailable" };
      } finally {
        await service?.close();
      }
    },
  };
}
