/** Personal-agent answers are terminal protocol data, never the Runtime preview's mixed output. */
import { StringDecoder } from "node:string_decoder";

export type PersonalAgentCli = "codex" | "claude-code";
export type PersonalAnswer = { ok: true; answer: string }
  | { ok: false; reason: "failed" | "interrupted" | "incomplete" | "empty" | "protocol" | "output-limit" };
const MAX_STREAM = 1024 * 1024;
const MAX_ANSWER = 64 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One reader per one-shot process. Nothing is disclosed until both the protocol and process finish successfully. */
export class PersonalAgentAnswerReader {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private bytes = 0;
  private started = false;
  private completed = false;
  private answer = "";
  private failure: Extract<PersonalAnswer, { ok: false }>["reason"] | null = null;
  private settled: PersonalAnswer | null = null;
  constructor(private readonly cli: PersonalAgentCli) {
    if (cli !== "codex" && cli !== "claude-code") throw Error("Unsupported personal agent CLI");
  }
  write(chunk: Uint8Array): void {
    if (this.settled || this.failure) return;
    this.bytes += chunk.byteLength;
    if (this.bytes > MAX_STREAM) { this.failure = "output-limit"; this.pending = ""; return; }
    this.pending += this.decoder.write(Buffer.from(chunk));
    this.lines();
  }
  private lines(): void {
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end).trim(); this.pending = this.pending.slice(end + 1);
      if (line) this.line(line);
    }
  }
  private line(line: string): void {
    if (this.failure) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { this.failure = "protocol"; return; }
    if (!object(event)) { this.failure = "protocol"; return; }
    if (event.type === "error" || event.type === "turn.failed") { this.failure = "failed"; return; }
    if (this.cli === "codex") {
      if (event.type === "turn.started") {
        if (this.started || this.completed) this.failure = "protocol";
        this.started = true;
      } else if (event.type === "item.completed" && object(event.item) && event.item.type === "agent_message") {
        if (!this.started || this.completed || typeof event.item.text !== "string") this.failure = "protocol";
        else this.answer = event.item.text;
      } else if (event.type === "turn.completed") {
        if (!this.started || this.completed) this.failure = "protocol";
        this.completed = true;
      }
      // Command text, tool output, commentary and metadata never become an answer.
    } else if (event.type === "result") {
      if (this.completed) { this.failure = "protocol"; return; }
      if (event.subtype !== "success" || event.is_error === true) { this.failure = "failed"; return; }
      if (typeof event.result !== "string") { this.failure = "protocol"; return; }
      this.answer = event.result; this.completed = true;
    }
  }
  finish(exitCode: number | null, cancelled = false): PersonalAnswer {
    if (this.settled) return { ...this.settled };
    this.pending += this.decoder.end(); this.lines();
    if (this.pending.trim()) this.line(this.pending.trim()); this.pending = "";
    const answer = this.answer.trim();
    const reason = cancelled ? "interrupted" : exitCode !== 0 ? "failed" : this.failure
      ?? (!this.completed ? "incomplete" : !answer ? "empty" : Buffer.byteLength(answer) > MAX_ANSWER ? "output-limit"
        : answer.includes("\0") || Buffer.from(answer).toString("utf8") !== answer ? "protocol" : null);
    this.answer = "";
    this.settled = reason ? { ok: false, reason } : { ok: true, answer };
    return { ...this.settled };
  }
}
