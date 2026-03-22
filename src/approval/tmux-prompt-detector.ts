import { readFileSync, statSync } from "node:fs";
import type { TmuxManager } from "../tmux-manager.js";
import type { ApprovalResponse } from "../channel/types.js";

export function detectPermissionPrompt(text: string): boolean {
  return text.includes("1.Yes") && text.includes("3.No");
}

export class TmuxPromptDetector {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private byteOffset = 0;

  constructor(
    private outputLogPath: string,
    private tmux: TmuxManager,
    private approvalFn: (prompt: string) => Promise<ApprovalResponse>,
    private logger: { info(...args: any[]): void; warn(...args: any[]): void },
  ) {}

  startPolling(intervalMs = 2000): void {
    if (this.pollTimer !== null) return;

    this.pollTimer = setInterval(async () => {
      try {
        const stat = statSync(this.outputLogPath);
        const fileSize = stat.size;

        if (fileSize <= this.byteOffset) return;

        const buf = Buffer.alloc(fileSize - this.byteOffset);
        const fd = await import("node:fs").then(fs => fs.openSync(this.outputLogPath, "r"));
        const { readSync, closeSync } = await import("node:fs");
        const bytesRead = readSync(fd, buf, 0, buf.length, this.byteOffset);
        closeSync(fd);

        if (bytesRead <= 0) return;

        const newContent = buf.subarray(0, bytesRead).toString("utf8");
        this.byteOffset += bytesRead;

        if (detectPermissionPrompt(newContent)) {
          this.logger.info("TmuxPromptDetector: permission prompt detected");
          try {
            const result = await this.approvalFn(newContent);
            if (result.decision === "approve") {
              await this.tmux.sendKeys("1");
            } else {
              await this.tmux.sendKeys("3");
            }
          } catch (err) {
            this.logger.warn("TmuxPromptDetector: approvalFn error", err);
            await this.tmux.sendKeys("3");
          }
        }
      } catch (err) {
        // File may not exist yet; ignore
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
