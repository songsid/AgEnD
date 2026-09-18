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
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFleetConfig } from "./config.js";
import { acquireFleetLock, releaseFleetLock, type FleetLockHandle, type FleetLockProbe } from "./fleet-lock.js";
import { handleQuickstartRequest, type QuickstartApiContext } from "./quickstart-api.js";
import { markSetupComplete } from "./setup-marker.js";
import { buildSessionCookie, hasValidSessionCookie, isSameOriginRequest, WEB_SESSION_COOKIE } from "./web-auth.js";
import { SETUP_FORM_HTML } from "./setup-form.js";
import yaml from "js-yaml";
import { writeFileSync } from "node:fs";

/** How long the form may stay open at all. */
export const SETUP_HOST_TTL_MS = 15 * 60_000;
/** …and how long it may stay open with nobody touching it. */
export const SETUP_HOST_IDLE_MS = 15 * 60_000;

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
  readonly token = randomBytes(24).toString("hex");
  /** A URL token is good for one exchange; after that only the cookie works. */
  private tokenRedeemed = false;

  constructor(private readonly opts: SetupHostOptions) {}

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

  async start(): Promise<{ port: number; token: string }> {
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
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    this.ttlTimer = setTimeout(() => { void this.shutdown(false, "ttl"); }, this.ttlMs);
    this.ttlTimer.unref?.();
    this.touch();
    return { port: (server.address() as { port: number }).port, token: this.token };
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.shutdown(false, "idle"); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private authorize(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!isSameOriginRequest(req)) { this.deny(res, 403, "cross-site request rejected"); return false; }
    if (hasValidSessionCookie(req, this.token)) return true;
    const provided = url.searchParams.get("token");
    if (provided && provided === this.token && !this.tokenRedeemed) {
      // One exchange only: the link the CLI printed is spent once it has become
      // a cookie, so a copy of it in a shell history or a screen share is dead.
      this.tokenRedeemed = true;
      res.setHeader("Set-Cookie", buildSessionCookie(this.token, false));
      res.setHeader("Location", url.pathname);
      res.setHeader("Cache-Control", "no-store");
      res.writeHead(302);
      res.end();
      return false;
    }
    this.deny(res, 401, "run `agend setup` again for a fresh link");
    return false;
  }

  private deny(res: ServerResponse, status: number, error: string): void {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.writeHead(status);
    res.end(JSON.stringify({ error }));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Vary", "Cookie");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.opts.port}`);
    if (!this.authorize(req, res, url)) return;
    // Only after authorization: otherwise anyone who can reach the port can
    // hold the page open indefinitely by knocking on it, leaving the TTL as the
    // only thing that ever closes it.
    this.touch();

    if (req.method === "GET" && url.pathname === "/") {
      // The setup form, not the Settings page: this host has no fleet to show
      // and must not serve a panel whose controls it cannot honour.
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      res.end(SETUP_FORM_HTML);
      return;
    }
    if (req.method === "GET" && url.pathname === "/setup/status") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ pre_fleet: true, ttl_ms: this.ttlMs }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/setup/finish") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(202);
      res.end(JSON.stringify({ starting: true }));
      // After the response, so the browser has its answer before the port goes.
      setTimeout(() => { void this.shutdown(true, "finished"); }, 10);
      return;
    }
    if (handleQuickstartRequest(req, res, url, this.context())) return;

    res.setHeader("Content-Type", "application/json");
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
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
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    releaseFleetLock(this.lock);
    this.lock = undefined;
    if (spawnSuccessor) {
      markSetupComplete(this.opts.dataDir);
      this.log("Setup complete — starting AgEnD.");
      (this.opts.spawnFleet ?? defaultSpawnFleet)();
    } else {
      this.log(`Setup host stopped (${reason}). Run \`agend setup\` again to reopen it.`);
    }
  }
}
