/**
 * #named-link-ttl: `web.public_link.auto_open` — after the fleet starts (its web listener up, its chat connections
 * started), reopen a named-tunnel public link once, for the admin who last opened it. A fixed hostname only: a quick
 * tunnel's address changes on every opening, so reopening it would reach nobody.
 *
 * - The same start and readiness probe as a requested link (PublicWebLink.openUnattended); sign-in is unchanged — the
 *   page still asks for a code, which only a private /web or a returning device's request delivers. Nothing is posted
 *   when it opens.
 * - A failed attempt is retried a bounded number of times (default: after 30 s and 2 min — a network still coming up at
 *   boot); then its owner hears of it once, privately, drawn as a failed /web is. Never a retry loop.
 * - Each attempt asks again: the fleet still running, auto_open still on with a hostname, the owner still known. A link
 *   someone opened meanwhile ("busy") ends it quietly.
 */
import { publicLinkAutoOpen } from "./public-web-link.js";
import type { PublicLinkProgress } from "./public-link-progress.js";
import type { LoginCodeOwner } from "./web-login.js";
import type { WebConfig } from "./types.js";

export const PUBLIC_LINK_AUTO_OPEN_RETRY_MS: readonly number[] = [30_000, 120_000];

export interface PublicLinkAutoOpenDeps {
  web(): WebConfig | undefined;
  /** The fleet is running and its web listener is up. */
  ready(): boolean;
  /** The remembered owner, rebuilt with its live binding, while it may still own a link; else null. */
  owner(): LoginCodeOwner | null;
  open(owner: LoginCodeOwner, onProgress: (p: PublicLinkProgress) => void): Promise<"opened" | "busy" | "failed">;
  /** Once, after the last attempt failed: tell the owner privately. Never throws to the caller. */
  notifyFailed(owner: LoginCodeOwner, last: PublicLinkProgress | undefined): Promise<void>;
  /** For daemon.log: fixed words, never a URL, code or token. */
  log(event: string, fields?: Record<string, unknown>): void;
  retryMs?: readonly number[];
  setTimer?(fn: () => void, ms: number): { cancel(): void };
}

export class PublicLinkAutoOpen {
  private started = false;
  private stopped = false;
  private pending: { cancel(): void } | null = null;
  constructor(private readonly deps: PublicLinkAutoOpenDeps) {}

  /** Once per fleet start. False: already started, or auto_open does not apply (off, or no fixed hostname). */
  start(): boolean {
    if (this.started || this.stopped) return false;
    this.started = true;
    if (!publicLinkAutoOpen(this.deps.web())) return false;
    void this.attempt(0);
    return true;
  }
  /** Shutdown: no further attempt starts (one under way ends with the link's own close). */
  stop(): void {
    this.stopped = true;
    this.pending?.cancel();
    this.pending = null;
  }

  private async attempt(n: number): Promise<void> {
    this.pending = null;
    if (this.stopped || !this.deps.ready()) return;
    if (!publicLinkAutoOpen(this.deps.web())) { this.deps.log("auto-open skipped: off or no fixed hostname"); return; }
    const owner = this.deps.owner();
    if (!owner) { this.deps.log("auto-open skipped: no current admin has opened the named link (open it once with /web)"); return; }
    let last: PublicLinkProgress | undefined;
    let outcome: "opened" | "busy" | "failed";
    try { outcome = await this.deps.open(owner, p => { last = p; }); } catch { outcome = "failed"; }
    if (outcome === "opened") { this.deps.log("auto-open: link opened", { attempt: n + 1 }); return; }
    if (outcome === "busy") { this.deps.log("auto-open: a link is already open or closing; nothing to do"); return; }
    const delays = this.deps.retryMs ?? PUBLIC_LINK_AUTO_OPEN_RETRY_MS;
    if (this.stopped) return;
    if (n < delays.length) {
      this.deps.log("auto-open failed; retrying", { attempt: n + 1, retryInMs: delays[n], reason: last?.failed?.reason });
      this.pending = (this.deps.setTimer ?? defaultTimer)(() => { void this.attempt(n + 1); }, delays[n]!);
      return;
    }
    this.deps.log("auto-open failed; giving up until the next start or /web", { attempts: n + 1, reason: last?.failed?.reason });
    await this.deps.notifyFailed(owner, last).catch(() => undefined);
  }
}

function defaultTimer(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}
