/** Physical admission only. A slot or a successful read never supplies authority. */
import type { PersonKey } from "../types.js";
import { person, validated } from "../validation.js";
import { personKeyString, sha256 } from "../identity.js";
import { HubGroupPolicyError, HubGroupReadOverload } from "../group-policy/errors.js";

export const DIRECTORY_PER_PERSON = 4;
export const DIRECTORY_TOTAL = 32;
export interface HubDirectoryReads {
  withDirectoryRead<T>(subject: PersonKey, work: () => Promise<T>): Promise<T>;
  withLoginRead<T>(login: string, work: () => Promise<T>): Promise<T>;
}
export function createHubDirectoryAdmission(current: () => boolean) {
  const inflight = new Map<string, number>();
  let total = 0, fenced = false;
  const drained = new Set<() => void>();
  const live = () => { if (fenced || current() !== true) throw new HubGroupPolicyError("unavailable"); };
  const run = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    live(); const mine = inflight.get(key) ?? 0;
    if (mine >= DIRECTORY_PER_PERSON || total >= DIRECTORY_TOTAL) throw new HubGroupReadOverload();
    inflight.set(key, mine + 1); total++;
    // This owner governs physical work only. Each caller fences the result before its own effect or disclosure.
    try { return await work(); }
    finally {
      const left = (inflight.get(key) ?? 1) - 1;
      if (left) inflight.set(key, left); else inflight.delete(key);
      total--;
      if (!total) { const ready = [...drained]; drained.clear(); ready.forEach(resolve => resolve()); }
    }
  };
  return {
    withDirectoryRead<T>(subject: PersonKey, work: () => Promise<T>): Promise<T> {
      const who = validated(person, subject);
      return run(`person:${personKeyString(who)}`, work);
    },
    withLoginRead<T>(login: string, work: () => Promise<T>): Promise<T> {
      // The caller validates its login syntax; this bound only avoids unbounded admission keys.
      if (typeof login !== "string" || !login.length || login.length > 1024) return Promise.reject(new HubGroupPolicyError("invalid"));
      return run(`login:${sha256(login.toLowerCase())}`, work);
    },
    fence() { fenced = true; },
    /** Never release physical work on caller cancellation, timeout or mount retirement. */
    drain(): Promise<void> {
      fenced = true;
      return total ? new Promise<void>(resolve => drained.add(resolve)) : Promise.resolve();
    },
  } satisfies HubDirectoryReads & { fence(): void; drain(): Promise<void> };
}
