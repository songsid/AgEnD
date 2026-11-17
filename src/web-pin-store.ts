/**
 * M-3271 (the user: 「右鍵可以釘選訊息，這樣比較好找」): pinned web chat messages, kept on the host per agent.
 *
 *   <dataDir>/web-pins.json   { version: 1, rev, instances: { "<instance>": WebPin[] } }   (0600, atomic)
 *
 * A pin is a copy of the message — its text, author, time and attachment names — taken from the host's own chat history
 * (WebChatHistory.find: never the page's words), so it outlives the message leaving the 500-message window and a
 * restart. Newest first, at most PINS_MAX per agent. One file for the fleet's admins (as web-themes.json and
 * web-offices.json): every admin device reads the same pins, and `rev` moves on each change (an SSE `pins` frame tells
 * the open pages to read again). An unreadable file means no pins and every write refused (503), never overwritten;
 * memory changes only once a write is on disk. What is read back is checked again, pin by pin (one that does not check
 * is dropped, the rest kept). An agent's pins go with it (forget, beside the chat history's).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import type { WebChatMessage } from "./web-chat-history.js";

/** Pins per agent; the page says so plainly when one more is asked for. */
export const PINS_MAX = 50;
/** A pin's copy of the words: longer messages keep their start (the message itself, while it is in the chat, is whole). */
export const PIN_TEXT_MAX = 4000;
export const PIN_FILES_MAX = 10;
const NAME_MAX = 200, SENDER_MAX = 200, INSTANCES_MAX = 500;
const KEY = /^([0-9a-f]{1,32})-(\d{1,15})$/;

export interface WebPinFile { name: string; kind: "photo" | "document" }
export interface WebPin {
  /** The message's key in the chat (`<boot>-<id>`): what the page jumps to. */
  key: string;
  role: "agent" | "user";
  sender: string;
  text: string;
  /** The message's own time (ISO). */
  ts: string;
  files?: WebPinFile[];
  /** When it was pinned (ISO). */
  pinnedAt: string;
}
export type PinWrite = { ok: true; rev: number; pins: WebPin[]; changed: boolean } | { ok: false; status: number; error: string };
type State = { rev: number; instances: Map<string, WebPin[]> } | "unreadable";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const iso = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A pin as read back from disk, or null when it no longer checks. */
function readPin(raw: unknown): WebPin | null {
  if (!isObj(raw)) return null;
  const { key, role, sender, text, ts, files, pinnedAt } = raw;
  if (typeof key !== "string" || !KEY.test(key) || (role !== "agent" && role !== "user") || !str(sender, SENDER_MAX)
    || !str(text, PIN_TEXT_MAX) || !iso(ts) || !iso(pinnedAt)) return null;
  const pin: WebPin = { key, role, sender, text, ts, pinnedAt };
  if (files !== undefined) {
    if (!Array.isArray(files) || files.length > PIN_FILES_MAX) return null;
    const out: WebPinFile[] = [];
    for (const f of files) {
      if (!isObj(f) || !str(f.name, NAME_MAX) || (f.kind !== "photo" && f.kind !== "document")) return null;
      out.push({ name: f.name, kind: f.kind });
    }
    if (out.length) pin.files = out;
  }
  return pin;
}

/** The copy a pin keeps of a message in the chat history; null for a line that is not a message (a status line). */
export function pinOf(row: WebChatMessage, pinnedAt: string): WebPin | null {
  if (row.role !== "agent" && row.role !== "user") return null;
  const files = (row.attachments ?? []).slice(0, PIN_FILES_MAX).map((a): WebPinFile => ({ name: clip(String(a.name ?? ""), NAME_MAX), kind: a.kind === "photo" ? "photo" : "document" }));
  const words = String(row.click?.label ?? row.text ?? "");
  return { key: `${row.boot}-${row.id}`, role: row.role, sender: clip(String(row.sender ?? ""), SENDER_MAX), text: clip(words, PIN_TEXT_MAX),
    ts: iso(row.ts) ? row.ts : pinnedAt, ...(files.length ? { files } : {}), pinnedAt };
}

export class WebPinStore {
  private state: State | null = null;
  readonly path: string;
  constructor(dataDir: string, private readonly now: () => Date = () => new Date()) { this.path = join(dataDir, "web-pins.json"); }

  private load(): State {
    if (this.state) return this.state;
    let body: string;
    try { body = readFileSync(this.path, "utf8"); }
    catch (err) { return (this.state = (err as NodeJS.ErrnoException).code === "ENOENT" ? { rev: 0, instances: new Map() } : "unreadable"); }
    try {
      const doc = JSON.parse(body) as { version?: unknown; rev?: unknown; instances?: unknown };
      if (doc.version !== 1 || !Number.isSafeInteger(doc.rev) || !isObj(doc.instances)) return (this.state = "unreadable");
      const instances = new Map<string, WebPin[]>();
      for (const [name, list] of Object.entries(doc.instances).slice(0, INSTANCES_MAX)) {
        if (!Array.isArray(list)) continue;
        const seen = new Set<string>(), pins: WebPin[] = [];
        for (const raw of list.slice(0, PINS_MAX)) { const p = readPin(raw); if (p && !seen.has(p.key)) { seen.add(p.key); pins.push(p); } }
        if (pins.length) instances.set(name, pins);
      }
      return (this.state = { rev: doc.rev as number, instances });
    } catch { return (this.state = "unreadable"); }
  }
  /** On disk first, then in memory; the rev moves. */
  private save(s: Exclude<State, "unreadable">, instances: Map<string, WebPin[]>): number {
    const rev = s.rev + 1;
    const doc = { version: 1, rev, instances: Object.fromEntries([...instances].filter(([, l]) => l.length)) };
    atomicWriteFileSync(this.path, JSON.stringify(doc), { mode: 0o600 });
    this.state = { rev, instances };
    return rev;
  }

  readable(): boolean { return this.load() !== "unreadable"; }
  rev(): number { const s = this.load(); return s === "unreadable" ? 0 : s.rev; }
  /** One agent's pins, newest first (a copy); none when the file is unreadable. */
  list(instance: string): WebPin[] {
    const s = this.load();
    return s === "unreadable" ? [] : (s.instances.get(instance) ?? []).map(p => ({ ...p, ...(p.files ? { files: p.files.map(f => ({ ...f })) } : {}) }));
  }
  /** Pin a message of the chat history (pinning one already pinned changes nothing). */
  pin(instance: string, row: WebChatMessage): PinWrite {
    const s = this.load();
    if (s === "unreadable") return { ok: false, status: 503, error: "pins_unreadable" };
    const pin = pinOf(row, this.now().toISOString());
    if (!pin) return { ok: false, status: 400, error: "pin_not_a_message" };
    const cur = s.instances.get(instance) ?? [];
    if (cur.some(p => p.key === pin.key)) return { ok: true, rev: s.rev, pins: this.list(instance), changed: false };
    if (cur.length >= PINS_MAX) return { ok: false, status: 409, error: "pins_full" };
    const next = new Map(s.instances); next.set(instance, [pin, ...cur]);
    const rev = this.save(s, next);
    return { ok: true, rev, pins: this.list(instance), changed: true };
  }
  /** Unpin by the message's key (one not pinned changes nothing). */
  unpin(instance: string, key: string): PinWrite {
    const s = this.load();
    if (s === "unreadable") return { ok: false, status: 503, error: "pins_unreadable" };
    const cur = s.instances.get(instance) ?? [];
    if (!cur.some(p => p.key === key)) return { ok: true, rev: s.rev, pins: this.list(instance), changed: false };
    const next = new Map(s.instances); next.set(instance, cur.filter(p => p.key !== key));
    const rev = this.save(s, next);
    return { ok: true, rev, pins: this.list(instance), changed: true };
  }
  /** An agent removed: its pins go (as its chat history). False when nothing was kept for it or the file is unreadable. */
  forget(instance: string): boolean {
    const s = this.load();
    if (s === "unreadable" || !s.instances.has(instance)) return false;
    const next = new Map(s.instances); next.delete(instance);
    this.save(s, next);
    return true;
  }
}

/** A message key as the page sends it (`<boot>-<id>`), split; null when it is not one. */
export function parsePinKey(key: unknown): { boot: string; id: number } | null {
  if (typeof key !== "string") return null;
  const m = KEY.exec(key);
  if (!m) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) ? { boot: m[1]!, id } : null;
}
