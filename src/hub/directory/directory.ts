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
import * as net from "node:net";
import * as tls from "node:tls";
import type { Client as LdapClient, Entry, Filter } from "ldapts";
import { HubDirectoryConfigError, resolveDirectoryConfig, type ResolvedDirectoryConfig } from "./config.js";
import { PROFILES, escapeFilterValue, isDisabled, objectIdMatch, readObjectId, readText, readTextList } from "./profiles.js";
import type { DirectoryPerson, Eligibility, HubDirectory, PersonKey, SignInResult } from "./types.js";

export interface HubDirectorySecrets {
  /** The service account's password (resolved by the caller from the Hub's secret store). */
  readonly bindPassword: string;
}

export interface HubDirectoryDiagnostic {
  readonly op: "sign-in" | "eligibility";
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

  async search(filter: string | Filter, attributes: string[], binary: readonly string[], scope: "sub" | "base" = "sub", base = this.cfg.baseDn): Promise<Entry[]> {
    this.assertSecure();
    const { searchEntries } = await this.client.search(base, {
      scope,
      filter,
      attributes,
      explicitBufferAttributes: [...binary],
      sizeLimit: 2,
      derefAliases: "never",
    });
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

  return {
    realm: cfg.realm,

    async close(): Promise<void> {
      // Nothing is pooled; after close every call refuses (fail closed) instead of opening a new connection.
      closed = true;
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
        const found = await service.search(`(&${cfg.userFilter}(${cfg.loginAttribute}=${escapeFilterValue(login)}))`, attributes, shape.binaryAttributes);
        if (found.length === 0) {
          report("sign-in", "invalid-credentials");
          return { ok: false, reason: "invalid-credentials" };
        }
        if (found.length > 1) {
          report("sign-in", "unavailable", "the login matches more than one entry");
          return { ok: false, reason: "unavailable" };
        }
        const entry = found[0]!;
        const objectId = readObjectId(cfg.profile, entry);
        if (!objectId) {
          report("sign-in", "unavailable", `the entry has no usable ${shape.idAttribute}`);
          return { ok: false, reason: "unavailable" };
        }
        if (isDisabled(cfg.profile, entry, now())) {
          report("sign-in", "not-eligible");
          return { ok: false, reason: "not-eligible" };
        }

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
        const again = await findById(service, objectId);
        const current = again.length === 1 ? again[0]! : undefined;
        if (!current || readObjectId(cfg.profile, current) !== objectId || current.dn.toLowerCase() !== entry.dn.toLowerCase()) {
          report("sign-in", "unavailable", "the entry changed during sign-in");
          return { ok: false, reason: "unavailable" };
        }
        if (isDisabled(cfg.profile, current, now())) {
          report("sign-in", "not-eligible");
          return { ok: false, reason: "not-eligible" };
        }
        return { ok: true, person: toPerson(current, objectId) };
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
