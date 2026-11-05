/** Closed, bounded machine data. Error strings are static and safe for transport. */
import { z } from "zod";
export const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const token = z.string().regex(/^[a-f0-9]{64}$/);
export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const reason = z.enum(["unavailable", "denied", "stale", "incompatible", "invalid", "conflict", "uncertain", "revoked", "expired", "backpressure", "not-found"]);
export const person = z.strictObject({ realm: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), objectId: uuid });
export const plain = (max: number) => z.string().refine(s => Buffer.byteLength(s, "utf8") <= max && scalarString(s), "Invalid text");
export function scalarString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const n = s.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) { const low = s.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) return false; }
    else if (n >= 0xdc00 && n <= 0xdfff) return false;
  }
  return true;
}
export class HubProtocolError extends Error {
  constructor(readonly code: z.infer<typeof reason> = "invalid") { super(`Hub protocol: ${code}`); }
}
/** JSON.parse alone silently accepts duplicate keys, including escaped spellings of the same key. */
export function parseStrictJson(input: string | Buffer, limit = 256 * 1024): unknown {
  if (typeof input === "string" && !scalarString(input)) throw new HubProtocolError();
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (bytes.length > limit) throw new HubProtocolError("backpressure");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new HubProtocolError(); }
  if (!scalarString(text)) throw new HubProtocolError();
  let at = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[at] ?? "!") && at < text.length) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') {
        let value: string;
        try { value = JSON.parse(text.slice(start, at)); } catch { throw new HubProtocolError(); }
        if (!scalarString(value)) throw new HubProtocolError();
        return value;
      }
      if (c === "\\") at++;
    }
    throw new HubProtocolError();
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new HubProtocolError();
    ws();
    if (text[at] === '"') { string(); return; }
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{", end = object ? "}" : "]", keys = new Set<string>();
      ws(); if (text[at] === end) { at++; return; }
      for (;;) {
        if (object) {
          ws(); if (text[at] !== '"') throw new HubProtocolError();
          const key = string(); if (keys.has(key)) throw new HubProtocolError(); keys.add(key);
          ws(); if (text[at++] !== ":") throw new HubProtocolError();
        }
        value(depth + 1); ws();
        if (text[at] === end) { at++; return; }
        if (text[at++] !== ",") throw new HubProtocolError();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!match) throw new HubProtocolError();
    at += match[0].length;
    if (/^-?\d/.test(match[0])) { const n = Number(match[0]); if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new HubProtocolError(); }
  };
  value(0); ws(); if (at !== text.length) throw new HubProtocolError();
  try { return JSON.parse(text); } catch { throw new HubProtocolError(); }
}
export function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HubProtocolError();
  return result.data;
}
