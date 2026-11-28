/** Native Claude boundaries only. Input matching and runtime authority remain with C. */
import type { TranscriptTurnEvent } from "./transcript-turns.js";

export interface ClaudeTurnBinding {
  launchId: string;
  startedAt: number;
  sessionId: string;
  transcriptPath: string;
}
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const MAX_RECORDS = 4096;
interface OpenTurn {
  id: string;
  records: Set<string>;
  assistants: Map<string, "complete" | "error" | "aborted">;
}
/** One owned launch/session/path. A copied duration can never end an unobserved prompt. */
export class ClaudeTurnBoundaries {
  private binding: string | null = null;
  private open: OpenTurn | null = null;
  reset(reason: "interrupt" | "reset" | "capacity" = "reset"): TranscriptTurnEvent[] {
    const previous = this.open;
    this.open = null; this.binding = null;
    return previous ? [{ kind: "retract", turnId: previous.id, reason }] : [];
  }
  observe(entry: any, binding: Readonly<ClaudeTurnBinding>, now: number): TranscriptTurnEvent[] {
    if (!binding.launchId || !uuid(binding.sessionId) || !binding.transcriptPath
      || !Number.isSafeInteger(binding.startedAt) || binding.startedAt < 0) return this.reset();
    const key = JSON.stringify([binding.launchId, binding.startedAt, binding.sessionId, binding.transcriptPath]);
    const events = this.binding === key ? [] : this.reset();
    this.binding = key;
    // Recorded interrupt user stubs can lack native UUID/session metadata. They
    // cannot prove an end. On an owned file they only withdraw boundary evidence,
    // leaving C open with an explicit unknown-end/Stop-this-work path.
    const at = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isSafeInteger(at) || at < binding.startedAt || at > now) return events;
    const interrupt = entry?.type === "user" && entry?.message?.role === "user"
      && Array.isArray(entry.message.content) && entry.message.content.length === 1
      && entry.message.content[0]?.type === "text"
      && typeof entry.message.content[0].text === "string"
      && /^\[Request interrupted by user(?: for tool use)?\]$/.test(entry.message.content[0].text);
    if (interrupt && entry.isSidechain === false && (entry.isMeta === undefined || entry.isMeta === false)
      && !entry.agentId && !entry.agent_id && !entry.subagent_type && !entry.subagentType
      && (!entry.sessionId || entry.sessionId === binding.sessionId) && (!entry.session_id || entry.session_id === binding.sessionId)) {
      return [...events, ...this.reset("interrupt")];
    }
    // Compaction can be meta. It withdraws evidence but never grants a boundary.
    if (entry?.type === "system" && entry.subtype === "compact_boundary"
      && entry.isSidechain === false && entry.sessionId === binding.sessionId
      && !entry.agentId && !entry.agent_id && !entry.subagent_type && !entry.subagentType) {
      return [...events, ...this.reset()];
    }
    if (!entry || entry.isSidechain !== false || entry.isMeta === true || entry.agentId || entry.agent_id
      || entry.subagent_type || entry.subagentType || !uuid(entry.uuid)
      || ["isMeta", "isApiErrorMessage"].some(field => entry[field] !== undefined && typeof entry[field] !== "boolean")
      || entry.sessionId !== binding.sessionId || entry.session_id !== undefined && entry.session_id !== binding.sessionId) return events;
    const message = entry.message;
    const prompt = entry.type === "user" && message?.role === "user" && (typeof message.content === "string"
      ? message.content : Array.isArray(message.content) && message.content.length > 0
        && message.content.every((part: any) => part?.type === "text" && typeof part.text === "string")
        ? message.content.map((part: { text: string }) => part.text).join("\n") : null);
    if (typeof prompt === "string" && prompt.trim()) {
      // Tool-result/meta records never enter here. Several real inputs (a steer)
      // can belong to the same still-open provider turn.
      if (!this.open) {
        const id = `claude:${binding.sessionId}:${entry.uuid}`;
        this.open = { id, records: new Set(), assistants: new Map() };
        events.push({ kind: "start", turnId: id });
      }
      if (!this.open.records.has(entry.uuid)) {
        this.open.records.add(entry.uuid);
        events.push({ kind: "user", turnId: this.open.id, text: prompt, at });
      }
    } else if (this.open && uuid(entry.parentUuid) && this.open.records.has(entry.parentUuid)) {
      if (entry.type === "system" && entry.subtype === "turn_duration") {
        const end = this.open.assistants.get(entry.parentUuid);
        if (end) { events.push({ kind: "end", turnId: this.open.id, end }); this.open = null; }
      } else {
        this.open.records.add(entry.uuid);
        if (entry.type === "assistant" && message?.role === "assistant") {
          const end = entry.isApiErrorMessage === true ? "error"
            : ["end_turn", "stop_sequence", "max_tokens"].includes(message.stop_reason) ? "complete" : "aborted";
          this.open.assistants.set(entry.uuid, end);
        }
      }
    }
    if (this.open && this.open.records.size > MAX_RECORDS) events.push(...this.reset("capacity"));
    return events;
  }
}
