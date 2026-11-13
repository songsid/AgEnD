import type { RoomAssistant, RoomAssistantAsk, RoomAssistantConfig, RoomAssistantHost, RoomAssistantSession } from "./types.js";
import { roomAssistantContext } from "./context.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Job = ReturnType<typeof deferred<{ text: string }>> & { input: RoomAssistantAsk };
type Entry = {
  roomId: string;
  state: "starting" | "working" | "idle" | "stopping" | "failed";
  controller: AbortController;
  done: ReturnType<typeof deferred<void>>;
  session?: RoomAssistantSession;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
  lastUsed: number;
  stopStarted: boolean;
  stopError?: unknown;
};

/**
 * Host-Fleet room instance ownership. Slots include starting and draining processes. Idle sessions may be evicted
 * for an earlier waiting room; a failed stop keeps its slot, since freeing a logical slot cannot stop a process.
 * The adapter owns launch restrictions and text extraction. This service never routes a platform reply or file.
 */
export class RoomAssistantRunner implements RoomAssistant {
  private readonly config: Readonly<RoomAssistantConfig>;
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Job[] = [];
  private closed = false;
  private scheduled = false;
  private closing?: Promise<void>;

  constructor(config: RoomAssistantConfig, private readonly host: RoomAssistantHost, private readonly now = Date.now) {
    if (typeof config.enabled !== "boolean" || !config.backend.trim()
      || config.account !== null && (typeof config.account !== "string" || !config.account.trim())
      || !Number.isInteger(config.cap) || config.cap < 1 || config.cap > 16
      || !Number.isInteger(config.idleMinutes) || config.idleMinutes < 1 || config.idleMinutes > 240) {
      throw new Error("Invalid room assistant settings");
    }
    this.config = Object.freeze({ ...config });
  }

  available(): ReturnType<RoomAssistant["available"]> {
    const failed = [...this.entries.values()].some(entry => entry.state === "failed");
    const paused = this.closed || !this.config.enabled || failed;
    return {
      enabled: !this.closed && this.config.enabled,
      backend: this.config.backend,
      running: [...this.entries.values()].filter(entry => entry.state !== "idle").length,
      cap: this.config.cap,
      state: paused ? "paused" : this.queue.length || [...this.entries.values()].some(entry => entry.state !== "idle") ? "busy" : "idle",
      ...(failed ? { note: "instance-stop-failed" } : {}),
    };
  }

  ask(input: RoomAssistantAsk): Promise<{ text: string }> {
    if (this.closed || !this.config.enabled) return Promise.reject(new Error("Room assistant is unavailable"));
    if ([...this.entries.values()].some(entry => entry.state === "failed")) return Promise.reject(new Error("Room assistant instance did not stop"));
    if (!input || typeof input.roomId !== "string" || !input.roomId || typeof input.roomName !== "string"
      || typeof input.messageId !== "string" || !input.messageId || typeof input.text !== "string"
      || !input.asker || typeof input.asker.name !== "string" || !Array.isArray(input.context)
      || !input.context.every(row => row && typeof row.author === "string" && typeof row.text === "string" && Number.isFinite(row.at)
        && (row.repliedTo === undefined || row.repliedTo === true))
      || input.context.filter(row => row.repliedTo === true).length > 1) {
      return Promise.reject(new Error("Invalid room assistant ask"));
    }
    // Snapshot at admission: caller mutations and an adjacent room's later asks cannot alter this turn's context.
    const copy: RoomAssistantAsk = {
      roomId: input.roomId, roomName: input.roomName, messageId: input.messageId,
      asker: { name: input.asker.name }, text: input.text,
      context: roomAssistantContext(input.context),
    };
    const job: Job = { ...deferred<{ text: string }>(), input: copy };
    this.queue.push(job);
    this.schedule();
    return job.promise;
  }

  forget(roomId: string): void {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (this.queue[index].input.roomId === roomId) this.queue.splice(index, 1)[0].reject(new Error("Room assistant was removed"));
    }
    const entry = this.entries.get(roomId);
    if (entry) this.retire(entry);
    this.schedule();
  }

  /** Fleet shutdown/config replacement drains every physical owner before returning. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error("Room assistant is stopping"));
    const entries = [...this.entries.values()];
    for (const entry of entries) this.retire(entry);
    this.closing = Promise.all(entries.map(entry => entry.done.promise)).then(() => {
      const errors = entries.filter(entry => entry.stopError !== undefined).map(entry => entry.stopError);
      if (errors.length) throw new AggregateError(errors, "Room assistant instances did not stop");
    });
    return this.closing;
  }

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }

  private drain(): void {
    while (!this.closed && this.queue.length) {
      // Same-room turns stay serialized, without blocking another room that can use a different slot.
      const index = this.queue.findIndex(job => {
        const entry = this.entries.get(job.input.roomId);
        return !entry || entry.state === "idle" || entry.state === "failed";
      });
      if (index < 0) return;
      const job = this.queue[index], existing = this.entries.get(job.input.roomId);
      if (existing?.state === "failed") {
        this.queue.splice(index, 1);
        job.reject(new Error("Room assistant instance did not stop"));
        continue;
      }
      if (existing) {
        this.queue.splice(index, 1);
        if (existing.timer) clearTimeout(existing.timer);
        void this.run(existing, job);
      } else if (this.entries.size < this.config.cap) {
        this.queue.splice(index, 1);
        const entry: Entry = {
          roomId: job.input.roomId, state: "starting", controller: new AbortController(),
          done: deferred<void>(), lastUsed: this.now(), stopStarted: false, job,
        };
        this.entries.set(entry.roomId, entry); // reserve before the first await
        void this.launch(entry, job);
      } else {
        // A draining slot is already being freed; never evict another idle room for that same waiting ask.
        if (![...this.entries.values()].some(entry => entry.state === "stopping")) {
          const idle = [...this.entries.values()].filter(entry => entry.state === "idle")
            .sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (idle) this.retire(idle);
        }
        return;
      }
    }
  }

  private async launch(entry: Entry, job: Job): Promise<void> {
    try {
      entry.session = await this.host.start({
        roomId: entry.roomId, roomName: job.input.roomName,
        backend: this.config.backend, account: this.config.account, signal: entry.controller.signal,
      });
    } catch (error) {
      job.reject(error);
      this.release(entry);
      return;
    }
    if (entry.controller.signal.aborted) { void this.stop(entry); return; }
    await this.run(entry, job);
  }

  private async run(entry: Entry, job: Job): Promise<void> {
    entry.state = "working";
    entry.job = job;
    try {
      const result = await entry.session!.ask(job.input, entry.controller.signal);
      if (entry.controller.signal.aborted) return;
      if (typeof result.text !== "string") throw new Error("Room assistant returned no text");
      job.resolve({ text: result.text });
    } catch (error) {
      job.reject(error);
      this.retire(entry);
      return;
    }
    if (entry.controller.signal.aborted) return;
    entry.job = undefined;
    entry.state = "idle";
    entry.lastUsed = this.now();
    entry.timer = setTimeout(() => { if (entry.state === "idle") this.retire(entry); }, this.config.idleMinutes * 60_000);
    entry.timer.unref?.();
    this.schedule();
  }

  private retire(entry: Entry): void {
    if (entry.state === "stopping" || entry.state === "failed") return;
    entry.state = "stopping";
    if (entry.timer) clearTimeout(entry.timer);
    entry.controller.abort();
    entry.job?.reject(new Error("Room assistant was stopped"));
    // An in-flight launch still owns its slot. Its completion must dispose even a late returned session.
    if (entry.session) void this.stop(entry);
  }

  private async stop(entry: Entry): Promise<void> {
    if (entry.stopStarted) return;
    entry.stopStarted = true;
    try { await entry.session!.stop(); }
    catch (error) {
      entry.stopError = error ?? new Error("Room assistant stop failed");
      entry.state = "failed";
      for (const job of this.queue.splice(0)) job.reject(new Error("Room assistant instance did not stop"));
      entry.done.resolve();
      this.schedule();
      return;
    }
    this.release(entry);
  }

  private release(entry: Entry): void {
    if (this.entries.get(entry.roomId) === entry) this.entries.delete(entry.roomId);
    entry.done.resolve();
    this.schedule();
  }
}
