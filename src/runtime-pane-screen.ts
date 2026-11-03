import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { PANE_MAX_CAPTURE_BYTES } from "./runtime-pane-protocol.js";

const { Terminal } = headless;
const { SerializeAddon } = serialize;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;

/** Bounded VT state. Captures are parsed terminal cells, never a concatenation of CLI stdout. */
export class RuntimePaneScreen {
  private readonly terminal: InstanceType<typeof Terminal>;
  private readonly serializer = new SerializeAddon();
  private pending = Promise.resolve();
  private queuedBytes = 0;
  private disposed = false;
  private failed = false;
  constructor(columns: number, rows: number, answer: (data: string) => void) {
    this.terminal = new Terminal({ cols: columns, rows, scrollback: 2000, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer);
    // Device/cursor queries receive only the emulator's protocol reply. OSC clipboard handlers are absent.
    this.terminal.onData(data => { if (!this.disposed && !this.failed) answer(data); });
  }
  write(data: string): Promise<void> {
    if (this.disposed || this.failed) return Promise.reject(Error("Pane screen is unavailable"));
    const bytes = Buffer.byteLength(data);
    if (this.queuedBytes + bytes > MAX_PENDING_BYTES) { this.failed = true; return Promise.reject(Error("Pane parser backpressure limit reached")); }
    this.queuedBytes += bytes;
    const write = this.pending.then(() => new Promise<void>((resolve, reject) => {
      if (this.disposed || this.failed) { reject(Error("Pane screen is unavailable")); return; }
      const timer = setTimeout(() => { this.failed = true; reject(Error("Pane parser deadline exceeded")); }, 10_000);
      this.terminal.write(data, () => { clearTimeout(timer); resolve(); });
    })).finally(() => { this.queuedBytes -= bytes; });
    this.pending = write.catch(() => { this.failed = true; });
    return write;
  }
  async capture(options: { history?: number; joined?: boolean; ansi?: boolean } = {}): Promise<string> {
    await this.pending;
    if (this.disposed || this.failed) throw Error("Pane screen is unavailable");
    const buffer = this.terminal.buffer.active;
    const start = Math.max(0, buffer.baseY - (options.history ?? 0));
    const end = Math.min(buffer.length, buffer.baseY + this.terminal.rows);
    let text = "";
    if (options.ansi) text = this.serializer.serialize({ range: { start, end: end - 1 }, excludeModes: true });
    else {
      for (let row = start; row < end; row++) {
        const line = buffer.getLine(row)!;
        const wraps = options.joined && buffer.getLine(row + 1)?.isWrapped;
        text += line.translateToString(!wraps) + (wraps ? "" : "\n");
      }
    }
    if (Buffer.byteLength(JSON.stringify(text)) > PANE_MAX_CAPTURE_BYTES) throw Error("Pane capture size limit reached");
    return text;
  }
  async resize(columns: number, rows: number): Promise<void> {
    await this.pending;
    if (this.disposed || this.failed) throw Error("Pane screen is unavailable");
    this.terminal.resize(columns, rows);
  }
  bracketedPaste(text: string): string {
    // Both audited TUIs understand bracketed paste. A missing/late ConPTY advertisement must never degrade multiline
    // payloads into raw Enter keys that start a task before its separately fenced submit key arrives.
    return `\x1b[200~${text.replace(/\r\n|\r|\n/g, "\r")}\x1b[201~`;
  }
  dispose(): void { this.disposed = true; this.terminal.dispose(); }
}
