/**
 * #1386 §5.1–5.4: one world's live "Needs you" message in its General — kept current, without flooding, and never
 * left holding a capability it should not.
 *
 * - **Generations (§5.2a).** Every render is a generation. Its Acknowledge capabilities are minted for it, and the
 *   previous generation's are revoked *before the render's first await* — an old button is stale from that moment,
 *   whether or not the edit lands. Expiry never edits the message: the message is renewed at least every
 *   RENEW_MS.
 * - **Single flight with fences (§5.3a).** One render at a time; a change meanwhile schedules exactly one more. After
 *   every await (post/edit/delete ACK) the render continues only if its generation is current, the feature is on,
 *   the world exists, the target is the one it started with, and the fleet is not stopping. Otherwise nothing is
 *   persisted, its capabilities are revoked, and a late post is deleted.
 * - **Edit vs new post (§5.3).** Changes edit in place (debounced, at most one edit per EDIT_MIN_MS). A new item
 *   replaces the message with a new post — at the bottom, so people are notified — at most once per POST_MIN_MS;
 *   one inside that window is shown by an edit and posted when the window opens.
 * - **The pointer (§5.4).** Reused only at the same canonical place; a moved target never receives this world's list
 *   at its former destination (the old message is deleted best effort, without new content).
 *
 * Every effect is injected; times come from a monotonic clock.
 */
import type { NeedsYouItem } from "./needs-you.js";

export interface LiveTarget { chatId: string; threadId?: string }
export interface LivePointer extends LiveTarget { messageId: string }
export interface LiveChoice { id: string; label: string }

export interface LiveContent {
  /** Nothing waits on this world: no message is posted for it if none exists yet. */
  empty: boolean;
  text: string;
  /** Delivery items that get an Acknowledge button on this render. */
  ackable: NeedsYouItem[];
}

/** Capabilities minted for one render; `bind` fixes the message id once a post returns it. */
export interface LiveAcks {
  choices: LiveChoice[];
  bind(pointer: LivePointer): void;
}

export interface LiveDeps {
  world: string;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The current canonical General target, or null when this world has none. */
  target(): LiveTarget | null;
  enabled(): boolean;
  stopping(): boolean;
  worldExists(): boolean;
  /** This world's current content. */
  content(): LiveContent;
  post(target: LiveTarget, text: string, choices: LiveChoice[]): Promise<LivePointer>;
  edit(pointer: LivePointer, text: string, choices: LiveChoice[]): Promise<void>;
  remove(pointer: LivePointer): Promise<void>;
  loadPointer(): LivePointer | null;
  savePointer(pointer: LivePointer | null): void;
  /** Mint Acknowledge capabilities for `generation`, bound to `place` (the message id may follow via bind). */
  mintAcks(generation: number, place: LiveTarget & { messageId?: string }, items: NeedsYouItem[]): LiveAcks;
  /** Revoke every Acknowledge capability this world holds (all generations). */
  revokeAcks(): void;
  log(message: string, extra?: Record<string, unknown>): void;
  text: { stopped: string; off: string };
}

export const DEBOUNCE_MS = 3_000;
export const EDIT_MIN_MS = 10_000;
export const POST_MIN_MS = 60_000;
export const RENEW_MS = 10 * 60_000;

/** Telegram General is topic "1" on input and no thread on the wire: both are the same place. */
export function canonicalTarget(target: LiveTarget): LiveTarget {
  const thread = target.threadId === undefined || target.threadId === "" || target.threadId === "1" ? undefined : String(target.threadId);
  return thread === undefined ? { chatId: String(target.chatId) } : { chatId: String(target.chatId), threadId: thread };
}

export function samePlace(a: LiveTarget, b: LiveTarget): boolean {
  const x = canonicalTarget(a), y = canonicalTarget(b);
  return x.chatId === y.chatId && x.threadId === y.threadId;
}

export class NeedsYouLiveMessage {
  private generation = 0;
  private pointer: LivePointer | null;
  private inFlight = false;
  private rerun = false;
  private timer: unknown = null;
  private dueAt = Infinity;
  private lastEditAt = -Infinity;
  private lastPostAt = -Infinity;
  private postWanted = false;
  private retired = false;

  constructor(private readonly deps: LiveDeps) {
    this.pointer = deps.loadPointer();
    // A restart has no capabilities: render at once so the message gets fresh ones (pre-restart buttons are stale).
    this.requestAt(deps.now());
  }

  /** The list changed. `newIds`: an item appeared that this world has not shown before (→ a new post, rate-limited). */
  changed(newIds: boolean): void {
    if (this.retired) return;
    if (newIds) this.postWanted = true;
    const now = this.deps.now();
    let at = now + DEBOUNCE_MS;
    if (this.postWanted) at = Math.max(at, Math.min(this.lastPostAt + POST_MIN_MS, this.lastEditAt + EDIT_MIN_MS));
    else at = Math.max(at, this.lastEditAt + EDIT_MIN_MS);
    this.requestAt(at);
  }

  /** Current generation (tests and the ack handler's generation check). */
  get currentGeneration(): number { return this.generation; }
  get currentPointer(): LivePointer | null { return this.pointer; }

  private requestAt(at: number): void {
    if (this.retired || at >= this.dueAt) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.dueAt = at;
    this.timer = this.deps.setTimer(() => { this.timer = null; this.dueAt = Infinity; void this.render(); }, Math.max(0, at - this.deps.now()));
  }

  private scheduleRenewal(): void {
    this.requestAt(this.deps.now() + RENEW_MS);
  }

  /** One render. Public for tests; normal use goes through changed(). */
  async render(): Promise<void> {
    if (this.retired) return;
    if (this.inFlight) { this.rerun = true; return; }
    this.inFlight = true;
    try {
      await this.renderOnce();
    } finally {
      this.inFlight = false;
      if (this.rerun && !this.retired) { this.rerun = false; this.requestAt(this.deps.now()); }
      else if (!this.retired) {
        // A new item shown by an edit inside the post window is posted when the window opens.
        if (this.postWanted) this.requestAt(Math.max(this.deps.now(), this.lastPostAt + POST_MIN_MS));
        if (this.timer === null) this.scheduleRenewal();
      }
    }
  }

  private fenced(generation: number, target: LiveTarget): boolean {
    const now = this.deps.target();
    return generation === this.generation && !this.retired && this.deps.enabled() && !this.deps.stopping()
      && this.deps.worldExists() && now !== null && samePlace(now, target);
  }

  private async renderOnce(): Promise<void> {
    const target = this.deps.target();
    if (!this.deps.enabled() || this.deps.stopping() || !this.deps.worldExists() || target === null) return;
    const generation = ++this.generation;
    // Revoke before await: every earlier generation's buttons are stale from here on, whatever happens below.
    this.deps.revokeAcks();
    const content = this.deps.content();
    const now = this.deps.now();
    // Nothing to say and nothing said yet: a fleet that never needed anyone posts nothing.
    if (this.pointer === null && content.empty) { this.postWanted = false; return; }

    const moved = this.pointer !== null && !samePlace(this.pointer, target);
    const postDue = this.postWanted && now >= this.lastPostAt + POST_MIN_MS;
    if (this.pointer === null || moved || postDue) {
      await this.postNew(generation, target, content, moved);
      return;
    }

    const pointer = this.pointer;
    const acks = this.deps.mintAcks(generation, pointer, content.ackable);
    try {
      await this.deps.edit(pointer, content.text, acks.choices);
    } catch (err) {
      if (!this.fenced(generation, target)) { this.deps.revokeAcks(); return; }
      this.deps.log("live message edit failed; posting a new one", { world: this.deps.world, err: String((err as Error)?.message ?? err) });
      this.deps.revokeAcks();
      const next = ++this.generation;
      await this.postNew(next, target, this.deps.content(), false);
      return;
    }
    if (!this.fenced(generation, target)) { this.deps.revokeAcks(); return; }
    this.lastEditAt = this.deps.now();
  }

  private async postNew(generation: number, target: LiveTarget, content: LiveContent, moved: boolean): Promise<void> {
    const old = this.pointer;
    const acks = this.deps.mintAcks(generation, canonicalTarget(target), content.ackable);
    let sent: LivePointer;
    try {
      sent = await this.deps.post(target, content.text, acks.choices);
    } catch (err) {
      this.deps.revokeAcks();
      this.deps.log("live message post failed", { world: this.deps.world, err: String((err as Error)?.message ?? err) });
      return;
    }
    if (!this.fenced(generation, target)) {
      // A late ACK: disabled, rebound, superseded or stopping meanwhile. Publish nothing current.
      this.deps.revokeAcks();
      void this.deps.remove(sent).catch(() => {});
      return;
    }
    acks.bind(sent);
    this.pointer = sent;
    this.deps.savePointer(sent);
    const at = this.deps.now();
    this.lastPostAt = at;
    this.lastEditAt = at;
    this.postWanted = false;
    // The previous message goes — without new content, so a moved target's former destination never gets this list.
    if (old !== null && !(old.messageId === sent.messageId && samePlace(old, sent))) {
      void this.deps.remove(old).catch(err => this.deps.log(moved ? "could not remove the live message at its former target" : "could not remove the previous live message",
        { world: this.deps.world, err: String((err as Error)?.message ?? err) }));
    }
  }

  /** Shutdown: revoke first, then say so on the message, without buttons. No further renders. */
  async retire(): Promise<void> {
    if (this.retired) return;
    this.retired = true;
    if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null; }
    this.deps.revokeAcks();
    this.generation++;
    if (this.pointer) await this.deps.edit(this.pointer, this.deps.text.stopped, []).catch(() => {});
  }

  /** live_message turned off (or the world removed): revoke, mark the message, forget it. */
  async disable(): Promise<void> {
    if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null; }
    this.retired = true;
    this.deps.revokeAcks();
    this.generation++;
    const pointer = this.pointer;
    this.pointer = null;
    this.deps.savePointer(null);
    if (pointer) await this.deps.edit(pointer, this.deps.text.off, []).catch(() => {});
  }
}
