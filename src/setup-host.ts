/**
 * The form that runs before there is a fleet.
 *
 * This process exists only to collect what `agend quickstart` collects, write
 * it, and hand the port to the real fleet. Three properties matter more than
 * anything it does:
 *
 * - **It cannot reach the fleet.** Its imports stop at the config and the
 *   provider probes; `tests/prefleet-host.test.ts` asserts the graph never
 *   reaches fleet-manager, daemon or instance-lifecycle. A pre-fleet surface
 *   that could start or stop agents would be a much larger thing to defend.
 * - **It lets go of the port before the fleet is started.** The fleet's
 *   health-port takeover is not a safety net: on a busy port it signals
 *   whatever fleet.pid names and then disables the dashboard for the rest of
 *   its life. So the listener is closed — including its open connections —
 *   and only then is the fleet spawned.
 * - **It goes away on its own.** A setup form left open is an unauthenticated-
 *   by-default surface waiting for someone to find it, so it exits on its TTL
 *   and on idleness as readily as on success.
 *
 * Hardened ahead of being reachable from outside (see
 * `docs/design/setup-host-tunnel.zh-TW.md`): the page lives under a random sid
 * so a scanner cannot find it, the credential is a short code typed into the
 * page rather than anything in the URL, the cookie is derived from a freshly
 * minted 256-bit secret rather than from that code, and every presented-and-
 * wrong credential spends one of five shared attempts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFleetConfig } from "./config.js";
import { acquireFleetLock, releaseFleetLock, type FleetLockHandle, type FleetLockProbe } from "./fleet-lock.js";
import { handleQuickstartRequest, type QuickstartApiContext } from "./quickstart-api.js";
import { markSetupComplete } from "./setup-marker.js";
import { isSameOriginRequest, parseCookieHeader } from "./web-auth.js";
import {
  buildSetupCookie,
  formatSetupCode,
  MAX_SETUP_ATTEMPTS,
  SetupCredentials,
  SETUP_COOKIE_NAME,
} from "./setup-auth.js";
import { SETUP_CODE_PAGE_HTML, SETUP_FORM_HTML } from "./setup-form.js";
import { ManagedTunnel } from "./tunnel/manager.js";
import { CloudflaredProvider } from "./tunnel/cloudflared.js";
import type { TunnelHandle, TunnelProvider } from "./tunnel/types.js";
import yaml from "js-yaml";
import { writeFileSync } from "node:fs";

/** How long the form may stay open at all. */
export const SETUP_HOST_TTL_MS = 15 * 60_000;
/**
 * …and how long it may stay open with nobody touching it.
 *
 * Strictly shorter than the TTL, which it was not: both were fifteen minutes,
 * so the idle timer could never fire first and the page always stayed open for
 * the full quarter hour whether anyone was using it or not.
 */
export const SETUP_HOST_IDLE_MS = 10 * 60_000;

export interface SetupHostOptions {
  dataDir: string;
  configPath: string;
  port: number;
  ttlMs?: number;
  idleMs?: number;
  /** Injected so a test can observe the handover without starting a fleet. */
  spawnFleet?: () => void;
  now?: () => number;
  log?: (message: string) => void;
  /** Test seam: the same probe `acquireFleetLock` already accepts. */
  lockProbe?: FleetLockProbe;
  /** Fixed in tests so the URL and the code are predictable. */
  credentials?: SetupCredentials;
  /**
   * Expose the page through a tunnel.
   *
   * Turning this on forces the listener onto an ephemeral port — see
   * `resolvePort`. That is not a convenience; it is the reason a tunnel that
   * outlives this process cannot end up pointed at a fleet dashboard.
   */
  tunnel?: boolean;
  /** Test seam: the real one runs cloudflared. */
  tunnelProvider?: TunnelProvider;
}

/**
 * The port a setup host may bind.
 *
 * In tunnel mode it is always zero. Not "unless `--port` was given", and not
 * "unless fleet.yaml names a health port" — those are the two ways a fixed
 * port creeps back behind a tunnel, and the second one needs no flag at all.
 * Whatever the fleet would later bind must never be the thing the tunnel is
 * pointed at.
 */
export function resolvePort(opts: { tunnel?: boolean; port?: number; healthPort?: number }): number {
  if (opts.tunnel) return 0;
  return opts.port ?? opts.healthPort ?? 19280;
}

function defaultSpawnFleet(): void {
  const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const child = spawn(process.execPath, [cliEntry, "start"], { detached: true, stdio: "ignore" });
  child.unref();
}

export class SetupHost {
  private server: Server | null = null;
  private lock: FleetLockHandle | undefined;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private readonly credentials: SetupCredentials;
  /** Where this page lives. Random, and not a credential — see setup-auth.ts. */
  readonly sid: string;
  /** What the person types. Printed by the CLI; never put in a URL. */
  readonly code: string;

  constructor(private readonly opts: SetupHostOptions) {
    this.credentials = opts.credentials ?? new SetupCredentials();
    this.sid = this.credentials.sid;
    this.code = this.credentials.code;
  }

  /** The page's own path. Everything outside it is not this page. */
  private get basePath(): string { return `/s/${this.sid}/`; }

  private managedTunnel: ManagedTunnel | null = null;
  private tunnelHandle: TunnelHandle | null = null;
  /** The exact host the tunnel answers on; nothing else is added to the set. */
  private externalHost: string | null = null;
  private listenerClosed = false;
  private credentialsRevoked = false;
  private tunnelStopResult: "confirmed" | "unconfirmed" | "none" = "none";

  private get ttlMs(): number { return this.opts.ttlMs ?? SETUP_HOST_TTL_MS; }
  private get idleMs(): number { return this.opts.idleMs ?? SETUP_HOST_IDLE_MS; }
  private log(message: string): void { (this.opts.log ?? console.log)(message); }

  /** The config the wizard edits: a file if there is one, otherwise a blank. */
  private readConfig() {
    try { return loadFleetConfig(this.opts.configPath); }
    catch { return { defaults: {}, instances: {} }; }
  }

  private context(): QuickstartApiContext {
    const config = this.readConfig();
    return {
      fleetConfig: config,
      dataDir: this.opts.dataDir,
      logger: { info: () => {}, warn: () => {} },
      // Nothing to preserve: before a fleet there are no comments and no hand
      // edits to keep, so a plain dump is the whole writer.
      saveFleetConfig: () => {
        writeFileSync(this.opts.configPath, yaml.dump(config, { quotingType: '"', forceQuotes: false }), { mode: 0o600 });
      },
      // No fleet, so nothing is polling any bot token.
    };
  }

  async start(): Promise<{ port: number; sid: string; code: string; path: string; publicUrl: string | null }> {
    // This host writes fleet.yaml by dumping the loader's output, which expands
    // every default and drops every comment. That is fine for a file it is
    // creating and destructive to one somebody already has — and an existing
    // installation should be using the panel's wizard anyway, which edits the
    // document in place.
    const existing = this.readConfig();
    if (Object.keys(existing.instances ?? {}).length > 0) {
      throw new Error(
        "This installation already has agents configured. Open Settings in the dashboard and use the setup wizard there — it edits your fleet.yaml in place.",
      );
    }
    // Refuses while a fleet runs, and — since the record carries a role — is
    // equally refused to a fleet that starts while this host is up.
    this.lock = acquireFleetLock(this.opts.dataDir, { role: "setup-host", ...this.opts.lockProbe });

    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    // Zero in tunnel mode, and the caller cannot override it: `resolvePort` is
    // the only thing that decides, so a flag or a config value cannot put a
    // fixed port behind a tunnel.
    const bindPort = this.opts.tunnel ? 0 : this.opts.port;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindPort, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    this.ttlTimer = setTimeout(() => { void this.shutdown(false, "ttl"); }, this.ttlMs);
    this.ttlTimer.unref?.();
    this.boundPort = (server.address() as { port: number }).port;
    this.touch();

    const publicUrl = this.opts.tunnel ? await this.openTunnel() : null;
    return { port: this.boundPort, sid: this.sid, code: this.code, path: this.basePath, publicUrl };
  }

  /**
   * Put the page behind a tunnel, or say why it is not.
   *
   * Three outcomes, and the third is the one that matters: a start that failed
   * while leaving a process it could not account for is not a fallback, it is a
   * stop. Carrying on would mean serving this page on loopback while something
   * we cannot see may still be exposing it.
   */
  private async openTunnel(): Promise<string | null> {
    const managed = new ManagedTunnel({ dataDir: this.opts.dataDir, log: m => this.log(m) });
    this.managedTunnel = managed;
    const provider = this.opts.tunnelProvider ?? new CloudflaredProvider();
    const result = await managed.start(provider, {
      sid: this.sid,
      origin: new URL(`http://127.0.0.1:${this.boundPort}`),
      pagePath: this.basePath,
      readinessMarker: this.credentials.readinessMarker,
      expiresAt: (this.opts.now ?? Date.now)() + this.ttlMs,
      signal: new AbortController().signal,
    });

    if (result.ok) {
      this.tunnelHandle = result.handle;
      this.externalHost = new URL(result.handle.baseUrl).host;
      // The page is gone the moment the tunnel is, and a session whose
      // hostname has changed underneath it is not a session to keep.
      result.handle.onUnexpectedExit(() => {
        this.log("The tunnel closed unexpectedly. Run `agend setup --tunnel` again for a new link.");
        void this.shutdown(false, "tunnel died");
      });
      return result.handle.pageUrl;
    }

    if (result.leaseHeld) {
      // Fail closed: a tunnel process we cannot account for may still be
      // pointed at this listener, so there is no honest "falling back to
      // localhost" to announce.
      await this.shutdown(false, "tunnel could not be cleaned up");
      throw new Error(`Could not open a tunnel, and could not confirm it was cleaned up: ${result.message}`);
    }

    this.log(`No public tunnel: ${result.message}`);
    this.log("The link below only works on this machine — a phone will not be able to open it.");
    return null;
  }

  private boundPort = 0;

  /**
   * The hosts this listener will answer to.
   *
   * Origin==Host alone accepts any Host at all, which was harmless while the
   * only way in was loopback. It stops being harmless the moment something in
   * front of the listener can set it, so the set is named rather than inferred.
   */
  private allowedHosts(): string[] {
    const hosts = [`127.0.0.1:${this.boundPort}`, `localhost:${this.boundPort}`, `[::1]:${this.boundPort}`];
    // Exactly the host this tunnel answers on, and only while it is ours. An
    // ephemeral port can be handed to a later listener, and a tunnel nobody
    // cleaned up would then be pointed at that one — this list is what makes
    // the zombie's requests 403 instead of reaching a stranger's page.
    if (this.externalHost) hosts.push(this.externalHost);
    return hosts;
  }

  /**
   * Whether the browser reached this over TLS.
   *
   * Derived from what this process knows it is serving, never from
   * `X-Forwarded-Proto`: that header is set by whatever is in front, including
   * an attacker, and a cookie's Secure attribute is not something to take on
   * trust from a request.
   */
  private get endpointIsHttps(): boolean { return this.externalHost !== null; }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.shutdown(false, "idle"); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /**
   * The answer for anything that is not this page.
   *
   * Byte-identical whatever the reason, because the difference between "wrong
   * sid" and "no such path" is precisely how a sid gets found.
   */
  private notFound(res: ServerResponse): void {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  }

  private deny(res: ServerResponse, status: number, error: string): void {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(status);
    res.end(JSON.stringify({ error }));
  }

  private hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return typeof host === "string" && this.allowedHosts().includes(host);
  }

  private presentedCookie(req: IncomingMessage): string | undefined {
    return parseCookieHeader(req.headers.cookie).get(SETUP_COOKIE_NAME);
  }

  /** Spend an attempt's worth of consequence: at zero the page is over. */
  private afterFailure(res: ServerResponse, kind: "locked" | "rejected", attemptsLeft: number): void {
    if (kind === "locked") {
      this.deny(res, 410, "too many failed attempts — run `agend setup` again on the host");
      setTimeout(() => { void this.shutdown(false, "lockout"); }, 10);
      return;
    }
    this.deny(res, 401, `incorrect — ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left`);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Vary", "Cookie");
    // On every response, not just the redirect that used to carry it: a shared
    // cache in front of this — which is what a tunnel edge is — must never keep
    // a copy of a page or an answer belonging to one setup session.
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.boundPort}`);

    // Everything below the sid, and nothing else. Checked before the idle timer
    // is touched, or a scanner that cannot find the page could still keep it
    // open forever by knocking on the wrong paths.
    const segments = url.pathname.split("/");
    if (segments[1] !== "s" || !this.credentials.matchesSid(segments[2] ?? "")) {
      this.notFound(res);
      return;
    }
    const rest = `/${segments.slice(3).join("/")}`;

    if (!isSameOriginRequest(req) || !this.hostAllowed(req)) {
      this.deny(res, 403, "cross-site request rejected");
      return;
    }

    // The two unauthenticated endpoints: the page that asks for the code, and
    // the exchange itself. Everything else needs the cookie.
    if (req.method === "GET" && (rest === "/" || rest === "")) {
      const signedIn = this.credentials.checkCookie(this.presentedCookie(req)).kind === "ok";
      // Only a session that exists keeps the page alive. Reloading the code
      // prompt is not use of the page, and treating it as such would let
      // anyone holding the link hold the window open indefinitely.
      if (signedIn) this.touch();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      // The wizard itself is only served to a session that has the cookie; an
      // unauthenticated visitor gets the code prompt and nothing about this
      // machine.
      res.end(signedIn
        ? SETUP_FORM_HTML
        : SETUP_CODE_PAGE_HTML.replace("__AGEND_SETUP_MARKER__", this.credentials.readinessMarker));
      return;
    }
    if (req.method === "POST" && rest === "/open") {
      this.redeem(req, res);
      return;
    }

    const verdict = this.credentials.checkCookie(this.presentedCookie(req));
    if (verdict.kind === "locked") { this.afterFailure(res, "locked", 0); return; }
    if (verdict.kind === "rejected") { this.afterFailure(res, "rejected", verdict.attemptsLeft); return; }
    if (verdict.kind === "unauthenticated") {
      this.deny(res, 401, "enter the setup code first");
      return;
    }

    // Only now: an authorized request is the only kind that should be able to
    // keep this page alive.
    this.touch();

    if (req.method === "GET" && rest === "/setup/status") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ pre_fleet: true, ttl_ms: this.ttlMs }));
      return;
    }
    if (req.method === "POST" && rest === "/setup/finish") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(202);
      // `watch` is false behind a tunnel: this page is about to stop existing
      // along with the hostname it is served on, so polling would only produce
      // a false alarm. The dashboard is not an answer either — it binds
      // loopback, so a link to it would be one a phone cannot open.
      res.end(JSON.stringify({ starting: true, watch: this.externalHost === null }));
      // After the response, so the browser has its answer before the port goes.
      setTimeout(() => { void this.shutdown(true, "finished"); }, 10);
      return;
    }
    // The wizard API is mounted under the sid too, so its paths are rewritten
    // rather than exposed at the root where a scanner could reach them.
    const inner = new URL(rest + url.search, "http://127.0.0.1");
    if (handleQuickstartRequest(req, res, inner, this.context())) return;

    this.notFound(res);
  }

  /** Exchange the typed code for a session cookie. The only way in. */
  private redeem(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", chunk => {
      body += String(chunk);
      if (body.length > 4096) { req.destroy(); }
    });
    req.on("end", () => {
      let provided = "";
      try { provided = String((JSON.parse(body || "{}") as { code?: unknown }).code ?? ""); } catch { /* empty */ }
      const verdict = this.credentials.redeem(provided);
      if (verdict.kind === "ok" && verdict.secret) {
        this.touch();
        res.setHeader("Set-Cookie", buildSetupCookie(verdict.secret, {
          path: this.basePath,
          secure: this.endpointIsHttps,
          maxAgeSeconds: Math.ceil(this.ttlMs / 1000),
        }));
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (verdict.kind === "locked") { this.afterFailure(res, "locked", 0); return; }
      if (verdict.kind === "rejected") { this.afterFailure(res, "rejected", verdict.attemptsLeft); return; }
      this.deny(res, 400, "enter the setup code");
    });
  }

  /**
   * Let go of the port, then hand it over.
   *
   * `closeAllConnections()` first, and not as a nicety: a browser polling for
   * the fleet holds a connection open, and `close()` waits for it. Measured, a
   * single open poll stops the close from ever completing — so the form would
   * hang at "starting…" and the fleet would never be spawned.
   */
  async shutdown(spawnSuccessor: boolean, reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);

    // 1. Capability first. Anything still in flight — including a request
    //    arriving through a tunnel that is still up — is already unauthorized
    //    from here, so the order below can take its time without a window.
    this.credentials.revoke();
    this.credentialsRevoked = true;

    // 2. The listener, and its open connections. From this point the public URL
    //    reaches nothing, whatever the tunnel is doing.
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    this.listenerClosed = true;

    // 3. The tunnel, with proof.
    if (this.managedTunnel && this.tunnelHandle) {
      const stopped = await this.managedTunnel.stop(reason);
      this.tunnelStopResult = stopped.confirmed ? "confirmed" : "unconfirmed";
      if (!stopped.confirmed) {
        this.log(
          `The tunnel could not be confirmed closed${stopped.pid !== null ? ` (pid ${stopped.pid})` : ""}: ${stopped.reason}. `
          + "That URL may keep answering 'origin unavailable' for a while; nothing behind it is reachable. "
          + `To clean up by hand, kill ${stopped.pid !== null ? `pid ${stopped.pid}` : "the cloudflared process"}. `
          + "No new tunnel will be opened until this is resolved.",
        );
      }
    }

    releaseFleetLock(this.lock);
    this.lock = undefined;

    if (!spawnSuccessor) {
      this.log(`Setup host stopped (${reason}). Run \`agend setup\` again to reopen it.`);
      return;
    }

    if (this.tunnelStopResult === "unconfirmed" && !this.mayHandOverWithUnconfirmedTunnel()) {
      // Fail closed. The config is written; what is missing is a process this
      // one is not willing to start while a tunnel it cannot account for could
      // still be pointed at the port that process would bind.
      this.log(
        "Your configuration has been saved, but AgEnD was NOT started: a tunnel could not be confirmed closed "
        + "and this host is not on an ephemeral port, so starting the fleet could put its dashboard behind that tunnel. "
        + "Kill the cloudflared process, then run `agend start` on this machine.",
      );
      return;
    }

    markSetupComplete(this.opts.dataDir);
    this.log("Setup complete — starting AgEnD.");
    (this.opts.spawnFleet ?? defaultSpawnFleet)();
  }

  /**
   * Whether an unconfirmed tunnel may be left behind while the fleet starts.
   *
   * Ruled on by fable, and conditional by construction. The reasoning only
   * holds because a leftover tunnel points at an ephemeral port this process
   * owned and nothing will deliberately bind again — so the damage of being
   * wrong is a URL that answers "unavailable", not a public dashboard.
   *
   * **If anyone puts this host back on the health port, this ruling is void**
   * and the path must return to refusing the handover. That is the first
   * condition below rather than a note in a comment, precisely so the change
   * that breaks the reasoning also flips the behaviour.
   */
  private mayHandOverWithUnconfirmedTunnel(): boolean {
    const onEphemeralPort = this.opts.tunnel === true && this.opts.port === 0;
    const leaseKept = this.managedTunnel !== null;
    return onEphemeralPort
      && this.listenerClosed
      && this.credentialsRevoked
      && leaseKept;
  }
}
