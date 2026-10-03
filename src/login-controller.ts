/**
 * Remote `/login` in the web terminal (v2.1.5, design docs/design/login-relay-v2).
 *
 * The fleet starts ONE command (`<backend> login`, optionally preceded by a
 * deterministic pre-command such as `kiro-cli logout`) in a dedicated tmux
 * server and opens a time-boxed, token-gated browser terminal onto that pane
 * (src/web-terminal.ts). The human drives whatever TUI the CLI shows; the
 * fleet only observes the pane to post the device URL/code, judge success and
 * restart the backend's instances afterwards. Zero LLM involvement.
 *
 * Authorization surface owned here (sol reviews this as a new surface):
 *   - admin-only, re-checked inside start() — callers are not trusted
 *   - one login/install window fleet-wide, claimed SYNCHRONOUSLY before the
 *     first await (LoginWindowLock, shared with install)
 *   - only flows reviewed as having no shell escape (`noShellEscape: true`)
 *     may open a terminal; per-requester rate limit 3 starts / 5 min
 *   - every start goes through a risk confirmation button (design §3.2); the
 *     kiro variant also states that the CLI will be logged out first
 *   - the link (no secret) goes to the requesting chat; the one-time access
 *     token goes ONLY to the requester privately (adapter.sendDirect). If the
 *     private route fails the token is never posted in the channel: the
 *     admin gets a requester-only "resend" button. If neither the link nor a
 *     token route can be delivered, the session is cancelled — never left
 *     half-delivered.
 *   - errors from secret-bearing sends are logged as name/code only; every
 *     step is audited to the event log without token/cookie/URL secrets
 *   - fleet shutdown cancels the active session and waits for the confirmed
 *     tmux kill (no orphaned login CLI)
 *
 * Public link (#1137: offered by default; `web_terminal.tunnel.allow_public: false` is the
 * operator's kill switch, and with it none of this exists): for a flow marked `tunnelOk` the
 * confirmation offers "I understand (temporary public link)" beside "I understand (local
 * network)". Pressing it is the consent, once per login — nothing is ever exposed on a standing
 * basis. Then:
 *   - before any session exists, a cloudflared is found: the user's own on PATH, else AgEnD's
 *     pinned, SHA256-verified copy in <AGEND_HOME>/bin, downloaded when missing
 *     (tunnel/cloudflared-install.ts). Any failure there ends the request with nothing opened
 *   - a Cloudflare Quick Tunnel is put in front of THIS session's listener only, through the
 *     fleet-wide ManagedTunnel (lease, confirmed stop); the listener is told the tunnel's
 *     exact host before the readiness probe arrives under it, and marks cookies Secure on it
 *   - the public URL and the access token go ONLY to the requester, as two private messages;
 *     the channel gets one line and never the URL. If either private message cannot be
 *     delivered the tunnel and session are closed — there is no "post it in the channel" path
 *   - fail closed: a tunnel that dies ends the session; a session that ends (done, cancelled,
 *     TTL, shutdown, failed delivery) closes the tunnel BEFORE the window is released, and a
 *     tunnel that cannot be confirmed stopped is announced loudly and blocks further tunnels
 *   - the link is minted fresh each time and never logged or audited (the host name is part of
 *     the capability)
 */
import { homedir } from "node:os";
import type { ChannelAdapter } from "./channel/types.js";
import type { FleetConfig } from "./types.js";
import { LOGIN_BACKEND_ALIASES, LOGIN_FLOWS, checkAuthStatus, type AuthCheck, type AuthCheckResult, type LoginFlow } from "./login-flows.js";
import { t } from "./locale.js";
import type { LoginWindowClaim } from "./login-window-lock.js";
import {
  MAX_TTL_MS, TmuxTerminalBackend, WebTerminalSession,
  type TerminalLogger, type WebTerminalEvents, type WebTerminalResult, type WebTerminalSpec,
} from "./web-terminal.js";
import { WebTerminalHttpServer, type WebTerminalHttpOptions } from "./web-terminal-http.js";
import { allowedHostNames } from "./web-host-guard.js";
import { ManagedTunnel, newTunnelSid, type ManagedStartResult } from "./tunnel/manager.js";
import { CloudflaredProvider } from "./tunnel/cloudflared.js";
import { ensureCloudflared, type EnsureCloudflaredResult } from "./tunnel/cloudflared-install.js";
import type { TunnelHandle, TunnelStartContext, TunnelStopResult } from "./tunnel/types.js";

export const LOGIN_TOKEN_RESEND_PREFIX = "login-token:";
export const DEFAULT_WEB_TERMINAL_TTL_MINUTES = 10;
/** Design §3.1: a requester may create at most this many sessions per window. */
export const START_RATE_LIMIT = 3;
export const START_RATE_WINDOW_MS = 5 * 60_000;

/**
 * What post-login recovery managed within its deadline. `pending` instances
 * were NOT cancelled — they are still restarting, and saying so beats implying
 * they failed or saying nothing at all.
 */
export interface PostLoginRecovery {
  woken: string[];
  restarted: string[];
  pending: string[];
  /** Set when recovery itself threw; the login still succeeded. */
  failed?: string;
}

/**
 * How long the login flow waits for the affected instances to come back before
 * it reports progress instead of a result. Generous: a restart is slow and the
 * user would rather wait than be told "still working" too eagerly — but finite,
 * because silence is what made this look like a hang.
 */
export const POST_LOGIN_RECOVERY_DEADLINE_MS = 90_000;

/**
 * Bring the backend's instances back and report the OUTCOME — always, and in
 * terms the user can act on. Shared by both login paths so they cannot drift
 * into telling the user different things about the same event.
 *
 * The caller has already said the login itself succeeded; this is the second
 * half, and it must be terminal. An unfinished instance is reported as still
 * restarting rather than left to silence: silence is what made people restart
 * things by hand while the recovery was in fact still running.
 */
export async function announcePostLoginRecovery(
  backend: string,
  recover: () => Promise<PostLoginRecovery>,
  send: (text: string) => Promise<unknown>,
  deadlineMs = POST_LOGIN_RECOVERY_DEADLINE_MS,
): Promise<void> {
  const none = t("login.none");
  let result: PostLoginRecovery;
  try {
    result = await recover();
  } catch (err) {
    // Recovery throwing must not swallow the report: the login DID succeed and
    // the user still needs to know where that leaves them.
    result = { woken: [], restarted: [], pending: [], failed: String((err as Error)?.message ?? err) };
  }
  const list = (names: string[]) => (names.length ? names.join(", ") : none);
  if (result.failed) {
    await send(t("login.recover_failed", backend, result.failed));
    return;
  }
  // Defensive on shape, deliberately: this function exists to guarantee the
  // user hears an outcome, so it must not be the thing that throws.
  const pending = result.pending ?? [];
  if (pending.length) {
    await send(t("login.recover_pending", backend, String(Math.round(deadlineMs / 1000)), pending.join(", ")));
    return;
  }
  await send(t("login.recovered", backend, list(result.woken), list(result.restarted)));
}

export interface LoginChat {
  adapter: ChannelAdapter;
  adapterId: string;
  chatId: string;
  threadId?: string;
  /** The human who issued the command / pressed the button. Required in web mode. */
  userId?: string;
}

export interface LoginStartOptions {
  /**
   * Set by the confirmation button: the risk (and, for kiro, the logout)
   * was acknowledged; the pre-check already ran. Without it, start() posts the
   * confirmation and returns null.
   */
  skipAuthCheck?: boolean;
  /** From the confirmation button: the pre-check had found a live token (kiro logout-first applies). */
  tokenPresent?: boolean;
  /**
   * From the "Open public link" button: the admin consented to a temporary public tunnel for
   * THIS login. Re-checked against the config and the flow inside start() — a stale button or
   * a config change in between gets a refusal, not a tunnel.
   */
  tunnel?: boolean;
}

/** What the controller needs from a tunnel — a fake in tests, ManagedTunnel + cloudflared for real. */
export interface LoginTunnelPort {
  start(ctx: TunnelStartContext): Promise<ManagedStartResult>;
  stop(reason: string): Promise<TunnelStopResult>;
}

export interface LoginControllerDeps {
  logger: TerminalLogger & { error(obj: unknown, msg?: string): void };
  fleetConfig: () => FleetConfig | null;
  isFleetAdmin(userId: string, adapterId?: string): boolean;
  /** Event log sink; instance column is "login". */
  eventLog: () => { insert(instance: string, type: string, payload?: Record<string, unknown>): void } | null;
  /** Wake/restart the backend's instances after a successful login. */
  recoverBackendInstances(backend: string): Promise<PostLoginRecovery>;
  /** Post nonce buttons (FleetManager.postNonceButtonPrompt). Rejects when the platform refused. */
  postButtons(opts: {
    prefix: string; instanceName: string; chat: LoginChat; message: string;
    choices: Array<{ action: string; label: string }>; expiredText: string;
  }): Promise<void>;
  /** Fleet-wide window reservation (shared with install). */
  claimWindow(backend: string): LoginWindowClaim | null;
  releaseWindow(claim: LoginWindowClaim): void;
  /** False once the fleet is shutting down or the claim was superseded — continuations must stop. */
  isClaimCurrent(claim: LoginWindowClaim): boolean;
  windowBusyMessage(): string;
  // Injection seams (tests): default to the real engine.
  checkAuth?: (check: AuthCheck) => Promise<AuthCheckResult>;
  createSession?: (spec: WebTerminalSpec, events: WebTerminalEvents, logger: TerminalLogger) => WebTerminalSession;
  createHttp?: (session: WebTerminalSession, logger: TerminalLogger, opts: WebTerminalHttpOptions) => WebTerminalHttpServer;
  now?: () => number;
  /**
   * Where the fleet-wide tunnel lease lives. Without it (and without `createTunnel`) a public
   * link is never offered, whatever the config says.
   */
  tunnelDataDir?: () => string;
  /** Test seam: replaces ManagedTunnel + CloudflaredProvider. */
  createTunnel?: (cfg: FleetConfig | null) => LoginTunnelPort;
  /**
   * A cloudflared to run for a public link (#1137): the user's own on PATH, else
   * AgEnD's pinned, SHA256-verified copy, downloaded when needed. Defaults to
   * `ensureCloudflared` in `tunnelDataDir()`; a test that injects `createTunnel`
   * and not this gets no cloudflared step.
   */
  ensureCloudflared?: (onDownloading: (info: { version: string; asset: string }) => Promise<void>, signal: AbortSignal) => Promise<EnsureCloudflaredResult>;
}

interface ActiveLogin {
  claim: LoginWindowClaim;
  session: WebTerminalSession;
  http: WebTerminalHttpServer | null;
  backend: string;
  chat: LoginChat;
  requesterUserId: string;
  url: string;
  tokenDelivered: boolean;
  /** The cloudflared this login's public link runs (absent: the provider looks on PATH). */
  cloudflaredPath?: string;
  /** The caller already reported this session's end (startup/delivery failure, shutdown): onDone stays quiet. */
  silent: boolean;
  /** Present only for a public-link login. */
  tunnel: {
    port: LoginTunnelPort;
    abort: AbortController;
    /** The in-flight start, so a close can wait for it instead of racing it. */
    starting: Promise<ManagedStartResult> | null;
    handle: TunnelHandle | null;
    closing: Promise<void> | null;
  } | null;
}

/**
 * Describe an error from a secret-bearing operation WITHOUT trusting anything
 * the error carries (sol B2/B3): message, name and code are all
 * provider-controlled and any of them may echo the payload (the token). Only
 * a bounded, errno-like code survives; everything else is a constant.
 */
const KNOWN_ERRNO = new Set([
  "EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "EACCES", "EPERM", "ENOENT", "ECONNABORTED", "ERR_NETWORK", "ABORT_ERR", "ETELEGRAM", "UND_ERR_CONNECT_TIMEOUT",
]);
function safeErr(err: unknown): { errorKind: "error"; errno?: number | string } {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "number" && Number.isFinite(code)) return { errorKind: "error", errno: code };
  // Exact set only — a shape-based allowlist overlaps the token's own shape (sol round 3 B2).
  if (typeof code === "string" && KNOWN_ERRNO.has(code)) return { errorKind: "error", errno: code };
  return { errorKind: "error" };
}

export class LoginController {
  private active: ActiveLogin | null = null;
  /** True between shutdown() and reopen(): no new work is accepted. */
  private stopping = false;
  /**
   * Monotonic: incremented by every shutdown(), never rolled back by reopen().
   * A continuation captures it at start and treats any change as "the world
   * I started in is gone" — so a stopAll→startAll cannot resurrect old work.
   */
  private shutdownGeneration = 0;
  private readonly backendFactory = new TmuxTerminalBackend();
  private readonly startTimes = new Map<string, number[]>();
  /** One tunnel owner for the process: the lease it writes is fleet-wide, so this must not be per-login. */
  private managedTunnel: ManagedTunnel | null = null;
  /** A public-link start between its claim and its session: getting cloudflared (#1141 review). */
  private pendingTunnelStart: { backend: string; abort: AbortController } | null = null;

  constructor(private readonly deps: LoginControllerDeps) {}

  /** A session, or a public-link start still getting its cloudflared (cancellable either way). */
  isActive(): boolean { return this.active !== null || this.pendingTunnelStart !== null; }
  get activeBackend(): string | null { return this.active?.backend ?? null; }

  /**
   * Start a web-terminal login. Returns a status line, or null when the
   * confirmation buttons were posted instead (every start is confirmed once;
   * the button calls back with skipAuthCheck + tokenPresent).
   */
  async start(backendArg: string, chat: LoginChat, opts: LoginStartOptions = {}): Promise<string | null> {
    const backend = LOGIN_BACKEND_ALIASES[backendArg.toLowerCase()] ?? backendArg.toLowerCase();
    const flow = LOGIN_FLOWS[backend];
    if (!flow) return t("login.unsupported", backendArg);
    if (flow.remoteLogin === "unsupported") {
      this.audit("declined_unsupported", { backend, requester: chat.userId ?? null });
      return t("login.remote_unsupported_agent_cli", backend, flow.command);
    }

    if (this.stopping) return t("login.web_shutting_down");
    const generation = this.shutdownGeneration;
    // Authorization is decided HERE, not by whoever called us.
    if (!chat.userId || !this.deps.isFleetAdmin(chat.userId, chat.adapterId)) {
      this.audit("denied", { backend, requester: chat.userId ?? null, adapterId: chat.adapterId });
      return t("permission.denied");
    }
    const cfg = this.deps.fleetConfig();
    if (cfg?.web_terminal?.enabled === false) return t("login.web_disabled");
    if (flow.noShellEscape !== true) {
      this.audit("flow_not_allowed", { backend, requester: chat.userId });
      return t("login.web_flow_not_allowed", backend);
    }
    if (!this.admitRate(chat.userId)) {
      this.audit("rate_limited", { backend, requester: chat.userId });
      return t("login.web_rate_limited", String(START_RATE_LIMIT), String(START_RATE_WINDOW_MS / 60_000));
    }

    // Reserve the fleet-wide window NOW, before any await (sol B1). From here
    // on the claim is owned by this region: every exit releases it unless it
    // was transferred to a published session (`transferred`), and every
    // resumption after an await re-checks that the claim is still current —
    // a fleet shutdown in between must stop us (sol round 2 B1/B2).
    const claim = this.deps.claimWindow(backend);
    if (!claim) return this.deps.windowBusyMessage();
    let transferred = false;
    try {
      return await this.startClaimed(flow, backend, chat, opts, cfg, claim, generation, () => { transferred = true; });
    } finally {
      if (!transferred) this.deps.releaseWindow(claim);
    }
  }

  /** The fence every continuation applies after an await: stopping, a newer shutdown generation, or a lost claim. */
  private stale(generation: number, claim: LoginWindowClaim | null): boolean {
    return this.stopping || this.shutdownGeneration !== generation || (claim !== null && !this.deps.isClaimCurrent(claim));
  }

  private async startClaimed(
    flow: LoginFlow, backend: string, chat: LoginChat, opts: LoginStartOptions, cfg: FleetConfig | null,
    claim: LoginWindowClaim, generation: number, markTransferred: () => void,
  ): Promise<string | null> {
    if (!opts.skipAuthCheck) {
      // First pass: find out whether the CLI still holds a token, then ask for
      // the explicit go-ahead (design §3.2). The button re-enters with the
      // answer; the window is released (by the caller's finally) meanwhile.
      let tokenPresent = false;
      // A probe that throws is an unknown answer, never a dead end (#1133).
      if (flow.authCheck) {
        try {
          tokenPresent = (await (this.deps.checkAuth ?? checkAuthStatus)(flow.authCheck)) === "valid";
        } catch (err) {
          this.deps.logger.warn({ ...safeErr(err), backend }, "Auth pre-check failed; treating the token as absent");
        }
      }
      if (this.stale(generation, claim)) return t("login.web_shutting_down");
      this.deps.releaseWindow(claim);                       // nothing runs until the button is pressed
      const logoutFirst = tokenPresent && flow.preCommand?.when === "token-present";
      const publicLink = this.tunnelAllowed(cfg, flow);
      const confirmation = t(flow.deviceAuth ? "login.device_confirm" : "login.web_confirm", backend)
        + (publicLink ? t("login.tunnel_confirm_extra") : "");
      try {
        await this.deps.postButtons({
          prefix: "login-confirm:",
          instanceName: backend,
          chat,
          message: logoutFirst
            ? `${confirmation}\n${t("login.still_valid_precommand", backend, flow.preCommand!.command)}`
            : confirmation,
          choices: [
            // Consent is a separate, labelled button — never a side effect of the ordinary one.
            ...(publicLink ? [{ action: tokenPresent ? "go-relogin-tunnel" : "go-tunnel", label: t("login.tunnel_go") }] : []),
            {
              action: tokenPresent ? "go-relogin" : "go",
              label: publicLink ? t("login.tunnel_go_local") : t(flow.deviceAuth ? "login.device_confirm_go" : "login.web_confirm_go"),
            },
            { action: "cancel", label: t("login.relogin_cancel") },
          ],
          expiredText: t("buttons.stale"),
        });
      } catch (err) {
        this.deps.logger.warn({ ...safeErr(err), backend }, "Failed to post login confirmation");
        return t("login.failed", backend, t("login.web_confirm_failed"));
      }
      if (this.stale(generation, null)) {
        // The prompt went out while (or after) we stopped. It cannot be
        // withdrawn from here; a click on it starts a FRESH start() that runs
        // every check again (admin, allowlist, rate, claim, generation).
        this.audit("stale_confirmation", { backend, requester: chat.userId });
      }
      return null;
    }

    const userId = chat.userId as string;
    const wantTunnel = opts.tunnel === true;
    if (wantTunnel && !this.tunnelAllowed(cfg, flow)) {
      // A stale button, or the config was switched off after the prompt went out.
      this.audit("tunnel_refused", { backend, requester: userId });
      return t("login.tunnel_not_allowed", backend);
    }
    // Before any session or listener exists: a public link that cannot get its
    // cloudflared fails closed here, with nothing opened (#1137).
    let cloudflaredPath: string | undefined;
    if (wantTunnel) {
      // The window is claimed but no session exists yet: this owner is what
      // `/login cancel` and a shutdown reach while cloudflared downloads.
      const pending = { backend, abort: new AbortController() };
      this.pendingTunnelStart = pending;
      let got: Awaited<ReturnType<LoginController["obtainCloudflared"]>>;
      try {
        got = await this.obtainCloudflared(chat, backend, pending.abort.signal);
      } finally {
        if (this.pendingTunnelStart === pending) this.pendingTunnelStart = null;
      }
      if (this.stale(generation, claim)) return t("login.web_shutting_down");
      if (pending.abort.signal.aborted) {
        this.audit("tunnel_cancelled", { backend, requester: userId });
        return null;   // the cancel already answered
      }
      if (!got.ok) {
        this.audit("tunnel_failed", { backend, requester: userId, errorKind: got.kind });
        return t("login.tunnel_failed", t(`login.tunnel_reason.${got.kind}`));
      }
      cloudflaredPath = got.path;
    }
    const command = this.buildCommand(flow, opts.tokenPresent === true);
    const ttlMs = this.ttlMs(cfg);
    const spec: WebTerminalSpec = {
      kind: "login",
      backend,
      command,
      cwd: process.env.HOME ?? homedir(),
      ttlMs,
      observe: {
        urlPattern: flow.urlPattern,
        codePattern: flow.codePattern,
        deviceAuth: flow.deviceAuth,
        successPattern: flow.successPattern,
        failures: flow.failures,
      },
      requester: { adapterId: chat.adapterId, userId, chatId: chat.chatId, threadId: chat.threadId },
    };

    const logger = this.deps.logger;
    const entry: ActiveLogin = {
      claim, session: null as unknown as WebTerminalSession, http: null, backend, chat,
      requesterUserId: userId, url: "", tokenDelivered: false, silent: false, tunnel: null, cloudflaredPath,
    };
    const events: WebTerminalEvents = {
      // A public-link login never relays the provider's own sign-in URL/code to the channel: they are as
      // sensitive as the link and token that were kept out of it, the browser terminal already shows them,
      // and the channel is the one place this mode promises not to put anything. Local and device-auth
      // logins keep their contract.
      onHint: (url, code) => {
        if (wantTunnel) {
          this.audit("hint_not_relayed", { backend, requester: userId, hadCode: code !== null });
          return Promise.resolve();
        }
        return this.sendHint(chat, backend, url, code);
      },
      onDone: async result => {
        // The tunnel goes first and the window is held until it is confirmed gone: a login that
        // is over must not leave its listener reachable while the fleet believes it is free.
        await this.closeTunnel(entry);
        this.releaseEntry(entry);
        if (!entry.silent) await this.reportDone(chat, backend, result);
      },
      onAudit: (event, fields) => this.audit(event.replace(/^web_terminal_/, ""), fields),
    };
    // A throwing factory must not leak the claim: the caller's finally covers
    // it because `markTransferred` is only called once the entry is published.
    entry.session = (this.deps.createSession ?? ((s, e, l) => new WebTerminalSession(s, e, this.backendFactory, l)))(spec, events, logger);
    this.active = entry;
    markTransferred();                                      // from here the entry owns the claim (onDone/abort/shutdown release it)
    this.noteStart(userId);

    try {
      await entry.session.start();
      if (this.stale(generation, claim)) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
      // Device auth needs only the provider link/code emitted by onHint.
      // Keep the engine's TTL, cancellation and recovery, without exposing a
      // second browser terminal URL or sending an unused access token.
      if (flow.deviceAuth) return t("login.started", backend);
      const http = (this.deps.createHttp ?? ((s, l, o) => new WebTerminalHttpServer(s, l, o)))(entry.session, logger, {
        bind: cfg?.web_terminal?.bind,
        hostname: cfg?.hostname || "localhost",
        allowedHosts: allowedHostNames(cfg),
      });
      entry.http = http;
      const listening = await http.listen();
      entry.url = listening.url;
      if (this.stale(generation, claim)) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
      if (wantTunnel) {
        const failed = await this.openTunnel(entry, http, listening.port, cfg, ttlMs);
        if (failed !== null) return failed;
        if (this.stale(generation, claim)) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
      }
    } catch (err) {
      // In public mode the text is fixed: nothing a provider or the network said goes to the chat.
      return this.abort(entry, wantTunnel
        ? t("login.tunnel_failed", t("login.tunnel_reason.other"))
        : t("login.failed", backend, (err as Error).message), "startup failed");
    }

    // Delivery is part of starting: a link nobody received, or a token that
    // reached neither the requester nor a resend button, means the session
    // must not stay open (sol M1). A shutdown landing during any of these
    // awaits aborts instead of announcing a terminal that no longer exists.
    if (this.stale(generation, claim)) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
    if (entry.tunnel) {
      // Public mode never uses the channel for the link or the token (D-b): two private
      // messages or nothing. The caller posts the one-line status we return.
      const minutes = Math.round(ttlMs / 60_000);
      if (!(await this.sendTunnelLink(entry, minutes, command)) || !(await this.sendToken(entry, { offerResend: false }))) {
        return this.abort(entry, t("login.tunnel_dm_failed"), "private delivery failed");
      }
      if (this.stale(generation, claim)) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
      this.audit("tunnel_delivered", { backend, requester: userId });
      return t("login.tunnel_started", backend, String(minutes));
    }
    if (!(await this.sendLink(entry, Math.round(ttlMs / 60_000), command))) {
      return this.abort(entry, t("login.failed", backend, t("login.web_link_failed")), "link delivery failed");
    }
    if (this.stale(generation, claim)) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
    if (!(await this.sendToken(entry, { offerResend: true }))) {
      return this.abort(entry, t("login.failed", backend, t("login.web_token_failed")), "token delivery failed");
    }
    if (this.stale(generation, claim)) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
    return t("login.web_started", backend);
  }

  /** `/login cancel` in web mode. */
  async cancel(): Promise<string> {
    if (!this.active && this.pendingTunnelStart) {
      // Still getting cloudflared: stop the download; the start sees the abort and opens nothing.
      const { backend, abort } = this.pendingTunnelStart;
      abort.abort();
      return t("login.cancelled", backend);
    }
    if (!this.active) return t("login.no_session");
    const backend = this.active.backend;
    await this.active.session.cancel("cancelled");
    return t("login.cancelled", backend);
  }

  /**
   * Fleet shutdown: end the active session and wait for the confirmed tmux
   * kill (sol B3). Pre-active continuations (a start parked in its pre-check)
   * are fenced by the lock being closed by FleetManager before this call —
   * they observe !isClaimCurrent and stop without posting or starting.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.shutdownGeneration++;
    this.pendingTunnelStart?.abort.abort();
    const entry = this.active;
    if (!entry) return;
    entry.silent = true;
    // No timer race here: cancel() is single-flight and bounded by the
    // engine's own per-op timeouts (abort → ≤1 more 10 s stage → confirmed
    // kill ≤31 s). Releasing ownership early would let the fleet exit while
    // the dedicated tmux server is still being torn down.
    await entry.session.cancel("fleet shutdown").catch(err => this.deps.logger.warn(safeErr(err), "web login shutdown failed"));
    await this.closeTunnel(entry);
    await entry.http?.close().catch(() => { /* already closed on finish */ });
    this.releaseEntry(entry);
  }

  /** In-process restart after shutdown(): accept work again. */
  reopen(): void { this.stopping = false; }

  /** The "resend token" button: only the requester, only while the token is unredeemed. */
  async resendToken(requesterUserId: string | undefined): Promise<string> {
    const entry = this.active;
    if (!entry || !entry.http) return t("login.no_session");
    if (!requesterUserId || requesterUserId !== entry.requesterUserId) {
      this.audit("token_resend_denied", { backend: entry.backend, requester: requesterUserId ?? null });
      return t("permission.denied");
    }
    if (entry.session.peekAccessToken() === null) return t("login.web_token_already_used");
    const ok = await this.sendToken(entry, { offerResend: false, isResend: true });
    if (ok) return t("login.web_token_resent");
    // The one recovery route failed too: do not leave a token-less session
    // holding the fleet-wide window until TTL (sol M1). Close it now.
    return this.abort(entry, t("login.web_token_resend_failed", entry.backend), "token resend failed");
  }

  // ── Internals ──

  private admitRate(userId: string): boolean {
    const now = (this.deps.now ?? Date.now)();
    const recent = (this.startTimes.get(userId) ?? []).filter(ts => now - ts < START_RATE_WINDOW_MS);
    this.startTimes.set(userId, recent);
    return recent.length < START_RATE_LIMIT;
  }

  private noteStart(userId: string): void {
    const now = (this.deps.now ?? Date.now)();
    this.startTimes.set(userId, [...(this.startTimes.get(userId) ?? []), now]);
  }

  private releaseEntry(entry: ActiveLogin): void {
    if (this.active === entry) this.active = null;          // identity guard: never clear a newer owner
    this.deps.releaseWindow(entry.claim);
  }

  /** Startup/delivery failure: end the session quietly and hand the caller the one report. */
  private async abort(entry: ActiveLogin, report: string, detail: string): Promise<string> {
    entry.silent = true;
    if (entry.session.state === "running") {
      await entry.session.cancel(detail).catch(err => this.deps.logger.warn(safeErr(err), "web login abort failed"));
    }
    await this.closeTunnel(entry);
    await entry.http?.close().catch(() => { /* closed on finish */ });
    this.releaseEntry(entry);
    this.audit("aborted", { backend: entry.backend, requester: entry.requesterUserId, detail });
    return report;
  }

  // ── Public link ──

  /**
   * Whether this flow may be offered over a public tunnel right now. Every term is required, and
   * the answer is recomputed at both ends of the button press.
   */
  private tunnelAllowed(cfg: FleetConfig | null, flow: LoginFlow): boolean {
    if (flow.tunnelOk !== true || flow.noShellEscape !== true || flow.deviceAuth) return false;
    if (cfg?.web_terminal?.enabled === false) return false;
    // Offered unless the operator switched it off (#1137): pressing the button,
    // every login, is the consent. `allow_public: false` is the host's kill switch.
    if (cfg?.web_terminal?.tunnel?.allow_public === false) return false;
    return this.deps.createTunnel !== undefined || this.deps.tunnelDataDir !== undefined;
  }

  /**
   * The cloudflared for a public link, reported in chat while it downloads. Never throws: a
   * failure is one of the allowlisted kinds, worded by the locale (no provider text reaches chat).
   */
  private async obtainCloudflared(chat: LoginChat, backend: string, signal: AbortSignal): Promise<{ ok: true; path?: string } | { ok: false; kind: string }> {
    const ensure = this.deps.ensureCloudflared
      ?? (this.deps.createTunnel ? null : (onDownloading: (info: { version: string; asset: string }) => Promise<void>, abortSignal: AbortSignal) =>
        ensureCloudflared({ dataDir: this.deps.tunnelDataDir!(), onDownloading, signal: abortSignal }));
    if (!ensure) return { ok: true };
    try {
      const got = await ensure(async ({ version }) => {
        await chat.adapter.sendText(chat.chatId, t("login.tunnel_downloading", version), { threadId: chat.threadId })
          .catch(err => this.deps.logger.warn(safeErr(err), "could not post the cloudflared download notice"));
      }, signal);
      return { ok: true, path: got.path };
    } catch (err) {
      this.deps.logger.warn({ backend, kind: (err as { kind?: string }).kind, detail: (err as Error).message }, "cloudflared for a public link is unavailable");
      return { ok: false, kind: tunnelErrorKind((err as { kind?: unknown }).kind) };
    }
  }

  private tunnelPort(cfg: FleetConfig | null, binaryPath?: string): LoginTunnelPort {
    if (this.deps.createTunnel) return this.deps.createTunnel(cfg);
    const dataDir = this.deps.tunnelDataDir!();
    this.managedTunnel ??= new ManagedTunnel({ dataDir, log: m => this.deps.logger.info({}, m) });
    const managed = this.managedTunnel;
    const provider = new CloudflaredProvider({ protocol: cfg?.web_terminal?.tunnel?.protocol, binaryName: binaryPath });
    return { start: ctx => managed.start(provider, ctx), stop: reason => managed.stop(reason) };
  }

  /**
   * Put a tunnel in front of this session's listener. Returns null on success, or the report to
   * hand the caller after the session has been aborted.
   */
  private async openTunnel(
    entry: ActiveLogin, http: WebTerminalHttpServer, port: number, cfg: FleetConfig | null, ttlMs: number,
  ): Promise<string | null> {
    const abort = new AbortController();
    const tunnel = { port: this.tunnelPort(cfg, entry.cloudflaredPath), abort, starting: null as Promise<ManagedStartResult> | null, handle: null as TunnelHandle | null, closing: null as Promise<void> | null };
    entry.tunnel = tunnel;
    this.audit("tunnel_requested", { backend: entry.backend, requester: entry.requesterUserId });
    tunnel.starting = tunnel.port.start({
      sid: newTunnelSid(),
      origin: new URL(`http://127.0.0.1:${port}`),
      pagePath: new URL(entry.url).pathname,
      readinessMarker: http.readinessMarker,
      expiresAt: (this.deps.now ?? Date.now)() + ttlMs,
      signal: abort.signal,
      // The provider's readiness probe arrives under the public host: the listener has to
      // expect exactly that one name before it, and drop it again if no tunnel results.
      onCandidateHost: host => http.setExternalHost(host),
    });
    let result: ManagedStartResult;
    try {
      result = await tunnel.starting;
    } catch (err) {
      http.setExternalHost(null);
      const kind = tunnelErrorKind((err as { errorKind?: unknown } | null)?.errorKind);
      this.audit("tunnel_failed", { backend: entry.backend, requester: entry.requesterUserId, errorKind: kind });
      return this.abort(entry, t("login.tunnel_failed", t(`login.tunnel_reason.${kind}`)), "tunnel failed");
    }
    // The login ended (cancel, TTL, shutdown) while the tunnel was coming up: closeTunnel is already
    // on its way to stop it, and nothing here may re-publish a host it just took away.
    if (tunnel.closing !== null) {
      return this.abort(entry, t("login.cancelled", entry.backend), "closed while the tunnel was starting");
    }
    if (!result.ok) {
      http.setExternalHost(null);
      const kind = tunnelErrorKind(result.errorKind);
      this.audit("tunnel_failed", { backend: entry.backend, requester: entry.requesterUserId, errorKind: kind, leaseHeld: result.leaseHeld });
      // Only the allowlisted kind becomes words: `result.message` is the provider's own text, and a TLS or
      // network error in it can carry the tunnel's random host name straight into the channel.
      // `leaseHeld`: a tunnel process exists that nobody can account for. Not a fallback — a stop.
      const report = result.leaseHeld
        ? t("login.tunnel_unconfirmed", "", t("login.tunnel_reason.lease-held"))
        : t("login.tunnel_failed", t(`login.tunnel_reason.${kind}`));
      return this.abort(entry, report, "tunnel failed");
    }
    tunnel.handle = result.handle;
    http.setExternalHost(new URL(result.handle.baseUrl).host);
    entry.url = result.handle.pageUrl;
    result.handle.onUnexpectedExit(() => {
      this.audit("tunnel_lost", { backend: entry.backend, requester: entry.requesterUserId });
      // The page is gone the moment the tunnel is: end the login rather than leave a window open on nothing.
      void entry.session.cancel(t("login.tunnel_lost")).catch(err => this.deps.logger.warn(safeErr(err), "web login tunnel-loss cancel failed"));
    });
    return null;
  }

  /** Idempotent: every end of a public-link login funnels through here, and the second caller joins the first. */
  private closeTunnel(entry: ActiveLogin): Promise<void> {
    const tunnel = entry.tunnel;
    if (!tunnel) return Promise.resolve();
    tunnel.closing ??= this.doCloseTunnel(entry, tunnel);
    return tunnel.closing;
  }

  private async doCloseTunnel(entry: ActiveLogin, tunnel: NonNullable<ActiveLogin["tunnel"]>): Promise<void> {
    // Nothing may reach this listener under the public name from here on, whatever the process does next.
    entry.http?.setExternalHost(null);
    tunnel.abort.abort();
    // A start still in flight is cancelled by the abort and settles after proving its child gone; stopping
    // before it settles would find nothing active and let the start finish into a tunnel nobody owns.
    await tunnel.starting?.catch(() => { /* reported by openTunnel */ });
    let result: TunnelStopResult;
    try {
      result = await tunnel.port.stop("login ended");
    } catch {
      result = { confirmed: false, reason: "stopping the tunnel threw", pid: null, identity: null };
    }
    // Again, after the stop: whatever ran in between, the public name is not this listener's any more.
    entry.http?.setExternalHost(null);
    if (result.confirmed) {
      this.audit("tunnel_closed", { backend: entry.backend, requester: entry.requesterUserId });
      return;
    }
    this.audit("tunnel_unconfirmed", { backend: entry.backend, requester: entry.requesterUserId, pid: result.pid });
    this.deps.logger.error({ pid: result.pid }, "login tunnel could not be confirmed stopped");
    const where = result.pid !== null ? ` (pid ${result.pid})` : "";
    await entry.chat.adapter.sendText(entry.chat.chatId, t("login.tunnel_unconfirmed", where, t("login.tunnel_reason.stop-unconfirmed")), { threadId: entry.chat.threadId })
      .catch(() => { /* chat gone; the log line above stands */ });
  }

  /** First of the two private messages: the public link. Never the channel. Returns delivery success. */
  private async sendTunnelLink(entry: ActiveLogin, ttlMinutes: number, command: string): Promise<boolean> {
    const { chat } = entry;
    if (typeof chat.adapter.sendDirect !== "function") {
      this.audit("tunnel_link_failed", { backend: entry.backend, requester: entry.requesterUserId, via: "none" });
      return false;
    }
    try {
      await chat.adapter.sendDirect(entry.requesterUserId, t("login.tunnel_link", entry.backend, String(ttlMinutes), command, entry.url), {
        format: "text",
        disablePreview: true,
      });
      this.audit("tunnel_link_sent", { backend: entry.backend, requester: entry.requesterUserId, via: "dm" });
      return true;
    } catch (err) {
      // Never the message: a provider error may echo the payload (the URL).
      this.deps.logger.warn({ ...safeErr(err), backend: entry.backend }, "web terminal tunnel link DM failed");
      this.audit("tunnel_link_failed", { backend: entry.backend, requester: entry.requesterUserId, via: "dm", ...safeErr(err) });
      return false;
    }
  }

  private buildCommand(flow: LoginFlow, tokenPresent: boolean): string {
    const pre = flow.preCommand;
    const runPre = pre && (pre.when === "always" || (pre.when === "token-present" && tokenPresent));
    return runPre ? `${pre.command}; ${flow.command}` : flow.command;
  }

  private ttlMs(cfg: FleetConfig | null): number {
    const minutes = cfg?.web_terminal?.ttl_minutes ?? DEFAULT_WEB_TERMINAL_TTL_MINUTES;
    const clamped = Math.min(Math.max(1, Math.floor(minutes)), MAX_TTL_MS / 60_000);
    return clamped * 60_000;
  }

  /** The link carries no secret: it may go to the requesting chat. Returns delivery success. */
  private async sendLink(entry: ActiveLogin, ttlMinutes: number, command: string): Promise<boolean> {
    const { chat } = entry;
    const text = t("login.web_link", entry.backend, String(ttlMinutes), command, entry.url);
    try {
      await chat.adapter.sendText(chat.chatId, text, { threadId: chat.threadId, disablePreview: true });
      this.audit("link_sent", { backend: entry.backend, requester: entry.requesterUserId, host: hostOf(entry.url) });
      return true;
    } catch (err) {
      this.deps.logger.warn({ ...safeErr(err), backend: entry.backend }, "Failed to deliver web terminal link");
      this.audit("link_failed", { backend: entry.backend, requester: entry.requesterUserId, ...safeErr(err) });
      return false;
    }
  }

  /**
   * The access token goes ONLY to the requester, privately. Never into the
   * channel: if the private route fails, offer a resend button instead.
   * Returns true when the token was delivered OR the resend button was posted.
   */
  private async sendToken(entry: ActiveLogin, o: { offerResend: boolean; isResend?: boolean }): Promise<boolean> {
    const { chat } = entry;
    const token = entry.session.peekAccessToken();
    if (token === null) return true;                          // already redeemed: nothing to deliver
    const body = chat.adapter.type === "telegram"
      ? `${escapeHtml(t("login.web_token", entry.backend))}\n<tg-spoiler>${escapeHtml(token)}</tg-spoiler>`
      : `${t("login.web_token", entry.backend)}\n\`${token}\``;
    if (typeof chat.adapter.sendDirect === "function") {
      try {
        await chat.adapter.sendDirect(entry.requesterUserId, body, {
          format: chat.adapter.type === "telegram" ? "html" : "text",
          disablePreview: true,
        });
        entry.tokenDelivered = true;
        this.audit(o.isResend ? "token_resent" : "token_sent", { backend: entry.backend, requester: entry.requesterUserId, via: "dm" });
        return true;
      } catch (err) {
        // Never the message: a provider error may echo the payload (the token).
        this.deps.logger.warn({ ...safeErr(err), backend: entry.backend }, "web terminal token DM failed");
      }
    }
    entry.tokenDelivered = false;
    this.audit("token_dm_failed", { backend: entry.backend, requester: entry.requesterUserId });
    if (!o.offerResend) return false;
    try {
      await this.deps.postButtons({
        prefix: LOGIN_TOKEN_RESEND_PREFIX,
        instanceName: entry.backend,
        chat,
        message: t("login.web_token_dm_failed"),
        choices: [{ action: "resend", label: t("login.web_resend") }],
        expiredText: t("buttons.stale"),
      });
      return true;
    } catch (err) {
      this.deps.logger.warn({ ...safeErr(err), backend: entry.backend }, "Failed to post token resend button");
      return false;
    }
  }

  /** Device URL (+ code) observed in the pane: same spoiler treatment as before. Errors logged without the message. */
  private async sendHint(chat: LoginChat, backend: string, url: string, code: string | null): Promise<void> {
    const codeLine = code ? `\n${t("login.auth_code", code)}` : "";
    try {
      if (chat.adapter.type === "telegram") {
        await chat.adapter.sendText(chat.chatId,
          `${escapeHtml(t("login.auth_hint", backend))}\n<tg-spoiler>${escapeHtml(url)}${escapeHtml(codeLine)}</tg-spoiler>`,
          { threadId: chat.threadId, format: "html" });
      } else {
        await chat.adapter.sendText(chat.chatId, `${t("login.auth_hint", backend)}\n${url}${codeLine}`, { threadId: chat.threadId });
      }
    } catch (err) {
      this.deps.logger.warn({ ...safeErr(err), backend }, "Failed to deliver login URL");
    }
  }

  private async reportDone(chat: LoginChat, backend: string, result: WebTerminalResult): Promise<void> {
    const send = (text: string) =>
      chat.adapter.sendText(chat.chatId, text, { threadId: chat.threadId }).catch(() => { /* chat gone */ });

    let text: string;
    if (result.ok) {
      // Say the login worked BEFORE bringing the instances back. This used to
      // wait for the whole recovery first, so a slow restart meant the user was
      // told nothing at all — and concluded the login itself had hung.
      await send(t("login.completed", backend));
      await announcePostLoginRecovery(backend, () => this.deps.recoverBackendInstances(backend), send);
      if (result.cleanupFailed) await send(t("login.web_cleanup_failed", backend));
      return;
    }
    if (result.reason === "cancel" && result.detail === "cancelled") {
      text = "";                                              // the cancel command's own reply already announced this
    } else {
      text = t("login.failed", backend, result.detail);
      if (result.suggest === "relogin") text += `\n${t("login.web_suggest_relogin")}`;
      else if (result.suggest === "check-args") text += `\n${t("login.web_suggest_check_args")}`;
    }
    if (result.cleanupFailed) text += `${text ? "\n" : ""}${t("login.web_cleanup_failed", backend)}`;
    if (!text) return;
    await chat.adapter.sendText(chat.chatId, text, { threadId: chat.threadId }).catch(() => { /* chat gone */ });
  }

  private audit(event: string, fields: Record<string, unknown>): void {
    try { this.deps.eventLog()?.insert("login", `login_web_${event}`, fields); } catch { /* never break the flow */ }
  }
}

/**
 * The only tunnel failure vocabulary that reaches a chat. A provider's message is free text — it can
 * contain the tunnel's host (a TLS name mismatch does) — so it is mapped to one of these kinds, each of
 * which has a fixed sentence in the locale table, and anything unrecognised becomes "other".
 */
const TUNNEL_ERROR_KINDS: ReadonlySet<string> = new Set([
  "binary-missing", "binary-not-executable", "not-logged-in", "spawn-failed", "no-url",
  "bad-url", "readiness-failed", "timeout", "cancelled", "lease-held",
  // AgEnD's own cloudflared (#1137)
  "unsupported-platform", "download-failed", "checksum-mismatch", "install-failed",
]);
function tunnelErrorKind(kind: unknown): string {
  return typeof kind === "string" && TUNNEL_ERROR_KINDS.has(kind) ? kind : "other";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "?"; }
}
