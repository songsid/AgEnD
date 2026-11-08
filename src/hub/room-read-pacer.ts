import { HubProtocolError } from "./validation.js";

/** Room reads share one bounded allowance, including reads from different tabs/rooms of the same session. */
export const ROOM_READ_BURST = 8;
export const ROOM_READ_INFLIGHT = 2;
export const ROOM_READ_SESSIONS = 8192;
interface Bucket { at: number; tokens: number; active: number }

/** Only work accounting is retained here. No history, identity or authorization is cached. */
export class RoomReadPacer {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly intervalMs: number, private readonly clock = () => performance.now()) {}

  enter(session: string): () => void {
    const now = this.clock();
    let bucket = this.buckets.get(session);
    if (!bucket) {
      if (this.buckets.size >= ROOM_READ_SESSIONS) {
        // Evict only fully replenished, physically idle buckets: churn cannot reset a spent allowance.
        for (const [key, value] of this.buckets) {
          if (value.active === 0 && value.tokens + this.refill(value, now) >= ROOM_READ_BURST) this.buckets.delete(key);
        }
        if (this.buckets.size >= ROOM_READ_SESSIONS) throw new HubProtocolError("backpressure");
      }
      bucket = { at: now, tokens: ROOM_READ_BURST, active: 0 };
      this.buckets.set(session, bucket);
    }
    const refill = this.refill(bucket, now);
    if (refill > 0) {
      bucket.tokens = Math.min(ROOM_READ_BURST, bucket.tokens + refill);
      bucket.at += refill * this.intervalMs;
    }
    if (bucket.tokens < 1 || bucket.active >= ROOM_READ_INFLIGHT) throw new HubProtocolError("backpressure");
    bucket.tokens--; bucket.active++;
    let finished = false;
    return () => { if (!finished) { finished = true; bucket.active--; } };
  }

  private refill(bucket: Bucket, now: number): number {
    return Math.floor(Math.max(0, now - bucket.at) / this.intervalMs);
  }
  clear(): void { this.buckets.clear(); }
}
