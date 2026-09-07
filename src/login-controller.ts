/**
 * Remote `/login` in web-terminal mode (v2.1.5, design docs/design/login-relay-v2).
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
 *     first await (LoginWindowLock, shared with relay login and install)
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

export const LOGIN_TOKEN_RESEND_PREFIX = "login-token:";
export const DEFAULT_WEB_TERMINAL_TTL_MINUTES = 10;
/** Design §3.1: a requester may create at most this many sessions per window. */
export const START_RATE_LIMIT = 3;
export const START_RATE_WINDOW_MS = 5 * 60_000;
const SHUTDOWN_WAIT_MS = 10_000;

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
}

export interface LoginControllerDeps {
  logger: TerminalLogger & { error(obj: unknown, msg?: string): void };
  fleetConfig: () => FleetConfig | null;
  isFleetAdmin(userId: string, adapterId?: string): boolean;
  /** Event log sink; instance column is "login". */
  eventLog: () => { insert(instance: string, type: string, payload?: Record<string, unknown>): void } | null;
  /** Wake/restart the backend's instances after a successful login. */
  recoverBackendInstances(backend: string): Promise<{ woken: string[]; restarted: string[] }>;
  /** Post nonce buttons (FleetManager.postNonceButtonPrompt). Rejects when the platform refused. */
  postButtons(opts: {
    prefix: string; instanceName: string; chat: LoginChat; message: string;
    choices: Array<{ action: string; label: string }>; expiredText: string;
  }): Promise<void>;
  /** Fleet-wide window reservation (shared with relay login and install). */
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
  /** The caller already reported this session's end (startup/delivery failure, shutdown): onDone stays quiet. */
  silent: boolean;
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
  /** Set by shutdown(): fences every continuation that resumes after an await, independent of claim ownership. */
  private stopping = false;
  private readonly backendFactory = new TmuxTerminalBackend();
  private readonly startTimes = new Map<string, number[]>();

  constructor(private readonly deps: LoginControllerDeps) {}

  isActive(): boolean { return this.active !== null; }
  get activeBackend(): string | null { return this.active?.backend ?? null; }

  /** Configured mode; web is the default, relay is the 2.1.5-only rollback. */
  mode(): "web" | "relay" {
    return this.deps.fleetConfig()?.login?.mode === "relay" ? "relay" : "web";
  }

  /**
   * Start a web-terminal login. Returns a status line, or null when the
   * confirmation buttons were posted instead (every start is confirmed once;
   * the button calls back with skipAuthCheck + tokenPresent).
   */
  async start(backendArg: string, chat: LoginChat, opts: LoginStartOptions = {}): Promise<string | null> {
    const backend = LOGIN_BACKEND_ALIASES[backendArg.toLowerCase()] ?? backendArg.toLowerCase();
    const flow = LOGIN_FLOWS[backend];
    if (!flow) return t("login.unsupported", backendArg);

    if (this.stopping) return t("login.web_shutting_down");
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
      return await this.startClaimed(flow, backend, chat, opts, cfg, claim, () => { transferred = true; });
    } finally {
      if (!transferred) this.deps.releaseWindow(claim);
    }
  }

  private async startClaimed(
    flow: LoginFlow, backend: string, chat: LoginChat, opts: LoginStartOptions, cfg: FleetConfig | null,
    claim: LoginWindowClaim, markTransferred: () => void,
  ): Promise<string | null> {
    if (!opts.skipAuthCheck) {
      // First pass: find out whether the CLI still holds a token, then ask for
      // the explicit go-ahead (design §3.2). The button re-enters with the
      // answer; the window is released (by the caller's finally) meanwhile.
      let tokenPresent = false;
      if (flow.authCheck) tokenPresent = (await (this.deps.checkAuth ?? checkAuthStatus)(flow.authCheck)) === "valid";
      if (this.stopping || !this.deps.isClaimCurrent(claim)) return t("login.web_shutting_down");
      this.deps.releaseWindow(claim);                       // nothing runs until the button is pressed
      const logoutFirst = tokenPresent && flow.preCommand?.when === "token-present";
      try {
        await this.deps.postButtons({
          prefix: "login-confirm:",
          instanceName: backend,
          chat,
          message: logoutFirst
            ? `${t("login.web_confirm", backend)}\n${t("login.still_valid_precommand", backend, flow.preCommand!.command)}`
            : t("login.web_confirm", backend),
          choices: [
            { action: tokenPresent ? "go-relogin" : "go", label: t("login.web_confirm_go") },
            { action: "cancel", label: t("login.relogin_cancel") },
          ],
          expiredText: t("buttons.stale"),
        });
      } catch (err) {
        this.deps.logger.warn({ ...safeErr(err), backend }, "Failed to post login confirmation");
        return t("login.failed", backend, t("login.web_confirm_failed"));
      }
      if (this.stopping) this.audit("stale_confirmation", { backend, requester: chat.userId });   // posted as we stopped; it will simply not be honoured
      return null;
    }

    const userId = chat.userId as string;
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
        successPattern: flow.successPattern,
        failures: flow.failures,
      },
      requester: { adapterId: chat.adapterId, userId, chatId: chat.chatId, threadId: chat.threadId },
    };

    const logger = this.deps.logger;
    const entry: ActiveLogin = {
      claim, session: null as unknown as WebTerminalSession, http: null, backend, chat,
      requesterUserId: userId, url: "", tokenDelivered: false, silent: false,
    };
    const events: WebTerminalEvents = {
      onHint: (url, code) => this.sendHint(chat, backend, url, code),
      onDone: async result => {
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
      if (!this.deps.isClaimCurrent(claim)) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
      const http = (this.deps.createHttp ?? ((s, l, o) => new WebTerminalHttpServer(s, l, o)))(entry.session, logger, {
        bind: cfg?.web_terminal?.bind,
        hostname: cfg?.hostname || "localhost",
      });
      entry.http = http;
      entry.url = (await http.listen()).url;
      if (!this.deps.isClaimCurrent(claim)) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
    } catch (err) {
      return this.abort(entry, t("login.failed", backend, (err as Error).message), "startup failed");
    }

    // Delivery is part of starting: a link nobody received, or a token that
    // reached neither the requester nor a resend button, means the session
    // must not stay open (sol M1). A shutdown landing during any of these
    // awaits aborts instead of announcing a terminal that no longer exists.
    if (this.stopping) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
    if (!(await this.sendLink(entry, Math.round(ttlMs / 60_000), command))) {
      return this.abort(entry, t("login.failed", backend, t("login.web_link_failed")), "link delivery failed");
    }
    if (this.stopping) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
    if (!(await this.sendToken(entry, { offerResend: true }))) {
      return this.abort(entry, t("login.failed", backend, t("login.web_token_failed")), "token delivery failed");
    }
    if (this.stopping) return this.abort(entry, t("login.web_shutting_down"), "fleet shutdown");
    return t("login.web_started", backend);
  }

  /** `/login cancel` in web mode. */
  async cancel(): Promise<string> {
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
    const entry = this.active;
    if (!entry) return;
    entry.silent = true;
    await Promise.race([
      entry.session.cancel("fleet shutdown").catch(err => this.deps.logger.warn(safeErr(err), "web login shutdown failed")),
      new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref?.()),
    ]);
    await entry.http?.close().catch(() => { /* already closed on finish */ });
    this.releaseEntry(entry);
  }

  /** In-process restart after shutdown(): accept work again. */
  reopen(): void { this.stopping = false; }

  /** The "resend token" button: only the requester, only while the token is unredeemed. */
  async resendToken(requesterUserId: string | undefined): Promise<string> {
    const entry = this.active;
    if (!entry) return t("login.no_session");
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
    await entry.http?.close().catch(() => { /* closed on finish */ });
    this.releaseEntry(entry);
    this.audit("aborted", { backend: entry.backend, requester: entry.requesterUserId, detail });
    return report;
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
    let text: string;
    if (result.ok) {
      const { woken, restarted } = await this.deps.recoverBackendInstances(backend);
      const none = t("login.none");
      text = t("login.success", backend, woken.length ? woken.join(", ") : none, restarted.length ? restarted.join(", ") : none);
    } else if (result.reason === "cancel" && result.detail === "cancelled") {
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "?"; }
}
