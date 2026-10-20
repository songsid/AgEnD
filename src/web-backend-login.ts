/**
 * #2233: signing a backend in from the web dashboard — the dashboard side of LoginController's `web` requester.
 *
 * - Who: a signed-in admin session on the local surface (the route checks it; the controller asks again through the
 *   sink, and the watchdog below keeps asking while the sign-in runs). Never a guest, a read session or the public link.
 * - Two steps, as in chat: `check` runs the controller's pre-check and keeps its answer here, server-side, under a
 *   random id bound to the session that asked (chat keeps it in a nonce button); `begin` with that id starts the
 *   sign-in through every check again. The client never says whether a token was present.
 * - What chat sends as a link, a DM or a device code goes to the one session that started it, read back with `view`:
 *   the browser terminal's URL, the provider's URL and code, and the access token while it is unredeemed. Other admin
 *   sessions see that a sign-in is running (backend, device, phase) and may cancel it; nothing more.
 * - A sign-in whose session signs out, expires or is revoked is cancelled (WEB_LOGIN_WATCH_MS).
 */
import { randomBytes } from "node:crypto";
import type { ChannelAdapter } from "./channel/types.js";
import type { LoginChat, LoginStartOptions, WebLoginSink } from "./login-controller.js";
import { LOGIN_BACKEND_ALIASES } from "./login-flows.js";

/** How long the dialog's "go ahead" stays valid after the pre-check (chat's buttons expire as stale too). */
export const WEB_LOGIN_CONFIRM_TTL_MS = 5 * 60_000;
/** How long an ended sign-in is still shown (its outcome), then it is gone. */
export const WEB_LOGIN_KEEP_ENDED_MS = 10 * 60_000;
/** How often a running sign-in checks that the session which started it is still a local admin. */
export const WEB_LOGIN_WATCH_MS = 5_000;
const MAX_LINES = 20;
const MAX_LINE_CHARS = 2000;

/**
 * The provider hosts a sign-in link may point at to be offered as a link; any other URL is shown as text only. The
 * CLI's own output is what is matched, and a page that turns whatever it printed into a link is a phishing aid.
 */
export const LOGIN_LINK_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "codex": ["openai.com"],
  "grok": ["x.ai"],
  "kiro-cli": ["amazonaws.com", "awsapps.com", "aws.amazon.com", "kiro.dev"],
  "claude-code": ["anthropic.com", "claude.ai", "claude.com"],
};

/** An https URL on one of the backend's own hosts (or a subdomain of one). */
export function linkableLoginUrl(backend: string, url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return (LOGIN_LINK_HOSTS[backend] ?? []).some(domain => host === domain || host.endsWith(`.${domain}`));
}

export interface WebLoginRequester {
  /** The session's handle (web-session.ts): what the sign-in is bound to. */
  handle: string;
  /** Its device label, for the other sessions and the notice. */
  label: string;
}

export interface WebBackendLoginDeps {
  /** Is the session with this handle live, admin and local right now? */
  isLocalAdmin(handle: string): boolean;
  /** LoginController.start for a dashboard requester (FleetManager refuses a CLI that is not installed first). */
  start(backend: string, chat: LoginChat, opts: LoginStartOptions): Promise<string | null>;
  accessToken(sink: WebLoginSink): string | null;
  isActiveFor(sink: WebLoginSink): boolean;
  /** End the sign-in this sink started (pending or running) and nothing else; true when there was one. */
  cancelFor(sink: WebLoginSink): Promise<boolean>;
  /** `/login cancel`: whatever sign-in or install is running. */
  cancel(): Promise<string>;
  /** A sign-in started from the dashboard: said where a chat login would be seen (General, or the Log). */
  notice(info: { shown: string; label: string; handle: string }): void;
  now?(): number;
}

interface Pending {
  id: string;
  backend: string;
  profile?: string;
  handle: string;
  tokenPresent: boolean;
  logoutFirst: string | null;
  publicLink: boolean;
  deviceAuth: boolean;
  expiresAt: number;
}

interface Run {
  id: string;
  /** Admission order: a slower start never replaces a later one that was already shown. */
  seq: number;
  backend: string;
  profile?: string;
  handle: string;
  label: string;
  startedAt: number;
  phase: "running" | "ended";
  ok: boolean | null;
  endedAt: number | null;
  hint: { url: string; code: string | null; linkable: boolean } | null;
  terminal: { url: string; ttlMinutes: number; command: string; loopback: boolean; public: boolean } | null;
  lines: string[];
  sink: WebLoginSink;
}

export interface WebLoginConfirm {
  id: string;
  backend: string;
  profile?: string;
  tokenPresent: boolean;
  logoutFirst: string | null;
  publicLink: boolean;
  deviceAuth: boolean;
  expiresAt: number;
}

/** What one session sees of the current sign-in. The parts after `mine` are present only for the session that started it. */
export interface WebLoginView {
  id: string;
  backend: string;
  profile?: string;
  phase: "running" | "ended";
  ok: boolean | null;
  startedOn: string;
  startedAt: number;
  endedAt: number | null;
  mine: boolean;
  lines?: string[];
  hint?: { url: string; code: string | null; linkable: boolean } | null;
  terminal?: { url: string; ttlMinutes: number; command: string; loopback: boolean; public: boolean } | null;
  /** The browser terminal's one-time access code, while it is unredeemed. */
  accessCode?: string | null;
}

export class WebBackendLogins {
  private readonly pending = new Map<string, Pending>();
  private run: Run | null = null;
  /** Every admitted sign-in not yet ended — starting (its listener, tunnel or cloudflared still coming) or running. */
  private readonly live = new Set<Run>();
  private seq = 0;
  private watch: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: WebBackendLoginDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** The pre-check: the dialog's question, or the controller's answer (a refusal, "busy", "unsupported"…). */
  async check(who: WebLoginRequester, backendArg: string, profile?: string): Promise<{ confirm: WebLoginConfirm } | { message: string }> {
    const backend = LOGIN_BACKEND_ALIASES[backendArg.toLowerCase()] ?? backendArg.toLowerCase();
    const asked: { info: Omit<Pending, "id" | "backend" | "profile" | "handle" | "expiresAt"> | null } = { info: null };
    const sink: WebLoginSink = {
      isAdmin: () => this.deps.isLocalAdmin(who.handle),
      confirm: info => { asked.info = info; },
      hint: () => {}, terminal: () => {}, ended: () => {},
    };
    const lines: string[] = [];
    const message = await this.deps.start(backend, this.chatFor(who, sink, lines), profile !== undefined ? { profile } : {});
    if (!asked.info) return { message: message ?? lines.join("\n") };
    this.sweep();
    for (const [id, p] of this.pending) if (p.handle === who.handle) this.pending.delete(id);   // one question per session
    const id = randomBytes(16).toString("hex");
    const entry: Pending = { id, backend, ...(profile !== undefined ? { profile } : {}), handle: who.handle, ...asked.info, expiresAt: this.now() + WEB_LOGIN_CONFIRM_TTL_MS };
    this.pending.set(id, entry);
    const { handle: _handle, ...confirm } = entry;
    return { confirm };
  }

  /** The go-ahead for a pre-check this session was given; `tunnel` only where it offered a public link. */
  async begin(who: WebLoginRequester, confirmId: string, tunnel: boolean): Promise<{ login: WebLoginView } | { message: string } | { error: "confirm_expired" | "tunnel_not_offered" }> {
    this.sweep();
    const asked = this.pending.get(confirmId);
    if (!asked || asked.handle !== who.handle) return { error: "confirm_expired" };
    if (tunnel && !asked.publicLink) return { error: "tunnel_not_offered" };
    this.pending.delete(confirmId);
    const run: Run = {
      id: randomBytes(16).toString("hex"), seq: ++this.seq, backend: asked.backend, ...(asked.profile !== undefined ? { profile: asked.profile } : {}),
      handle: who.handle, label: who.label, startedAt: this.now(), phase: "running", ok: null, endedAt: null,
      hint: null, terminal: null, lines: [], sink: null as unknown as WebLoginSink,
    };
    run.sink = {
      isAdmin: () => this.deps.isLocalAdmin(who.handle),
      confirm: () => {},
      hint: (url, code) => { run.hint = { url, code, linkable: linkableLoginUrl(run.backend, url) }; },
      terminal: info => { run.terminal = { ...info }; },
      ended: result => {
        run.phase = "ended"; run.ok = result.ok; run.endedAt = this.now();
        this.live.delete(run);
        if (!this.live.size) this.stopWatch();
      },
    };
    // Watched from admission, not from publication: a session revoked while its listener, tunnel or cloudflared is
    // still coming up ends its own attempt (cancelFor) — never one that replaced it.
    this.live.add(run);
    this.startWatch();
    const message = await this.deps.start(asked.backend, this.chatFor(who, run.sink, run.lines), {
      skipAuthCheck: true, tokenPresent: asked.tokenPresent, ...(tunnel ? { tunnel: true } : {}),
      ...(asked.profile !== undefined ? { profile: asked.profile } : {}),
    });
    const running = run.phase === "running" && this.deps.isActiveFor(run.sink);
    if (!running && run.phase !== "ended") {                                     // refused: nothing ran
      this.live.delete(run);
      if (!this.live.size) this.stopWatch();
      return { message: message ?? "" };
    }
    if (message && !running) pushLine(run.lines, message);                       // ended while starting: why
    // A start that took longer than a later one (its listener held, then cancelled) never replaces what that one shows.
    if (this.run && this.run.seq > run.seq) return running ? { login: this.viewOf(run, who.handle) } : { message: message ?? run.lines.join("\n") };
    this.run = run;
    if (running) {
      try { this.deps.notice({ shown: asked.profile ? `${asked.backend} (${asked.profile})` : asked.backend, label: who.label, handle: who.handle }); } catch { /* a notice never stops a sign-in */ }
    }
    return { login: this.viewOf(run, who.handle) };
  }

  /** The current sign-in as this session may see it, or null. */
  view(viewerHandle: string): WebLoginView | null {
    const run = this.run;
    if (!run) return null;
    if (run.phase === "ended" && run.endedAt !== null && this.now() - run.endedAt > WEB_LOGIN_KEEP_ENDED_MS) { this.run = null; return null; }
    return this.viewOf(run, viewerHandle);
  }

  /** Any local admin may stop it (it only takes something away); a chat-started sign-in or install included. */
  cancel(): Promise<string> { return this.deps.cancel(); }

  dispose(): void { this.stopWatch(); this.pending.clear(); this.live.clear(); }

  private viewOf(run: Run, viewerHandle: string): WebLoginView {
    const mine = run.handle === viewerHandle && this.deps.isLocalAdmin(viewerHandle);
    const base: WebLoginView = {
      id: run.id, backend: run.backend, ...(run.profile !== undefined ? { profile: run.profile } : {}), phase: run.phase, ok: run.ok,
      startedOn: run.label, startedAt: run.startedAt, endedAt: run.endedAt, mine,
    };
    if (!mine) return base;
    const running = run.phase === "running" && this.deps.isActiveFor(run.sink);
    return {
      ...base, lines: [...run.lines], hint: running ? run.hint : null, terminal: running ? run.terminal : null,
      accessCode: running && run.terminal ? this.deps.accessToken(run.sink) : null,
    };
  }

  private chatFor(who: WebLoginRequester, sink: WebLoginSink, lines: string[]): LoginChat {
    // The status lines chat would post (done, recovery, a download notice) — this sign-in's own, shown to its session.
    const adapter = {
      type: "web", id: "web",
      sendText: async (_chatId: string, text: string) => { pushLine(lines, text); return { chatId: "web", messageId: randomBytes(6).toString("hex") }; },
    } as unknown as ChannelAdapter;
    return { adapter, adapterId: "web", chatId: "web", userId: `web:${who.handle}`, web: sink };
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
  }

  private startWatch(): void {
    if (this.watch) return;
    this.watch = setInterval(() => {
      for (const run of [...this.live]) {
        if (this.deps.isLocalAdmin(run.handle)) continue;
        // The session that holds the code is gone (signed out, expired, revoked): its own sign-in goes with it.
        this.live.delete(run);
        void this.deps.cancelFor(run.sink).catch(() => false);
      }
      if (!this.live.size) this.stopWatch();
    }, WEB_LOGIN_WATCH_MS);
    this.watch.unref?.();
  }

  private stopWatch(): void {
    if (this.watch) { clearInterval(this.watch); this.watch = null; }
  }
}

function pushLine(lines: string[], text: string): void {
  lines.push(text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}
