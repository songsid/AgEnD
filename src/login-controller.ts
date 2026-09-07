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
 *   - one login/install window fleet-wide (web, legacy relay, install)
 *   - the link (no secret) goes to the requesting chat; the one-time access
 *     token goes ONLY to the requester privately (adapter.sendDirect). If the
 *     private route fails the token is never posted in the channel: the admin
 *     gets a "resend" button after enabling DMs.
 *   - every step is audited to the event log without token/cookie/URL secrets.
 */
import { homedir } from "node:os";
import type { ChannelAdapter } from "./channel/types.js";
import type { FleetConfig } from "./types.js";
import { LOGIN_BACKEND_ALIASES, LOGIN_FLOWS, checkAuthStatus, type AuthCheck, type AuthCheckResult, type LoginFlow } from "./login-flows.js";
import { t } from "./locale.js";
import {
  MAX_TTL_MS, TmuxTerminalBackend, WebTerminalSession,
  type TerminalLogger, type WebTerminalEvents, type WebTerminalResult, type WebTerminalSpec,
} from "./web-terminal.js";
import { WebTerminalHttpServer, type WebTerminalHttpOptions } from "./web-terminal-http.js";

export const LOGIN_TOKEN_RESEND_PREFIX = "login-token:";
export const DEFAULT_WEB_TERMINAL_TTL_MINUTES = 10;

export interface LoginChat {
  adapter: ChannelAdapter;
  adapterId: string;
  chatId: string;
  threadId?: string;
  /** The human who issued the command / pressed the button. Required in web mode. */
  userId?: string;
}

export interface LoginControllerDeps {
  logger: TerminalLogger & { error(obj: unknown, msg?: string): void };
  fleetConfig: () => FleetConfig | null;
  isFleetAdmin(userId: string, adapterId?: string): boolean;
  /** Event log sink; instance column is "login". */
  eventLog: () => { insert(instance: string, type: string, payload?: Record<string, unknown>): void } | null;
  /** Wake/restart the backend's instances after a successful login. */
  recoverBackendInstances(backend: string): Promise<{ woken: string[]; restarted: string[] }>;
  /** Post nonce buttons (FleetManager.postNonceButtonPrompt). */
  postButtons(opts: {
    prefix: string; instanceName: string; chat: LoginChat; message: string;
    choices: Array<{ action: string; label: string }>; expiredText: string;
  }): Promise<void>;
  /** True when a legacy relay login or an install window is active. */
  otherWindowActive(): boolean;
  // Injection seams (tests): default to the real engine.
  checkAuth?: (check: AuthCheck) => Promise<AuthCheckResult>;
  createSession?: (spec: WebTerminalSpec, events: WebTerminalEvents, logger: TerminalLogger) => WebTerminalSession;
  createHttp?: (session: WebTerminalSession, logger: TerminalLogger, opts: WebTerminalHttpOptions) => WebTerminalHttpServer;
}

interface ActiveLogin {
  session: WebTerminalSession;
  http: WebTerminalHttpServer;
  backend: string;
  chat: LoginChat;
  requesterUserId: string;
  url: string;
  tokenDelivered: boolean;
}

export class LoginController {
  private active: ActiveLogin | null = null;
  private readonly backendFactory = new TmuxTerminalBackend();

  constructor(private readonly deps: LoginControllerDeps) {}

  isActive(): boolean { return this.active !== null; }
  get activeBackend(): string | null { return this.active?.backend ?? null; }

  /** Configured mode; web is the default, relay is the 2.1.5-only rollback. */
  mode(): "web" | "relay" {
    return this.deps.fleetConfig()?.login?.mode === "relay" ? "relay" : "web";
  }

  /**
   * Start a web-terminal login. Returns a status line, or null when the
   * still-valid-auth confirmation buttons were posted instead.
   * `skipAuthCheck` is set by the confirmation button, i.e. the pre-check said
   * the CLI still holds a token — which is exactly when a flow's
   * `preCommand: { when: "token-present" }` (kiro logout) must run.
   */
  async start(backendArg: string, chat: LoginChat, opts: { skipAuthCheck?: boolean } = {}): Promise<string | null> {
    const backend = LOGIN_BACKEND_ALIASES[backendArg.toLowerCase()] ?? backendArg.toLowerCase();
    const flow = LOGIN_FLOWS[backend];
    if (!flow) return t("login.unsupported", backendArg);

    // Authorization is decided HERE, not by whoever called us.
    if (!chat.userId || !this.deps.isFleetAdmin(chat.userId, chat.adapterId)) {
      this.audit("denied", { backend, requester: chat.userId ?? null, adapterId: chat.adapterId });
      return t("permission.denied");
    }
    const cfg = this.deps.fleetConfig();
    if (cfg?.web_terminal?.enabled === false) return t("login.web_disabled");
    if (this.active) return t("login.busy", this.active.backend);
    if (this.deps.otherWindowActive()) return t("install.busy");

    let tokenPresent = opts.skipAuthCheck === true;
    if (!opts.skipAuthCheck && flow.authCheck) {
      const status = await (this.deps.checkAuth ?? checkAuthStatus)(flow.authCheck);
      if (status === "valid") {
        await this.deps.postButtons({
          prefix: "login-confirm:",
          instanceName: backend,
          chat,
          message: flow.preCommand?.when === "token-present"
            ? t("login.still_valid_precommand", backend, flow.preCommand.command)
            : t("login.still_valid", backend),
          choices: [
            { action: "go", label: t("login.relogin_go") },
            { action: "cancel", label: t("login.relogin_cancel") },
          ],
          expiredText: t("buttons.stale"),
        });
        return null;
      }
      tokenPresent = false;
    }

    const command = this.buildCommand(flow, tokenPresent);
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
      requester: { adapterId: chat.adapterId, userId: chat.userId, chatId: chat.chatId, threadId: chat.threadId },
    };

    const logger = this.deps.logger;
    let entry: ActiveLogin | null = null;
    const events: WebTerminalEvents = {
      onHint: (url, code) => this.sendHint(chat, backend, url, code),
      onDone: async result => {
        if (this.active === entry) this.active = null;
        await this.reportDone(chat, backend, result);
      },
      onAudit: (event, fields) => this.audit(event.replace(/^web_terminal_/, ""), fields),
    };
    const session = (this.deps.createSession ?? ((s, e, l) => new WebTerminalSession(s, e, this.backendFactory, l)))(spec, events, logger);
    // Claim the slot before the first await so two admins racing /login cannot both start.
    entry = { session, http: null as unknown as WebTerminalHttpServer, backend, chat, requesterUserId: chat.userId, url: "", tokenDelivered: false };
    this.active = entry;
    try {
      await session.start();
      const http = (this.deps.createHttp ?? ((s, l, o) => new WebTerminalHttpServer(s, l, o)))(session, logger, {
        bind: cfg?.web_terminal?.bind,
        hostname: cfg?.hostname || "localhost",
      });
      entry.http = http;
      const { url } = await http.listen();
      entry.url = url;
    } catch (err) {
      this.active = null;
      if (session.state === "running") await session.cancel("startup failed").catch(() => { /* reported via onDone */ });
      return t("login.failed", backend, (err as Error).message);
    }

    await this.sendLink(entry, Math.round(ttlMs / 60_000), command);
    await this.sendToken(entry);
    return t("login.web_started", backend);
  }

  /** `/login cancel` in web mode. */
  async cancel(): Promise<string> {
    if (!this.active) return t("login.no_session");
    const backend = this.active.backend;
    await this.active.session.cancel("cancelled");
    return t("login.cancelled", backend);
  }

  /** The "resend token" button: only the requester, only while the token is unredeemed. */
  async resendToken(requesterUserId: string | undefined): Promise<string> {
    const entry = this.active;
    if (!entry) return t("login.no_session");
    if (!requesterUserId || requesterUserId !== entry.requesterUserId) {
      this.audit("token_resend_denied", { backend: entry.backend, requester: requesterUserId ?? null });
      return t("permission.denied");
    }
    if (entry.session.peekAccessToken() === null) return t("login.web_token_already_used");
    await this.sendToken(entry, true);
    return entry.tokenDelivered ? t("login.web_token_resent") : t("login.web_token_dm_failed");
  }

  // ── Internals ──

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

  /** The link carries no secret: it may go to the requesting chat. */
  private async sendLink(entry: ActiveLogin, ttlMinutes: number, command: string): Promise<void> {
    const { chat } = entry;
    const text = t("login.web_link", entry.backend, String(ttlMinutes), command, entry.url);
    try {
      await chat.adapter.sendText(chat.chatId, text, { threadId: chat.threadId, disablePreview: true });
      this.audit("link_sent", { backend: entry.backend, requester: entry.requesterUserId, host: hostOf(entry.url) });
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message, backend: entry.backend }, "Failed to deliver web terminal link");
    }
  }

  /**
   * The access token goes ONLY to the requester, privately. Never into the
   * channel: if the private route fails, offer a resend button instead.
   */
  private async sendToken(entry: ActiveLogin, isResend = false): Promise<void> {
    const { chat } = entry;
    const token = entry.session.peekAccessToken();
    if (token === null) return;
    const body = chat.adapter.type === "telegram"
      ? `${escapeHtml(t("login.web_token", entry.backend))}\n<tg-spoiler>${escapeHtml(token)}</tg-spoiler>`
      : `${t("login.web_token", entry.backend)}\n\`${token}\``;
    let via: "dm" | null = null;
    if (typeof chat.adapter.sendDirect === "function") {
      try {
        await chat.adapter.sendDirect(entry.requesterUserId, body, {
          format: chat.adapter.type === "telegram" ? "html" : "text",
          disablePreview: true,
        });
        via = "dm";
      } catch (err) {
        this.deps.logger.warn({ err: (err as Error).message, backend: entry.backend }, "web terminal token DM failed");
      }
    }
    if (via) {
      entry.tokenDelivered = true;
      this.audit(isResend ? "token_resent" : "token_sent", { backend: entry.backend, requester: entry.requesterUserId, via });
      return;
    }
    entry.tokenDelivered = false;
    this.audit("token_dm_failed", { backend: entry.backend, requester: entry.requesterUserId });
    await this.deps.postButtons({
      prefix: LOGIN_TOKEN_RESEND_PREFIX,
      instanceName: entry.backend,
      chat,
      message: t("login.web_token_dm_failed"),
      choices: [{ action: "resend", label: t("login.web_resend") }],
      expiredText: t("buttons.stale"),
    }).catch(err => this.deps.logger.warn({ err: (err as Error).message }, "Failed to post token resend button"));
  }

  /** Device URL (+ code) observed in the pane: same spoiler treatment as before. */
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
      this.deps.logger.warn({ err: (err as Error).message, backend }, "Failed to deliver login URL");
    }
  }

  private async reportDone(chat: LoginChat, backend: string, result: WebTerminalResult): Promise<void> {
    let text: string;
    if (result.ok) {
      const { woken, restarted } = await this.deps.recoverBackendInstances(backend);
      const none = t("login.none");
      text = t("login.success", backend, woken.length ? woken.join(", ") : none, restarted.length ? restarted.join(", ") : none);
    } else if (result.reason === "cancel" && result.detail === "cancelled") {
      // The cancel command's own reply already announced this.
      text = "";
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
