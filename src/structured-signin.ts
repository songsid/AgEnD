/**
 * #2599 stage 1: browser controls for a login command, never a browser terminal.
 * Transport/authority are supplied by the host; this module starts no processes
 * by itself and imports no fleet lifecycle.
 *
 * Antigravity (AGEND-113) is signed in with `agy acp --login` (agy >= 1.5.0: "Log in with Google interactively, then exit"), never with the bare `agy` TUI: the command prints
 * Google's link, asks for the authorization code and ends. Its screen is read through the same closed table the Windows Runtime uses (`reduceAgyLoginScreen`), and it prints no
 * success line, so it is "signed in" only when the command ended with exit 0 and `agy models` works (`checkAuth`).
 */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { LOGIN_FLOWS, extractLoginHint, type AuthCheckResult } from "./login-flows.js";
import { LoginWindowLock, type LoginWindowClaim } from "./login-window-lock.js";
import { linkableLoginUrl } from "./login-url.js";
import { REDUCED_AGY_CANCELLED, REDUCED_AGY_CODE_PROMPT, REDUCED_AGY_REJECTED, REDUCED_AGY_URL_PREFIX, reduceAgyLoginScreen } from "./runtime-signin.js";
import { hostFacts, hostIdsByRank, type HostCliWith } from "./cli-registry.js";

/**
 * The CLIs whose sign-in is driven with browser controls (cli-registry.ts: `host.structuredSignIn`, in the order of its `rank`). Whether the FIRST-RUN page offers them as controls
 * is another capability (`host.firstRunSignIn.mode`): Antigravity is driven here, but that page only names its console command.
 */
export type StructuredBackend = HostCliWith<"structuredSignIn">;
export const STRUCTURED_SIGNIN_BACKENDS: readonly StructuredBackend[] = Object.freeze(hostIdsByRank("structuredSignIn") as StructuredBackend[]);
export function structuredSignInSupported(backend: string): backend is StructuredBackend {
  return (STRUCTURED_SIGNIN_BACKENDS as readonly string[]).includes(backend);
}
/** The exact command each sign-in launches (cli-registry.ts: `host.structuredSignIn.argv`; pinned, literally, by tests/cli-registry-golden.test.ts). */
const ARGV = Object.fromEntries(STRUCTURED_SIGNIN_BACKENDS.map(id => [id, hostFacts(id, "structuredSignIn")!.argv])) as Record<StructuredBackend, readonly string[]>;
const TTL_MS = 10 * 60_000;
const UNKNOWN_GRACE_MS = 5_000;
const MAX_PANE = 64 * 1024;
const MAX_VALUE = 4_096;

export type SignInFailure = "busy" | "cancelled" | "expired" | "revoked" | "unsupported_prompt"
  | "provider_rejected" | "relogin_required" | "auth_unconfirmed" | "transport_failed" | "cleanup_failed"
  /** AGEND-119: a named account's folder is not where the CLI keeps its sign-in (it would use, and overwrite, another account's): nothing was started. */
  | "not_isolated";
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

/**
 * `agy acp --login`: the reduced screen has four forms (link, code prompt, "Login failed", "Login cancelled") and there is no success form to read: the command ending with exit 0 is
 * checked in `poll`. The link only ever comes out of the reducer, so it is https on `accounts.google.com`.
 */
function agyPrompt(pane: string): SignInPrompt {
  const rows = reduceAgyLoginScreen(pane).split("\n").filter(Boolean);
  if (rows.includes(REDUCED_AGY_REJECTED)) return { phase: "failed", reason: "provider_rejected" };
  if (rows.includes(REDUCED_AGY_CANCELLED)) return { phase: "failed", reason: "cancelled" };
  const link = rows.find(row => row.startsWith(REDUCED_AGY_URL_PREFIX))?.slice(REDUCED_AGY_URL_PREFIX.length);
  const url = link && link.length <= MAX_VALUE ? link : null;
  if (rows.includes(REDUCED_AGY_CODE_PROMPT)) return { phase: "code", url };
  return url ? { phase: "authorization", url, code: null } : { phase: "waiting" };
}

/**
 * A CLI whose screen is read by its own closed table instead of `LOGIN_FLOWS`' patterns (the behaviour that backs a registry `structuredSignIn` whose `screen` is `"own"`;
 * tests/cli-registry-completeness.test.ts checks the two agree).
 */
const SCREEN_READERS: Partial<Record<StructuredBackend, (pane: string) => SignInPrompt>> = { antigravity: agyPrompt };
/** The CLIs that have one (the completeness test checks they are exactly the registry's `screen: "own"`). */
export const OWN_SCREEN_READER_IDS: readonly string[] = Object.freeze(Object.keys(SCREEN_READERS));
/** Plain joined pane only, bounded; raw output never becomes a browser view or an error. */
export function structuredSignInPrompt(backend: StructuredBackend, input: string): SignInPrompt {
  if (Buffer.byteLength(input, "utf8") > MAX_PANE || /\x1b|\x00/.test(input)) return { phase: "failed", reason: "unsupported_prompt" };
  const pane = input.replace(/\r/g, "").trimEnd();
  const reader = SCREEN_READERS[backend];
  if (reader) return reader(pane);
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
  /**
   * #3190 Part 3c: a credential profile NAME on a paired computer, for a transport that signs a profile in there. Only a name: the transport turns it into
   * its own folder and variable. Never a path, an environment or an argument. A transport that has no profiles (the host's own) refuses it.
   */
  profile?: string;
  /** Fixed command, only after an explicit re-login choice. Never an implicit logout. */
  logoutArgv?: readonly string[];
}
export interface StructuredSignInTransport {
  /** Must be bounded, disable automatic browser opening and use a dedicated process/PTY.
   * No interactive shell after exit. Abort/close must reap late-created resources. */
  start(spec: StructuredSignInLaunch, signal: AbortSignal): Promise<void>;
  capture(): Promise<string>;
  /** `isolated: false` (AGEND-124): the command ended, but the account's sign-in is not in the account's own folder (the CLI kept it somewhere shared), so it is not this account's. */
  status(): Promise<{ alive: boolean; exitCode?: number; isolated?: false }>;
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
  /** The credential profile NAME this sign-in is for (a paired computer's, #3190 Part 3c). Passed to the transport as `StructuredSignInLaunch.profile`; the closed name check is the caller's. */
  profile?: string;
  /** Independently probe the backend's auth status; bounded and token-free (LOGIN_FLOWS.authCheck). */
  checkAuth(): Promise<AuthCheckResult>;
  /**
   * AGEND-119, a NAMED account of a CLI told its account by an argument: whether this account's sign-in is really kept in its own folder, asked before anything is started. False: the CLI keeps one
   * sign-in for every folder (its keyring), so signing this account in would replace another's — the sign-in ends as `not_isolated` and no login command runs. Absent: not asked.
   */
  isolated?(): Promise<boolean>;
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
  /** A reused valid login changes no credentials and needs no running-agent restart. */
  get launched(): boolean { return this.transportTouched; }
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
      if (this.deps.isolated) {
        const isolated = await this.deps.isolated().catch(() => false);
        if (!this.current()) { await this.finish(this.lostReason()); return; }
        if (!isolated) { await this.finish("not_isolated"); return; }
      }
      const auth = await this.deps.checkAuth();
      if (!this.current()) { await this.finish(this.lostReason()); return; }
      if (auth === "valid" && !confirmedRelogin) { await this.finish(); return; }
      this.setPhase("starting");
      if (!this.current()) { await this.finish(this.lostReason()); return; }
      this.transportTouched = true;
      this.startInFlight = this.deps.transport.start({ argv: [...ARGV[this.backend]], ...(this.deps.profile !== undefined ? { profile: this.deps.profile } : {}),
        ...(confirmedRelogin && this.backend === "kiro-cli" ? { logoutArgv: ["kiro-cli", "logout"] } : {}) }, this.abort.signal);
      await this.startInFlight;
      if (!this.current()) { await this.finish(this.lostReason()); return; }
      await this.poll();
    } catch (error) {
      // A transport that was refused because the account's sign-in is not kept in the account's own folder (a Runtime's proof, AGEND-124) says so; nothing else of an error is read.
      await this.finish(error instanceof Error && error.message === "not_isolated" ? "not_isolated" : "transport_failed");
    }
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
        // A named account whose command ended well but left no sign-in in the account's folder: the CLI did not keep it there, so it was kept in a store every folder shares.
        if (status.isolated === false && !status.alive) { await this.finish("not_isolated"); return; }
        // A CLI whose sign-in ends by its exit code (Antigravity prints no success line): it has ended only when the command has, and only exit 0 is checked. No exit code at all (a signal, a closed
        // window, a pane status that could not be read) is not "signed in" either, because an older login is still there and would pass the check.
        const byExit = hostFacts(this.backend, "structuredSignIn")?.ends === "exit-code";
        if (byExit ? !status.alive : (prompt.phase === "success" || !status.alive)) {
          if (byExit && status.exitCode !== 0) { await this.finish("auth_unconfirmed"); return; }
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
          // Claude Code reads authorization codes raw; Ctrl+U becomes part of the code.
          // Only Kiro's start URL and region prompts need their prefilled value cleared.
          text = (action.kind === "code" ? "" : "\x15") + value + "\r";
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
