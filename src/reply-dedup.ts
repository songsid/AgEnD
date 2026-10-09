import { createHash } from "node:crypto";

/**
 * Suppresses duplicate replies caused by retries above a non-idempotent send.
 *
 * The reply pipeline has no idempotency, and every layer above it retries on an
 * uncertain outcome: the daemon times out `fleet_outbound` at its budget and
 * tells the agent the reply failed while the adapter send is still in flight
 * (and about to succeed — Discord's REST layer queues rate-limited requests
 * rather than failing them), and an HTTP agent's shell tool kills a slow
 * `agend-agent reply` the same way. The agent then re-sends the identical text
 * and the channel shows it twice.
 *
 * Semantics, chosen per failure mode:
 * - A duplicate of an IN-FLIGHT reply subscribes to the first send's outcome —
 *   this is the actual race (the retry arrives while the original is still
 *   waiting out a rate limit), and both callers report whatever the one real
 *   send did.
 * - Once a reply settles (success or failure), its entry is removed. Replaying
 *   a completed result is unsafe: two legitimate short replies such as "OK"
 *   would otherwise return the first platform message id without a second POST.
 * - An in-flight entry has a hard lifetime. If an adapter promise never settles,
 *   later identical replies must not join that dead promise forever.
 */
/**
 * The text a reply is deduplicated by: a reply with stickers (#1226) is not the same reply as its text alone.
 * One rule for the MCP path (FleetManager) and the HTTP path (agend-agent, agent-endpoint.ts).
 */
export function replyDedupText(args: Record<string, unknown>): string {
  const text = String(args.text ?? "");
  const stickers = Array.isArray(args.stickers) ? (args.stickers as unknown[]).map(String) : [];
  const keyed = stickers.length ? `${text}\u0000stickers:${stickers.join(",")}` : text;
  // #1266: the same text with other buttons is another reply.
  return Array.isArray(args.buttons) && args.buttons.length ? `${keyed}\u0000buttons:${JSON.stringify(args.buttons)}` : keyed;
}

export class ReplyDeduper {
  private entries = new Map<string, Entry>();

  constructor(private readonly inFlightTimeoutMs = 5 * 60_000) {}

  /**
   * Register an outgoing reply. Returns `fresh` (send it, then call `complete`
   * exactly once with the outcome) or `duplicate` (do NOT send; `subscribe` for
   * the outcome the original send produces / produced).
   */
  begin(instance: string, text: string, files: readonly string[] = []):
    | { duplicate: false; complete(result: unknown, error?: string): void }
    | { duplicate: true; subscribe(cb: (result: unknown, error?: string) => void): void } {
    const key = this.key(instance, text, files);
    const existing = this.entries.get(key);

    if (existing) {
      return {
        duplicate: true,
        subscribe: cb => existing.waiters.push(cb),
      };
    }

    const entry: Entry = { settled: false, waiters: [], timer: undefined };
    entry.timer = setTimeout(() => {
      if (entry.settled || this.entries.get(key) !== entry) return;
      entry.settled = true;
      this.entries.delete(key);
      const error = `Original reply did not settle within ${this.inFlightTimeoutMs}ms; retry as a new send`;
      for (const waiter of entry.waiters.splice(0)) waiter(null, error);
    }, this.inFlightTimeoutMs);
    entry.timer.unref?.();
    this.entries.set(key, entry);
    return {
      duplicate: false,
      complete: (result, error) => {
        if (entry.settled) return; // respond() double-call guard
        entry.settled = true;
        if (entry.timer) clearTimeout(entry.timer);
        // Do not let a late completion from an expired request delete a newer
        // request using the same key.
        if (this.entries.get(key) === entry) this.entries.delete(key);
        for (const w of entry.waiters.splice(0)) w(result, error);
      },
    };
  }

  private key(instance: string, text: string, files: readonly string[]): string {
    return createHash("sha256")
      .update(instance).update("\0")
      .update(text).update("\0")
      .update(files.join("\0"))
      .digest("hex");
  }
}

interface Entry {
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  waiters: Array<(result: unknown, error?: string) => void>;
}
