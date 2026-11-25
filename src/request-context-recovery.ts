import type Database from "better-sqlite3";
import { z } from "zod";
import { RequestContextStore } from "./request-context-store.js";
import type { RequestContextV1 } from "./request-context-protocol.js";
import type { PreparedRequestContextInput, RequestContextRecoveryPointer, RequestContextTurnPorts } from "./request-context-turns.js";
const text = z.string().min(1).max(256);
const pointerSchema = z.strictObject({ instance: text, incarnation: text, workGeneration: text, contextId: z.uuid() });
/** Only the last conservative recovery pointer is durable. Active turn ownership is never restored from disk. */
export class RequestContextRecoveryStore {
  constructor(private readonly db: Database.Database, private readonly writable: () => void) {}
  retain(context: RequestContextV1): void {
    this.writable(); this.db.transaction(() => new RequestContextStore(this.db).recordContext(context))();
  }
  pointer(instance: string): RequestContextRecoveryPointer | null {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_context_recovery_v1'").get()) return null;
    const row = this.db.prepare("SELECT pointer_json FROM request_context_recovery_v1 WHERE instance=?").get(instance) as { pointer_json: string } | undefined;
    if (!row) return null;
    const pointer = pointerSchema.parse(JSON.parse(row.pointer_json));
    const context = new RequestContextStore(this.db).context(pointer.contextId);
    if (pointer.instance !== instance || !context || context.source.instance !== instance || context.source.incarnation !== pointer.incarnation
      || context.ingress === "owner") throw Error("request-context recovery pointer unavailable");
    return pointer;
  }
  save(instance: string, input: RequestContextRecoveryPointer | null): void {
    this.writable();
    this.db.transaction(() => {
      const pointer = input ? pointerSchema.parse(input) : null;
      if (pointer) {
        const context = new RequestContextStore(this.db).context(pointer.contextId);
        if (pointer.instance !== instance || !context || context.source.instance !== instance || context.source.incarnation !== pointer.incarnation
          || context.ingress === "owner") throw Error("request-context recovery pointer mismatch");
      }
      this.db.exec("CREATE TABLE IF NOT EXISTS request_context_recovery_v1(instance TEXT PRIMARY KEY,pointer_json TEXT NOT NULL)");
      if (pointer) this.db.prepare("INSERT INTO request_context_recovery_v1 VALUES (?,?) ON CONFLICT(instance) DO UPDATE SET pointer_json=excluded.pointer_json")
        .run(instance, JSON.stringify(pointer));
      else this.db.prepare("DELETE FROM request_context_recovery_v1 WHERE instance=?").run(instance);
    })();
  }
  /** Prepared input is resolved by trusted admission/attempt/job identity; no text or model argument resolver is supplied. */
  ports(instance: string, input: (id: string) => PreparedRequestContextInput | null,
    canManage: RequestContextTurnPorts["canManage"]): RequestContextTurnPorts {
    return { input, canManage, context: id => new RequestContextStore(this.db).context(id),
      retain: context => this.retain(context), recovery: () => this.pointer(instance), saveRecovery: pointer => this.save(instance, pointer) };
  }
}
