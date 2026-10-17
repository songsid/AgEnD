/**
 * #1920 §3.2: a guest's ClassicBot group or guild rooms — in scope only while its membership is verified.
 *
 * The answers are read in the background (at sign-in, every ten minutes, and when the guest's stream connects) and
 * kept in memory; a request only reads them, never the platform. A room is shown only on a "member" answer at most
 * 15 minutes old; an unknown, failed or stale answer hides it (fail closed).
 *
 * Revocation needs more than "hidden": a scope that becomes empty ends the session, and an answer not read yet (a
 * restart, a room just created) must not end it. A key with no answer is pending for at most the stale window from
 * when it was first wanted; after that, and after a "not a member" answer, it is settled.
 */
import type { ClassicChannel } from "./classic-channel-manager.js";
import { inferClassicChannelType } from "./classic-channel-manager.js";

export interface GuestOwner { readonly adapterId: string; readonly userId: string }
/** A ClassicBot room a guest may be a member of: a Telegram group or a Discord channel, on the guest's connection. */
export interface GuestRoom { readonly instance: string; readonly adapterId: string; readonly channelId: string; readonly kind: "telegram" | "discord" }
/** The adapter's read: true a member, false not (a definite answer); a rejection or anything else is no answer. */
export type RoomMemberRead = (room: GuestRoom, userId: string) => Promise<boolean> | undefined;

export const GUEST_ROOM_RECHECK_MS = 10 * 60_000;
export const GUEST_ROOM_STALE_MS = 15 * 60_000;
export const GUEST_ROOM_FORCE_FLOOR_MS = 60_000;
/** A read a request started (a pending guest polling or retrying): at most one per key in this long, whatever the volume. */
export const GUEST_ROOM_TRIGGER_FLOOR_MS = 30_000;
/** Failed reads back off — a minute, then 2, 4, 8 … — up to ten minutes (a bot without the permission, or removed). */
export const GUEST_ROOM_RETRY_MS = 60_000;
export const GUEST_ROOM_RETRY_MAX_MS = 10 * 60_000;
/** Consecutive failures after which a key's failure is persistent: said once (onPersistentFailure), not every attempt. */
export const GUEST_ROOM_PERSISTENT_FAILURES = 3;
/** The background tick runs this often and reads only what is due. */
export const GUEST_ROOM_TICK_MS = 60_000;
const READ_DEADLINE_MS = 5_000;
/** The guest caps (4 per account, 64 in all) bound the owners; this bounds a fleet with very many rooms. */
const MAX_ENTRIES = 8192;

/**
 * The group rooms on this guest's own connection. A Telegram private room (a positive id) is not here: it is the
 * account's own room or someone else's, never a membership question.
 */
export function guestGroupRooms(rooms: readonly ClassicChannel[], owner: GuestOwner): GuestRoom[] {
  const out: GuestRoom[] = [];
  for (const room of rooms) {
    if (room.adapterId !== owner.adapterId) continue;
    const kind = inferClassicChannelType(room.channelId);
    if (kind === "telegram" && room.channelId.trim().startsWith("-")) out.push({ instance: room.instanceName, adapterId: room.adapterId, channelId: room.channelId, kind });
    else if (kind === "discord") out.push({ instance: room.instanceName, adapterId: room.adapterId, channelId: room.channelId, kind });
  }
  return out;
}

interface Entry {
  /** The last definite answer; null until one arrives. */
  member: boolean | null;
  /** When that answer arrived — or, with none yet, when the key was first wanted (the pending window's start). */
  at: number;
  /** When it was last asked (answered or not): a forced read waits a minute after it. */
  asked: number;
  /** When a scheduled read is due again: ten minutes after an answer; after failures, their backoff. */
  due: number;
  /** Consecutive failed reads (0 after an answer). */
  failures: number;
  /** Its persistent failure was said (once, until an answer). */
  reported: boolean;
}
/** Who reads: the background pass (what is due), a request of a pending guest (rate-limited), a stream connecting. */
export type GuestRoomReadMode = "scheduled" | "triggered" | "force";

export class GuestRoomMembership {
  private readonly entries = new Map<string, Entry>();
  private readonly reads = new Map<string, Promise<void>>();

  constructor(private readonly opts: {
    now: () => number; read: RoomMemberRead; deadlineMs?: number; staleMs?: number; recheckMs?: number;
    /** A key's reads keep failing (said once, until an answer); and when it answers again after that. */
    onPersistentFailure?: (room: GuestRoom, failures: number) => void; onRecovered?: (room: GuestRoom) => void;
  }) {}

  private key(room: GuestRoom, userId: string): string { return `${room.adapterId}\u0000${room.channelId}\u0000${userId}`; }
  private get staleMs(): number { return this.opts.staleMs ?? GUEST_ROOM_STALE_MS; }

  /** Shown: a "member" answer no older than the stale window. */
  verified(room: GuestRoom, userId: string): boolean {
    const e = this.entries.get(this.key(room, userId));
    return !!e && e.member === true && this.opts.now() - e.at <= this.staleMs;
  }

  /**
   * Not settled yet: no definite answer, and first wanted less than the stale window ago (or never — a key nobody
   * asked about yet is pending, and starts its window here). A pending room keeps an emptied scope from ending the
   * session; it never shows the room.
   */
  pending(room: GuestRoom, userId: string): boolean {
    const k = this.key(room, userId), now = this.opts.now();
    let e = this.entries.get(k);
    if (!e) { e = { member: null, at: now, asked: Number.NEGATIVE_INFINITY, due: Number.NEGATIVE_INFINITY, failures: 0, reported: false }; this.put(k, e); }
    return e.member === null && now - e.at < this.staleMs;
  }

  /**
   * Read this guest's rooms, one at a time; never rejects. One read per key at a time.
   * - "scheduled": what is due (never asked; ten minutes after an answer; a failure's backoff).
   * - "triggered" (a pending guest's request): the same, and never within 30 s of the key's last read, so a guest that
   *   polls or retries is not platform traffic.
   * - "force" (its stream connected): a minute after the key's last read — but a failing key keeps its backoff.
   */
  async refresh(owner: GuestOwner, rooms: readonly GuestRoom[], opts: { mode?: GuestRoomReadMode } = {}): Promise<void> {
    const mode = opts.mode ?? "scheduled";
    for (const room of rooms) {
      const k = this.key(room, owner.userId), now = this.opts.now();
      const e = this.entries.get(k);
      // A read in flight is never repeated: a scheduled refresh waits for it; the others skip it (asked just now).
      if (e) {
        const sinceAsked = now - e.asked;
        if (mode === "force" ? sinceAsked < GUEST_ROOM_FORCE_FLOOR_MS || (e.failures > 0 && now < e.due)
          : now < e.due || (mode === "triggered" && sinceAsked < GUEST_ROOM_TRIGGER_FLOOR_MS)) continue;
      }
      await (this.reads.get(k) ?? this.ask(k, room, owner.userId));
    }
  }

  private ask(k: string, room: GuestRoom, userId: string): Promise<void> {
    const started = this.opts.now();
    const existing = this.entries.get(k);
    const recheck = this.opts.recheckMs ?? GUEST_ROOM_RECHECK_MS;
    const fresh: Entry = { member: null, at: started, asked: started, due: started, failures: 0, reported: false };
    this.put(k, existing ? { ...existing, asked: started } : fresh);
    const read = this.readBounded(room, userId).then((member) => {
      const e = this.entries.get(k) ?? fresh;
      const now = this.opts.now();
      if (member === undefined) {
        // A failure leaves the last answer to age (and hide the room when stale), and backs off: 1, 2, 4 … 10 min.
        const failures = e.failures + 1;
        const reported = failures >= GUEST_ROOM_PERSISTENT_FAILURES;   // an answer resets both
        this.put(k, { ...e, failures, reported, due: now + Math.min(GUEST_ROOM_RETRY_MAX_MS, GUEST_ROOM_RETRY_MS * 2 ** (failures - 1)) });
        if (reported && !e.reported) this.opts.onPersistentFailure?.(room, failures);
        return;
      }
      this.put(k, { member, at: now, asked: e.asked, due: now + recheck, failures: 0, reported: false });
      if (e.reported) this.opts.onRecovered?.(room);
    }).finally(() => this.reads.delete(k));
    this.reads.set(k, read);
    return read;
  }

  private readBounded(room: GuestRoom, userId: string): Promise<boolean | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), this.opts.deadlineMs ?? READ_DEADLINE_MS);
      (timer as { unref?: () => void }).unref?.();
      let asked: Promise<boolean> | undefined;
      try { asked = this.opts.read(room, userId); } catch { asked = undefined; }
      if (!asked) { clearTimeout(timer); resolve(undefined); return; }
      asked.then((m) => { clearTimeout(timer); resolve(m === true ? true : m === false ? false : undefined); },
        () => { clearTimeout(timer); resolve(undefined); });
    });
  }

  private put(k: string, e: Entry): void {
    this.entries.delete(k);   // re-insert: the map's order is its age, for the bound below
    this.entries.set(k, e);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string);
  }
}
