import { EventEmitter } from "node:events";
import { open, stat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import type { TranscriptSource } from "./transcript-sources.js";

/**
 * Emits tool_use / tool_result / assistant_text events off the CLI's own
 * conversation record.
 *
 * Two modes:
 *  - claude-code (default): follow the transcript JSONL named by
 *    statusline.json, with a persisted byte offset. Built in because it
 *    predates the pluggable sources.
 *  - other backends: delegate to a {@link TranscriptSource} (codex rollouts,
 *    kiro session JSONL, opencode sqlite — see transcript-sources.ts).
 */
export class TranscriptMonitor extends EventEmitter {
  private byteOffset: number = 0;
  private transcriptPath: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private offsetFile: string;
  private polling = false; // reentry guard for pollIncrement

  constructor(
    private instanceDir: string,
    private logger: Logger,
    private source: TranscriptSource | null = null,
  ) {
    super();
    this.offsetFile = join(instanceDir, "transcript-offset");
    // Persisted offsets are only meaningful for the claude-code transcript;
    // sources re-resolve and re-baseline themselves (a stale byte offset into
    // a codex rollout that no longer exists would be nonsense).
    if (!this.source) this.loadOffset();
  }

  private loadOffset(): void {
    try {
      if (existsSync(this.offsetFile)) {
        const data = JSON.parse(readFileSync(this.offsetFile, "utf-8"));
        this.byteOffset = data.offset ?? 0;
        this.transcriptPath = data.path ?? null;
      }
    } catch {
      // Start fresh if corrupt
    }
  }

  private saveOffset(): void {
    if (this.source) return;
    try {
      writeFileSync(this.offsetFile, JSON.stringify({
        offset: this.byteOffset,
        path: this.transcriptPath,
      }));
    } catch {
      // Non-critical — will re-read some entries on restart
    }
  }

  async resolveTranscriptPath(): Promise<string | null> {
    const statusFile = join(this.instanceDir, "statusline.json");
    if (existsSync(statusFile)) {
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        if (data.transcript_path) return data.transcript_path;
      } catch {
        // Status file may be partially written — retry on next poll
      }
    }
    return null;
  }

  async pollIncrement(): Promise<void> {
    // Reentry guard: setInterval keeps firing even when the previous poll is
    // still awaiting stat/read. Two concurrent runs would race on byteOffset
    // (both could read the same byte range and emit duplicate entries).
    if (this.polling) return;
    this.polling = true;
    try {
      if (this.source) {
        await this.pollSource();
      } else {
        await this._doPoll();
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollSource(): Promise<void> {
    try {
      const events = await this.source!.poll();
      for (const use of events.toolUses) this.emit("tool_use", use.name, use.input);
      for (const result of events.toolResults) this.emit("tool_result", result.name, undefined);
      for (const text of events.assistantTexts) this.emit("assistant_text", text);
    } catch (err) {
      this.logger.debug({ err }, "TranscriptSource poll error");
    }
  }

  private async _doPoll(): Promise<void> {
    // Always compare against the freshly resolved path — never just "do I
    // have a path". A resumed claude-code writes a NEW transcript after a
    // restart; a monitor pinned to the persisted previous path watches a file
    // that never grows again and reports nothing, with no error (#528 trap 1).
    const current = await this.resolveTranscriptPath();
    if (current && current !== this.transcriptPath) {
      const replacedKnownTranscript = this.transcriptPath !== null;
      this.transcriptPath = current;
      if (replacedKnownTranscript) {
        // Work resumed during our own startup must be observable → read the
        // replacement from the top.
        this.byteOffset = 0;
        this.saveOffset();
      } else {
        // First-ever attach: baseline to EOF so history does not replay.
        try {
          this.byteOffset = (await stat(current)).size;
        } catch {
          this.byteOffset = 0;
        }
        this.saveOffset();
        return;
      }
    }
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return;

    try {
      const stats = await stat(this.transcriptPath);
      if (stats.size <= this.byteOffset) return;

      const fh = await open(this.transcriptPath, "r");
      try {
        const length = stats.size - this.byteOffset;
        const buffer = Buffer.alloc(length);
        await fh.read(buffer, 0, length, this.byteOffset);
        this.byteOffset = stats.size;

        const text = buffer.toString("utf-8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            this.processEntry(entry);
          } catch {
            // Malformed JSONL line in transcript — skip
          }
        }

        this.saveOffset();
      } finally {
        await fh.close();
      }
    } catch (err) {
      this.logger.debug({ err }, "TranscriptMonitor poll error");
    }
  }

  private processEntry(entry: any): void {
    const msg = entry.message;
    if (!msg?.role || !msg?.content) return;

    const contents = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];

    for (const block of contents) {
      if (block.type === "tool_use") {
        this.emit("tool_use", block.name ?? "unknown", block.input ?? {});
      } else if (block.type === "tool_result") {
        this.emit("tool_result", block.tool_use_id ?? "unknown", block.content);
      } else if (block.type === "text" && msg.role === "assistant" && block.text?.trim()) {
        this.emit("assistant_text", block.text);
      }
    }
  }

  startPolling(intervalMs = 2000): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollIncrement(), intervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.saveOffset();
  }

  setTranscriptPath(path: string): void {
    if (this.transcriptPath !== path) {
      this.resetOffset();
    }
    this.transcriptPath = path;
  }

  resetOffset(): void {
    this.byteOffset = 0;
    this.transcriptPath = null;
    this.source?.reset();
    this.saveOffset();
  }
}
