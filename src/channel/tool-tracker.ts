import type { ChannelAdapter } from "./types.js";

export class ToolTracker {
  private statusMessageId: string | null = null;
  private lines: string[] = [];

  constructor(
    private adapter: ChannelAdapter,
    private chatId: string,
    private threadId?: string,
  ) {}

  async onToolUse(toolName: string, input: unknown): Promise<void> {
    const summary = this.summarizeTool(toolName, input);
    this.lines.push(`🔧 ${summary}`);

    if (!this.statusMessageId) {
      // First tool — send new message
      const sent = await this.adapter.sendText(this.chatId, this.lines.join("\n"), { threadId: this.threadId });
      this.statusMessageId = sent.messageId;
    } else {
      // Subsequent — edit existing
      await this.adapter.editMessage(this.chatId, this.statusMessageId, this.lines.join("\n"));
    }
  }

  async onToolResult(toolName: string, _output: unknown): Promise<void> {
    // Find the last line matching this tool and mark it done
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].includes(toolName) && this.lines[i].startsWith("🔧")) {
        this.lines[i] = this.lines[i].replace("🔧", "✅");
        break;
      }
    }
    if (this.statusMessageId) {
      await this.adapter.editMessage(this.chatId, this.statusMessageId, this.lines.join("\n"));
    }
  }

  reset(): void {
    this.statusMessageId = null;
    this.lines = [];
  }

  private summarizeTool(name: string, input: unknown): string {
    const inp = input as Record<string, unknown>;
    if (name === "Read") return `Read: ${inp.file_path ?? ""}`;
    if (name === "Edit") return `Edit: ${inp.file_path ?? ""}`;
    if (name === "Write") return `Write: ${inp.file_path ?? ""}`;
    if (name === "Bash") return `Bash: ${String(inp.command ?? "").slice(0, 60)}`;
    if (name === "Glob") return `Glob: ${inp.pattern ?? ""}`;
    if (name === "Grep") return `Grep: ${inp.pattern ?? ""}`;
    return name;
  }
}
