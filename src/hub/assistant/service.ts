import { RoomAssistantRunner } from "./runner.js";
import { ROOM_ASSISTANT_DEFAULTS, type RoomAssistant, type RoomAssistantAsk, type RoomAssistantConfig, type RoomAssistantHost } from "./types.js";
import type { AssistantQuotaBand, AssistantBackendChoice, AssistantAdminSettings, AssistantUsage, RoomAssistantAdmin } from "./admin-types.js";
export interface AssistantSavedState {
  config: RoomAssistantConfig;
  answers: Array<{ day: string; count: number }>;
}
export interface AssistantStateStore {
  load(): Promise<AssistantSavedState | null>;
  save(value: AssistantSavedState): Promise<void>;
}
export interface RoomAssistantServiceOptions {
  host: RoomAssistantHost;
  store: AssistantStateStore;
  /** Already-cached host facts. Only proven native-tools-off backends belong in this list. */
  backends(): AssistantBackendChoice[];
  quota?(config: RoomAssistantConfig): AssistantQuotaBand | Promise<AssistantQuotaBand>;
  now?: () => number;
}

const DAY = 86_400_000;
const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);
const initialConfig = (): RoomAssistantConfig => ({ enabled: false, backend: "claude-code", account: null, ...ROOM_ASSISTANT_DEFAULTS });

export function assistantConfig(value: unknown): RoomAssistantConfig {
  const v = value as Partial<RoomAssistantConfig> | null;
  if (!v || typeof v.enabled !== "boolean" || v.backend !== "claude-code"
    || v.account !== null && (typeof v.account !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.account))
    || !Number.isInteger(v.cap) || v.cap! < 1 || v.cap! > 16
    || !Number.isInteger(v.idleMinutes) || v.idleMinutes! < 1 || v.idleMinutes! > 240) {
    throw new Error("Invalid room assistant settings");
  }
  return { enabled: v.enabled, backend: v.backend, account: v.account, cap: v.cap!, idleMinutes: v.idleMinutes! };
}

/** Stable seam-4 provider owned by the Hub host Fleet, with separately mounted admin operations. */
export class RoomAssistantService implements RoomAssistant, RoomAssistantAdmin {
  private config = initialConfig();
  private runner?: RoomAssistantRunner;
  private readonly ready: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private answers = new Map<string, number>();
  private closed = false;
  private closing?: Promise<void>;
  private persistenceFailed = false;
  private readonly now: () => number;
  private roomEpochs = new Map<string, number>();

  constructor(private readonly options: RoomAssistantServiceOptions) {
    this.now = options.now ?? Date.now;
    this.ready = this.load();
    void this.ready.catch(() => {}); // available() remains paused; admin operations return the actual load error
  }

  available(): ReturnType<RoomAssistant["available"]> {
    return this.runner?.available() ?? { enabled: false, backend: this.config.backend, running: 0, cap: this.config.cap, state: "paused" };
  }

  async ask(input: RoomAssistantAsk): Promise<{ text: string }> {
    const epoch = this.roomEpochs.get(input.roomId) ?? 0;
    await this.ready;
    if (this.closed || !this.runner || epoch !== (this.roomEpochs.get(input.roomId) ?? 0)) throw new Error("Room assistant is unavailable");
    const result = await this.runner.ask(input);
    const today = dayOf(this.now());
    this.answers.set(today, (this.answers.get(today) ?? 0) + 1);
    // A counter-storage failure never discards an already completed room answer. The admin usage exposes the hint.
    void this.enqueue(async () => { await this.persist(); }).catch(() => { this.persistenceFailed = true; });
    return result;
  }

  forget(roomId: string): void {
    this.roomEpochs.set(roomId, (this.roomEpochs.get(roomId) ?? 0) + 1);
    this.runner?.forget(roomId);
  }

  async settings(): Promise<AssistantAdminSettings> {
    await this.ready;
    return { ...this.config, backends: this.options.backends(), running: this.runner?.instances() ?? [] };
  }

  async configure(value: unknown) {
    const next = assistantConfig(value);
    await this.ready;
    return this.enqueue(async () => {
      if (this.closed) throw new Error("Room assistant is stopping");
      if ((["enabled", "backend", "account", "cap", "idleMinutes"] as const).every(key => next[key] === this.config[key])) return this.settings();
      if (next.enabled && !this.options.backends().some(backend => backend.id === next.backend
        && backend.accounts.some(account => account.id === next.account && account.state !== "needs-sign-in"))) {
        throw new Error("Room assistant account needs sign-in");
      }
      const previous = this.config;
      await this.runner?.close(); // no replacement can start until every previous physical owner has drained
      try { await this.options.store.save({ config: next, answers: this.dailyAnswers() }); }
      catch (error) {
        if (!this.closed) this.runner = new RoomAssistantRunner(previous, this.options.host, this.now);
        throw error;
      }
      this.config = next;
      if (!this.closed) this.runner = new RoomAssistantRunner(next, this.options.host, this.now);
      return this.settings();
    });
  }

  async stopRoom(roomId: string): Promise<void> {
    await this.ready;
    await this.runner?.stopRoom(roomId);
  }

  async usage(): Promise<AssistantUsage> {
    await this.ready;
    const config = this.config;
    let band: AssistantQuotaBand = "unknown";
    try { band = await this.options.quota?.(config) ?? "unknown"; } catch { /* cached quota may be unavailable */ }
    if (this.config !== config) band = "unknown";
    return { days: this.dailyAnswers(), quota: { band },
      ...(this.persistenceFailed ? { note: "usage-not-saved" } : {}) };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const currentDrain = this.runner?.close(); // fence current asks now, including while a settings write is held
    this.closing = (async () => {
      await this.ready.catch(() => {}); // A failed load created no runner; it must not strand the owning Hub mount.
      await currentDrain;
      await this.serial;
      await this.runner?.close();
    })();
    return this.closing;
  }

  private async load(): Promise<void> {
    const saved = await this.options.store.load();
    if (saved) {
      this.config = assistantConfig(saved.config);
      if (!Array.isArray(saved.answers) || saved.answers.some(row => !row || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)
        || !Number.isSafeInteger(row.count) || row.count < 0)) throw new Error("Invalid room assistant usage");
      this.answers = new Map(saved.answers.map(row => [row.day, row.count]));
    }
    if (!this.closed) this.runner = new RoomAssistantRunner(this.config, this.options.host, this.now);
  }

  private dailyAnswers(): Array<{ day: string; count: number }> {
    const days = Array.from({ length: 7 }, (_, i) => dayOf(this.now() - (6 - i) * DAY));
    this.answers = new Map(days.map(day => [day, this.answers.get(day) ?? 0]));
    return [...this.answers].map(([day, count]) => ({ day, count }));
  }

  private async persist(): Promise<void> {
    await this.options.store.save({ config: this.config, answers: this.dailyAnswers() });
    this.persistenceFailed = false;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.catch(() => {});
    return result;
  }
}
