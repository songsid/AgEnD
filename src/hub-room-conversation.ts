/** Fleet-owned conversation identity. No Hub imports: disabled Fleets keep Hub runtime loading lazy. */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { HUB_REPORT_TARGET } from "./hub-report-target.js";
const ID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** An internal consumed-watch marker, never a human receipt or caller-supplied authority. */
export function roomContextInputMarker(meta: Record<string,string>): string | null {
  return meta.from_instance === HUB_REPORT_TARGET && ID.test(meta.hub_room_context_generation ?? "")
    && /^hub-room-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(meta.correlation_id ?? "")
    ? `[agend-room-input:${meta.correlation_id}]` : null;
}
export class RoomConversationGeneration {
  private value: string | null = null;
  private session: string | null = null;
  constructor(private readonly directory: string) {}
  private get path(): string { return join(this.directory,"hub-room-conversation.json"); }
  current(): string | null { return this.value; }
  start(reattached: boolean): void {
    this.value=null;this.session=null;
    if (reattached) try {
      if (statSync(this.path).size>1024) throw Error("Invalid conversation generation");
      const saved=JSON.parse(readFileSync(this.path,"utf8"));
      if (saved.v!==1 || !ID.test(saved.generation) || saved.session!==null && (typeof saved.session!=="string" || saved.session.length>256)) throw Error("Invalid conversation generation");
      this.value=saved.generation;this.session=saved.session;return;
    } catch { /* Unconfirmed retained state starts a full window, never a delta. */ }
    this.reset();
  }
  reset(): void {
    this.value=null;this.session=null;
    const generation=randomUUID();this.write(generation,null);this.value=generation;
  }
  observeSession(session: string | null): void {
    if (!this.value || !session || session.length>256 || /[\u0000-\u001f\u007f]/.test(session) || session===this.session) return;
    if (this.session!==null) this.reset();
    this.write(this.value!,session);this.session=session;
  }
  private write(generation: string, session: string | null): void {
    const temporary=`${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary,JSON.stringify({v:1,generation,session}),{mode:0o600});renameSync(temporary,this.path);
  }
}
