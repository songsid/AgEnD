/**
 * What opening a temporary public link is doing, step by step, for the message the admin clicked on.
 *
 *   ① check cloudflared  ② download it  ③ verify it      — only when AgEnD's pinned copy must be fetched
 *   ④ start the tunnel   ⑤ wait for the public address   ⑥ deliver the link privately
 *
 * The text goes where the button was: a Discord ephemeral reply, or the Telegram menu in General. So it holds
 * only static words, numbers and durations — never the link, the code, a path or a platform's error text.
 * Durations are monotonic (performance.now), so a wall-clock jump cannot make a step take negative time.
 */
import { t } from "./locale.js";
import type { CloudflaredInstallErrorKind } from "./tunnel/cloudflared-install.js";

export type PublicLinkStep = "check" | "download" | "verify" | "tunnel" | "address" | "deliver";
const STEPS: readonly PublicLinkStep[] = ["check", "download", "verify", "tunnel", "address", "deliver"];
const NUMBERS: Record<PublicLinkStep, string> = { check: "①", download: "②", verify: "③", tunnel: "④", address: "⑤", deliver: "⑥" };

/** Why a step failed, as one of a fixed set: each has its own static sentence. */
export type PublicLinkFailure =
  | "unsupported-platform" | "download-failed" | "checksum-mismatch" | "install-failed" | "cancelled"
  | "spawn-failed" | "no-address" | "unreachable" | "lease-held" | "gateway-failed" | "delivery-failed" | "closed" | "unknown";

export interface PublicLinkProgress {
  readonly startedAt: number;
  /** Steps begun so far, in order; the last one without `endedAt` is the one running. */
  readonly steps: ReadonlyArray<{ readonly step: PublicLinkStep; readonly startedAt: number; readonly endedAt?: number }>;
  /** `checking` until the install answered; `download` shows ①–③, `installed` hides them. */
  readonly install: "checking" | "installed" | "download";
  readonly version?: string;
  /** `fallback`: the bytes come from GitHub because the pkg.cloudflare.com package was too slow or failed (#1554). */
  readonly download?: { readonly received: number; readonly total: number | null; readonly fallback?: "slow" | "failed" };
  readonly failed?: { readonly step: PublicLinkStep; readonly reason: PublicLinkFailure };
}

/** The install's and the tunnel's error kinds, folded into the reasons a user is shown. */
export function failureOf(kind: CloudflaredInstallErrorKind | string | undefined): PublicLinkFailure {
  switch (kind) {
    case "unsupported-platform": case "download-failed": case "checksum-mismatch": case "install-failed": case "cancelled":
    case "lease-held":
      return kind;
    case "binary-missing": case "binary-not-executable": case "spawn-failed": case "not-logged-in":
      return "spawn-failed";
    case "no-url": case "bad-url": case "timeout":
      return "no-address";
    case "readiness-failed":
      return "unreachable";
    default:
      return "unknown";
  }
}

/** Builds the snapshots; each change hands a new immutable one to `emit`. */
export class PublicLinkProgressTracker {
  private state: PublicLinkProgress;
  constructor(private readonly now: () => number, private readonly emit: (p: PublicLinkProgress) => void) {
    const at = now();
    this.state = { startedAt: at, steps: [{ step: "check", startedAt: at }], install: "checking" };
  }
  get snapshot(): PublicLinkProgress { return this.state; }
  private set(next: PublicLinkProgress): void { this.state = next; this.emit(next); }
  /** Ends the running step (if any) and begins `step`. A step already begun is not begun again. */
  begin(step: PublicLinkStep, extra: Partial<Pick<PublicLinkProgress, "install" | "version" | "download">> = {}): void {
    if (this.state.failed || this.state.steps.some(s => s.step === step)) { if (Object.keys(extra).length) this.set({ ...this.state, ...extra }); return; }
    const at = this.now();
    const steps = this.state.steps.map(s => s.endedAt === undefined ? { ...s, endedAt: at } : s);
    this.set({ ...this.state, ...extra, steps: [...steps, { step, startedAt: at }] });
  }
  installChecked(download: boolean, version: string): void {
    if (download) this.begin("download", { install: "download", version });
    else this.set({ ...this.state, install: "installed", version });
  }
  downloaded(received: number, total: number | null, fallback?: "slow" | "failed"): void {
    this.set({ ...this.state, download: { received, total, ...(fallback ? { fallback } : {}) } });
  }
  /** Every running step ends now. */
  complete(): void {
    const at = this.now();
    this.set({ ...this.state, steps: this.state.steps.map(s => s.endedAt === undefined ? { ...s, endedAt: at } : s) });
  }
  fail(reason: PublicLinkFailure): void {
    if (this.state.failed) return;
    const running = [...this.state.steps].reverse().find(s => s.endedAt === undefined) ?? this.state.steps.at(-1)!;
    const at = this.now();
    this.set({ ...this.state, failed: { step: running.step, reason }, steps: this.state.steps.map(s => s.endedAt === undefined ? { ...s, endedAt: at } : s) });
  }
}

function seconds(ms: number): number { return Math.max(0, Math.floor(ms / 1000)); }
function megabytes(bytes: number): string { return (bytes / (1024 * 1024)).toFixed(1); }

/** The message text for one snapshot, at monotonic time `now`; `outcome` is the closing line once it is decided. */
export function renderPublicLinkProgress(p: PublicLinkProgress, now: number, outcome?: string): string {
  const shown = STEPS.filter(step => p.install === "download" || !["download", "verify"].includes(step))
    .filter(step => p.install !== "installed" || step !== "check");
  const end = Math.max(...p.steps.map(s => s.endedAt ?? now));
  const lines = [t("dashboard.progress.title", seconds((outcome !== undefined || p.failed ? end : now) - p.startedAt))];
  for (const step of shown) {
    const begun = p.steps.find(s => s.step === step);
    const label = `${NUMBERS[step]} ${stepLabel(step, p)}`;
    if (!begun) { lines.push(`▫️ ${label}`); continue; }
    const took = seconds((begun.endedAt ?? now) - begun.startedAt);
    if (p.failed?.step === step) lines.push(`❌ ${label} · ${t("dashboard.progress.seconds", took)} — ${t(`dashboard.progress.fail.${p.failed.reason}`)}`);
    else if (begun.endedAt !== undefined) lines.push(`✅ ${label} · ${t("dashboard.progress.seconds", took)}`);
    else lines.push(`⏳ ${label} · ${t("dashboard.progress.seconds", took)}`);
  }
  if (outcome) lines.push("", outcome);
  return lines.join("\n");
}

function stepLabel(step: PublicLinkStep, p: PublicLinkProgress): string {
  switch (step) {
    case "check":
      return p.install === "download" ? t("dashboard.progress.check_download", p.version ?? "") : t("dashboard.progress.check");
    case "download": {
      const d = p.download;
      if (!d) return t("dashboard.progress.download");
      const amount = d.total ? `${megabytes(d.received)} / ${megabytes(d.total)} MB` : `${megabytes(d.received)} MB`;
      if (d.fallback) return t("dashboard.progress.download_fallback", amount, t(`dashboard.progress.fallback_${d.fallback}`));
      return d.total ? t("dashboard.progress.download_of", megabytes(d.received), megabytes(d.total)) : t("dashboard.progress.download_bytes", megabytes(d.received));
    }
    default:
      return t(`dashboard.progress.${step}`);
  }
}

/**
 * Edits one message with the latest text, no more often than `minIntervalMs`: a burst of changes (download bytes)
 * becomes one edit carrying the newest. While open it refreshes every `heartbeatMs`, so the seconds move even when
 * nothing else does. One edit at a time, an unchanged text is never sent again (Telegram refuses "not modified"),
 * and two failed edits in a row stop it (the message or its token is gone). `close` waits out the edit in flight,
 * so whatever the caller writes next lands after it.
 */
export class ThrottledMessageEditor {
  private render: (() => string) | null = null;
  private lastText: string | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private failures = 0;
  constructor(private readonly opts: {
    edit: (text: string) => Promise<void>;
    now: () => number;
    minIntervalMs: number;
    heartbeatMs: number;
    onError?: (err: unknown) => void;
  }) {}
  update(render: () => string): void {
    if (this.closed) return;
    this.render = render;
    this.pump();
  }
  private pump(): void {
    if (this.closed || this.inFlight || !this.render) return;
    const wait = this.lastSentAt + this.opts.minIntervalMs - this.opts.now();
    if (wait > 0) { this.arm(wait); return; }
    const text = this.render();
    if (text === this.lastText) { this.arm(this.opts.heartbeatMs); return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.lastText = text;
    this.lastSentAt = this.opts.now();
    this.inFlight = this.opts.edit(text).then(
      () => { this.failures = 0; },
      err => { this.failures++; this.opts.onError?.(err); if (this.failures >= 2) this.closed = true; },
    ).finally(() => { this.inFlight = null; if (!this.closed) this.arm(this.opts.heartbeatMs); });
  }
  private arm(ms: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(0, ms));
    this.timer.unref?.();
  }
  /** No edit after this one returns; the one in flight has settled. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.inFlight;
  }
}
