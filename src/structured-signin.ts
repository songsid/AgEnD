/**
 * #2599 stage 1: browser controls for a login command, never a browser terminal.
 * Transport/authority are supplied by the host; this module starts no processes
 * by itself and imports no fleet lifecycle. Agy remains console-only.
 */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { LOGIN_FLOWS, extractLoginHint, type AuthCheckResult } from "./login-flows.js";
import { LoginWindowLock, type LoginWindowClaim } from "./login-window-lock.js";
import { linkableLoginUrl } from "./login-url.js";

export const STRUCTURED_SIGNIN_BACKENDS = ["kiro-cli", "claude-code", "codex"] as const;
export type StructuredBackend = typeof STRUCTURED_SIGNIN_BACKENDS[number];
export function structuredSignInSupported(backend: string): backend is StructuredBackend {
  return (STRUCTURED_SIGNIN_BACKENDS as readonly string[]).includes(backend);
}

const ARGV: Record<StructuredBackend, readonly string[]> = {
  "kiro-cli": ["kiro-cli", "login"],
  "claude-code": ["claude", "auth", "login"],
  "codex": ["codex", "login", "--device-auth"],
};
const TTL_MS = 10 * 60_000;
const UNKNOWN_GRACE_MS = 5_000;
const MAX_PANE = 64 * 1024;
const MAX_VALUE = 4_096;

export type SignInFailure = "busy" | "cancelled" | "expired" | "revoked" | "unsupported_prompt"
  | "provider_rejected" | "relogin_required" | "auth_unconfirmed" | "transport_failed" | "cleanup_failed";
export type SignInPrompt =
  | { phase: "waiting" }
  | { phase: "method"; choices: string[]; selected: number }
  | { phase: "start_url" }
  | { phase: "region" }
  | { phase: "authorization"; url: string; code: string | null }
  | { phase: "code"; url: string | null }
  | { phase: "success" }
  | { phase: "failed"; reason: SignInFailure };
export type SignInAction =
  | { kind: "method"; choice: string }
  | { kind: "start_url" | "region" | "code"; value: string };

/** Only the portion below the last menu title may be interpreted as controls. */
function menu(pane: string, backend: StructuredBackend): SignInPrompt | null {
  const rows = pane.split("\n").map(row => row.trimEnd()).filter(row => row.trim());
  let title = -1;
  for (let i = 0; i < rows.length; i++) if (/^\s*\??\s*Select login method\s*[:›]?\s*$/.test(rows[i]!)) title = i;
  if (title < 0) return null;
  const options = rows.slice(title + 1);
  const labels = backend === "kiro-cli"
    ? ["Use with Builder ID", "Use with Google", "Use with GitHub", "Use with Your Organization"]
    : backend === "claude-code" ? [
      "Claude account with subscription · Pro, Max, Team, or Enterprise",
      "Anthropic Console account · API usage billing",
      "3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI",
    ] : [];
  if (!labels.length || options.length !== labels.length) return { phase: "failed", reason: "unsupported_prompt" };
  let selected = -1;
  for (let i = 0; i < labels.length; i++) {
    const row = options[i]!.trimStart();
    const marked = /^[❯›>]\s/.test(row);
    const text = row.replace(/^[❯›>]\s*/, "").replace(/^\d+\.\s*/, "");
    if (text !== labels[i] || (marked && selected !== -1)) return { phase: "failed", reason: "unsupported_prompt" };
    if (marked) selected = i;
  }
  if (selected < 0) return { phase: "failed", reason: "unsupported_prompt" };
  return { phase: "method", selected, choices: backend === "kiro-cli"
    ? ["builder_id", "google", "github", "organization"] : ["subscription", "console", "third_party"] };
}

/** Plain joined pane only, bounded; raw output never becomes a browser view or an error. */
export function structuredSignInPrompt(backend: StructuredBackend, input: string): SignInPrompt {
  if (Buffer.byteLength(input, "utf8") > MAX_PANE || /\x1b|\x00/.test(input)) return { phase: "failed", reason: "unsupported_prompt" };
  const pane = input.replace(/\r/g, "").trimEnd();
  const flow = LOGIN_FLOWS[backend]!;
  if (flow.failures?.some(failure => failure.pattern.test(pane))) {
    return { phase: "failed", reason: /Already logged in, please logout/.test(pane) ? "relogin_required" : "provider_rejected" };
  }
  if (/Invalid code\b|expired (?:device )?code|authorization (?:denied|expired)/i.test(pane)) {
    return { phase: "failed", reason: "provider_rejected" };
  }
  if (flow.successPattern.test(pane)) return { phase: "success" };
  const selection = menu(pane, backend);
  if (selection) return selection;
  if (backend === "kiro-cli") {
    if (/(?:^|\n)\s*\??\s*Enter Start URL\s*[›>:]?\s*[^\n]*$/.test(pane)) return { phase: "start_url" };
    if (/(?:^|\n)\s*\??\s*Enter Region\s*[›>:]?\s*[^\n]*$/.test(pane)) return { phase: "region" };
  }
  const hint = extractLoginHint(pane, flow);
  const url = hint.url && linkableLoginUrl(backend, hint.url) && hint.url.length <= MAX_VALUE ? hint.url : null;
  if (backend === "claude-code" && /(?:^|\n)\s*Paste code here if prompted >\s*$/.test(pane)) return { phase: "code", url };
  if (url && (backend !== "codex" || hint.code)) return { phase: "authorization", url, code: hint.code };
  // Unknown interactive screens are not answered. The session gives partial
  // redraws a short grace, then offers the explicit console fallback.
  return { phase: "waiting" };
}

export interface StructuredSignInLaunch {
  argv: readonly string[];
  /** Fixed command, only after an explicit re-login choice. Never an implicit logout. */
  logoutArgv?: readonly string[];
}
export interface StructuredSignInTransport {
  /** Must be bounded, disable automatic browser opening and use a dedicated process/PTY.
   * No interactive shell after exit. Abort/close must reap late-created resources. */
  start(spec: StructuredSignInLaunch, signal: AbortSignal): Promise<void>;
  capture(): Promise<string>;
  status(): Promise<{ alive: boolean; exitCode?: number }>;
  /** Literal PTY input to this attempt's fixed login command, never shell interpolation. */
  write(input: string, signal: AbortSignal): Promise<void>;
  /** Confirm all this attempt's native resources are gone; reject if that cannot be proven. */
  close(): Promise<void>;
}
export interface StructuredSignInDeps {
  transport: StructuredSignInTransport;
  lock: LoginWindowLock;
  /** Current setup owner / local-admin session. Rechecked after every await. */
  current(): boolean;
  /** Independently probe the backend's auth status; bounded and token-free (LOGIN_FLOWS.authCheck). */
  checkAuth(): Promise<AuthCheckResult>;
  /** Monotonic elapsed milliseconds; wall-clock corrections must not extend an attempt. */
  now?(): number;
  /** Safe event only. Never receives panes, URLs, codes or supplied input. */
  changed?(event: { backend: StructuredBackend; phase: string; reason?: SignInFailure }): void;
}
export interface StructuredSignInView {
  id: string;
  backend: StructuredBackend;
  revision: number;
  phase: "checking" | "starting" | "done" | "failed" | SignInPrompt["phase"];
  reason?: SignInFailure;
  mine: boolean;
  choices?: string[];
  url?: string | null;
  code?: string | null;
  canAct?: boolean;
}
export type SignInActionResult = "accepted" | "stale" | "invalid" | "ended" | "busy";

export class StructuredSignIn {
  readonly id = randomBytes(16).toString("hex");
  private claim: LoginWindowClaim | null = null;
  private readonly abort = new AbortController();
  private phase: StructuredSignInView["phase"] = "checking";
  private reason: SignInFailure | undefined;
  private prompt: SignInPrompt = { phase: "waiting" };
  private revision = 0;
  private closed = false;
  private begun = false;
  private startInFlight: Promise<void> | null = null;
  private transportTouched = false;
  private finishing: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private unknownAt: number | null = null;
  private readonly answered = new Set<SignInPrompt["phase"]>();
  private get promptUsed(): boolean { return this.answered.has(this.prompt.phase); }
  private expiresAt = Infinity;
  private pendingActions = 0;

  constructor(readonly backend: StructuredBackend, private readonly owner: object, private readonly deps: StructuredSignInDeps) {
    if (!structuredSignInSupported(backend)) throw new Error("structured_signin_unsupported");
  }
  private now(): number { return (this.deps.now ?? (() => performance.now()))(); }
  private authorized(): boolean { try { return this.now() < this.expiresAt && this.deps.current(); } catch { return false; } }
  private lostReason(): SignInFailure { return this.now() >= this.expiresAt ? "expired" : "revoked"; }
  private current(): boolean { return !this.closed && this.authorized() && this.deps.lock.isCurrent(this.claim); }
  private emit(): void {
    try { this.deps.changed?.({ backend: this.backend, phase: this.phase, ...(this.reason ? { reason: this.reason } : {}) }); } catch { /* observer is not authority */ }
  }
  private setPhase(phase: StructuredSignInView["phase"], reason?: SignInFailure): void {
    if (this.phase === phase && this.reason === reason) return;
    this.phase = phase; this.reason = reason; this.revision++; this.emit();
  }

  /** Duplicate begin/refresh joins this attempt; it never starts another child. */
  async start(confirmedRelogin = false): Promise<void> {
    if (this.begun || this.closed) return;
    this.begun = true;
    this.claim = this.deps.lock.tryClaim("web", this.backend);
    if (!this.claim) { await this.finish("busy"); return; }
    this.expiresAt = this.now() + TTL_MS;
    this.deadline = setTimeout(() => { void this.finish("expired"); }, TTL_MS);
    this.deadline.unref?.();
    try {
      if (!this.current()) { await this.finish(this.lostReason()); return; }
      const auth = await this.deps.checkAuth();
      if (!this.current()) { await this.finish(this.lostReason()); return; }
      if (auth === "valid" && !confirmedRelogin) { await this.finish(); return; }
      this.setPhase("starting");
      if (!this.current()) { await this.finish(this.lostReason()); return; }
      this.transportTouched = true;
      this.startInFlight = this.deps.transport.start({ argv: [...ARGV[this.backend]],
        ...(confirmedRelogin && this.backend === "kiro-cli" ? { logoutArgv: ["kiro-cli", "logout"] } : {}) }, this.abort.signal);
      await this.startInFlight;
      if (!this.current()) { await this.finish(this.lostReason()); return; }
      await this.poll();
    } catch { await this.finish("transport_failed"); }
  }

  view(who: object): StructuredSignInView {
    const mine = who === this.owner && this.authorized();
    const basic: StructuredSignInView = { id: this.id, backend: this.backend, phase: this.phase, mine, revision: this.revision,
      ...(this.reason ? { reason: this.reason } : {}) };
    if (!mine || this.closed) return basic;
    basic.canAct = !this.promptUsed && ["method", "code", "start_url", "region"].includes(this.prompt.phase);
    if (this.prompt.phase === "method") basic.choices = this.prompt.choices.filter(choice => choice !== "third_party");
    if (this.prompt.phase === "authorization") { basic.url = this.prompt.url; basic.code = this.prompt.code; }
    if (this.prompt.phase === "code") basic.url = this.prompt.url;
    return basic;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }
  private observe(pane: string): SignInPrompt {
    const next = structuredSignInPrompt(this.backend, pane);
    if (JSON.stringify(next) !== JSON.stringify(this.prompt)) {
      this.prompt = next; this.revision++;
    }
    this.setPhase(next.phase === "success" ? "checking" : next.phase);
    return next;
  }

  private schedule(): void {
    if (this.closed) return;
    this.pollTimer = setTimeout(() => { void this.poll(); }, 500);
    this.pollTimer.unref?.();
  }
  /** Also used by inert harnesses; overlapping captures/actions share one FIFO. */
  poll(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
      if (!this.current()) { await this.finish(this.lostReason()); return; }
      try {
        const pane = await this.deps.transport.capture();
        if (!this.current()) { await this.finish(this.lostReason()); return; }
        const prompt = this.observe(pane);
        if (prompt.phase === "failed") { await this.finish(prompt.reason); return; }
        const status = await this.deps.transport.status();
        if (!this.current()) { await this.finish(this.lostReason()); return; }
        if (prompt.phase === "success" || !status.alive) {
          const auth = await this.deps.checkAuth();
          if (!this.current()) { await this.finish(this.lostReason()); return; }
          await this.finish(auth === "valid" ? undefined : "auth_unconfirmed");
          return;
        }
        if (prompt.phase === "waiting" && pane.trim()) {
          this.unknownAt ??= this.now();
          if (this.now() - this.unknownAt >= UNKNOWN_GRACE_MS) { await this.finish("unsupported_prompt"); return; }
        } else this.unknownAt = null;
        this.schedule();
      } catch { await this.finish("transport_failed"); }
    });
  }

  action(who: object, id: string, revision: number, action: SignInAction): Promise<SignInActionResult> {
    if (this.pendingActions >= 8) return Promise.resolve("busy");
    this.pendingActions++;
    return this.serial<SignInActionResult>(async () => {
      if (this.closed) return "ended";
      if (who !== this.owner || id !== this.id || !this.current()) return "stale";
      if (revision !== this.revision || this.promptUsed) return "stale";
      if (!action || typeof action !== "object"
        || (action.kind === "method" ? typeof action.choice !== "string"
          : !["code", "start_url", "region"].includes(action.kind) || typeof action.value !== "string")) return "invalid";
      try {
        // Re-observe immediately before input: an old browser page cannot
        // answer a later prompt just because its cached revision still matches.
        const pane = await this.deps.transport.capture();
        if (!this.current()) { await this.finish(this.lostReason()); return "stale"; }
        this.observe(pane);
        if (revision !== this.revision || this.promptUsed) return "stale";
        const prompt = this.prompt;
        let text: string | null = null;
        if (action.kind === "method" && prompt.phase === "method") {
          const target = prompt.choices.indexOf(action.choice);
          if (target < 0 || action.choice === "third_party") return "invalid";
          const delta = target - prompt.selected;
          text = (delta > 0 ? "\x1b[B" : "\x1b[A").repeat(Math.abs(delta)) + "\r";
        } else if ((action.kind === "code" && prompt.phase === "code")
          || (action.kind === "start_url" && prompt.phase === "start_url") || (action.kind === "region" && prompt.phase === "region")) {
          const value = action.value.trim();
          if (!value || value.length > MAX_VALUE || /[^\x21-\x7e]/.test(value)) return "invalid";
          if (action.kind === "start_url" && !validStartUrl(value)) return "invalid";
          if (action.kind === "region" && !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(value)) return "invalid";
          if (action.kind === "code" && !/^[A-Za-z0-9._~+/#=-]+$/.test(value)) return "invalid";
          text = "\x15" + value + "\r"; // replace a prefilled prompt; literal bytes only
        }
        if (text === null) return "invalid";
        this.answered.add(prompt.phase); // before the async write; redraws never re-arm an answered phase
        this.revision++;
        await this.deps.transport.write(text, this.abort.signal);
        if (!this.current()) { await this.finish(this.lostReason()); return "ended"; }
        return "accepted";
      } catch { await this.finish("transport_failed"); return "ended"; }
    }).finally(() => { this.pendingActions--; });
  }

  cancel(): Promise<void> { return this.finish("cancelled"); }
  private finish(reason?: SignInFailure): Promise<void> {
    if (this.finishing) return this.finishing;
    this.closed = true;
    this.abort.abort();
    if (this.deadline) clearTimeout(this.deadline);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.finishing = Promise.resolve().then(async () => {
      if (this.startInFlight) await this.startInFlight.catch(() => {});
      let cleanupFailed = false;
      try { if (this.transportTouched) await this.deps.transport.close(); } catch { cleanupFailed = true; }
      // A possibly live credential writer keeps the shared slot reserved.
      if (!cleanupFailed) this.deps.lock.release(this.claim);
      this.prompt = { phase: "waiting" };
      this.setPhase(cleanupFailed || reason ? "failed" : "done", cleanupFailed ? "cleanup_failed" : reason);
    });
    return this.finishing;
  }
}

function validStartUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !url.port
      && (url.hostname === "awsapps.com" || url.hostname.endsWith(".awsapps.com")) && /^\/start\/?$/.test(url.pathname);
  } catch { return false; }
}
