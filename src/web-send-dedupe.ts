/**
 * The web chat's Retry, made safe to press (#2438 follow-up): a send the page repeats with the same `clientId` is the
 * same message. When the first one reached the agent but its answer and the live stream were both lost, the page shows
 * it failed; its Retry then gets the first one's messageId back and nothing is delivered twice.
 *
 * Keyed by who sent it, to which chat, under which clientId — one person's id never settles another's. Held for
 * WEB_SEND_DEDUPE_MS after the first was accepted; a first that failed is forgotten at once, so its Retry is a new
 * send. A repeat that comes while the first is still going waits for it. Durations on a monotonic clock.
 */
export const WEB_SEND_DEDUPE_MS = 10 * 60 * 1000;
/** At most this many accepted sends are remembered; the oldest go first. */
export const WEB_SEND_DEDUPE_MAX = 5000;

export type WebSendClaim =
  | { kind: "new"; settle(messageId: string | null): void }
  | { kind: "accepted"; messageId: string }
  | { kind: "going"; settled: Promise<void> };

type Entry = { messageId: string; at: number } | { going: Promise<void> };

export class WebSendDedupe {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly windowMs = WEB_SEND_DEDUPE_MS, private readonly max = WEB_SEND_DEDUPE_MAX) {}

  /** The one key for a send: the person's key, the chat, the page's clientId. */
  static key(personKey: string, instance: string, clientId: string): string { return `${personKey}\0${instance}\0${clientId}`; }

  claim(key: string): WebSendClaim {
    this.sweep();
    const found = this.entries.get(key);
    if (found && "going" in found) return { kind: "going", settled: found.going };
    if (found) return { kind: "accepted", messageId: found.messageId };
    let done!: () => void;
    const going = new Promise<void>((resolve) => { done = resolve; });
    this.entries.set(key, { going });
    let settledOnce = false;
    return {
      kind: "new",
      settle: (messageId) => {
        if (settledOnce) return;
        settledOnce = true;
        this.entries.delete(key);                                       // re-set below: insertion order = age
        if (messageId) {
          this.entries.set(key, { messageId, at: this.now() });
          while (this.entries.size > this.max && this.dropOldestAccepted());
        }
        done();
      },
    };
  }

  /** Accepted sends past the window go; sends still going stay whatever their age. */
  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if ("at" in e && t - e.at >= this.windowMs) this.entries.delete(k);
  }

  /** The oldest accepted send goes; sends still going are never dropped (each is one request, and settles). */
  private dropOldestAccepted(): boolean {
    for (const [k, e] of this.entries) if ("at" in e) { this.entries.delete(k); return true; }
    return false;
  }
}
