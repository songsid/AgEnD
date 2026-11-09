/**
 * Telegram updates that arrived after a downtime longer than
 * TELEGRAM_PENDING_LIVE_MAX_MS are filed here for Needs you, never injected
 * into an agent. Persisted so a restart does not re-offer or lose them.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

/** Telegram itself drops the queue after about a day; we keep the same window. */
export const MISSED_OFFLINE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MISSED_OFFLINE_MAX_ITEMS = 50;
const FILE = "missed-offline.json";

export interface MissedOfflineRecord {
  id: string;
  adapterId: string;
  instance: string;
  username: string;
  place: string;
  preview: string;
  since: number;
  recordedAt: number;
}

interface FileShape {
  items: MissedOfflineRecord[];
}

export class MissedOfflineStore {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, FILE);
  }

  list(now: number): MissedOfflineRecord[] {
    return this.read().filter(item => now - item.since <= MISSED_OFFLINE_MAX_AGE_MS);
  }

  add(record: Omit<MissedOfflineRecord, "recordedAt"> & { recordedAt?: number }): MissedOfflineRecord {
    const items = this.read();
    const existing = items.find(item => item.id === record.id);
    if (existing) return existing;
    const next: MissedOfflineRecord = {
      ...record,
      recordedAt: record.recordedAt ?? Date.now(),
    };
    items.push(next);
    items.sort((a, b) => a.since - b.since);
    this.write(items.slice(-MISSED_OFFLINE_MAX_ITEMS));
    return next;
  }

  /** true when this call removed it. */
  acknowledge(id: string, _by: string): boolean {
    const items = this.read();
    const next = items.filter(item => item.id !== id);
    if (next.length === items.length) return false;
    this.write(next);
    return true;
  }

  private read(): MissedOfflineRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path(), "utf8"));
      if (!parsed || typeof parsed !== "object") return [];
      const items = (parsed as FileShape).items;
      if (!Array.isArray(items)) return [];
      return items.filter(isMissedOfflineRecord);
    } catch {
      return [];
    }
  }

  private write(items: MissedOfflineRecord[]): void {
    mkdirSync(dirname(this.path()), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.path(), `${JSON.stringify({ items } satisfies FileShape)}\n`, { mode: 0o600 });
  }
}

function isMissedOfflineRecord(value: unknown): value is MissedOfflineRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && v.id.startsWith("missed:")
    && typeof v.adapterId === "string"
    && typeof v.instance === "string"
    && typeof v.username === "string"
    && typeof v.place === "string"
    && typeof v.preview === "string"
    && typeof v.since === "number"
    && typeof v.recordedAt === "number";
}
