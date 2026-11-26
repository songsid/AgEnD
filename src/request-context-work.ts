/** Conversation work identity is owned by lifecycle events, never by backend session discovery or a timer. */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
const key = z.string().min(1).max(256);
const row = z.strictObject({ instance: key, incarnation: key, generation: z.uuid() });
export type RequestContextWorkIdentity = Readonly<z.infer<typeof row>>;
const TABLE = "request_context_work_v1";
export class RequestContextWorkStore {
 constructor(private readonly db: Database.Database, private readonly writable: () => void) {}
 read(instance: string): RequestContextWorkIdentity | null {
  key.parse(instance);
  const table = this.db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(TABLE) as { type: string } | undefined;
  if (!table) return null;
  if (table.type !== "table") throw Error("Request-context work identity unavailable");
  const stored = this.db.prepare(`SELECT instance,incarnation,generation FROM ${TABLE} WHERE instance=?`).get(instance);
  return stored ? Object.freeze(row.parse(stored)) : null;
 }
 /** First activation stages UUIDs in memory, then retains the same identities in its outer transaction. */
 retain(value: RequestContextWorkIdentity): RequestContextWorkIdentity {
  const input = row.parse(value); this.writable();
  return this.db.transaction(() => {
   const previous = this.read(input.instance);
   if (previous) {
    if (previous.incarnation !== input.incarnation || previous.generation !== input.generation) throw Error("Request-context work identity differs");
    return previous;
   }
   this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(instance TEXT PRIMARY KEY,incarnation TEXT NOT NULL,generation TEXT NOT NULL)`);
   this.db.prepare(`INSERT INTO ${TABLE} VALUES (?,?,?)`).run(input.instance,input.incarnation,input.generation);
   this.writable(); return this.read(input.instance)!;
  })();
 }
 /** Only a proven fresh lifecycle boundary calls this. A written Clear, compact and session discovery do not prove one. */
 rotate(expected: RequestContextWorkIdentity): RequestContextWorkIdentity {
  const before = row.parse(expected); this.writable();
  return this.db.transaction(() => {
   const stored = this.read(before.instance);
   if (!stored || stored.incarnation !== before.incarnation || stored.generation !== before.generation) throw Error("Request-context work identity changed");
   const next = { ...before, generation: randomUUID() };
   if (this.db.prepare(`UPDATE ${TABLE} SET generation=? WHERE instance=? AND incarnation=? AND generation=?`)
    .run(next.generation,before.instance,before.incarnation,before.generation).changes !== 1) throw Error("Request-context work identity changed");
   // Recovery history remains explainable. Its old generation is not adopted into the new work, and is
   // resolved explicitly by the owning recovery/clear action rather than silently relabelled or reset here.
   this.writable(); return Object.freeze(next);
  })();
 }
}
