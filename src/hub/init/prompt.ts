/**
 * Terminal prompts for `agend hub init`. Ordinary questions go through readline; passwords are read in raw mode and
 * never echoed (nothing in AgEnD read hidden input before). Each ordinary question uses its own readline interface, so
 * no readline listener is attached while a password is being typed.
 */
import { createInterface } from "node:readline/promises";

export class WizardCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "WizardCancelled";
  }
}

export interface WizardIO {
  ask(question: string): Promise<string>;
  /** Read a secret without echoing it. The value is returned once and never written anywhere. */
  askHidden(question: string): Promise<string>;
  say(line?: string): void;
}

export interface HiddenInput {
  readonly isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  removeListener(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface PromptOutput {
  write(text: string): unknown;
}

const MAX_SECRET = 1024;

/** Read one line in raw mode, echoing nothing. Ctrl-C (or Ctrl-D on an empty line) cancels. */
export function readHidden(input: HiddenInput, output: PromptOutput, question: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    // Never fall back to an echoing read for a secret.
    return Promise.reject(new Error("a password can only be typed in an interactive terminal"));
  }
  output.write(question);
  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    let chars: string[] = [];
    // Escape sequences: CSI (ESC [ … final byte @–~), SS3 (ESC O + one char) and ESC + one char are all swallowed.
    let escape: "none" | "esc" | "csi" | "ss3" = "none";
    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode!(wasRaw);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        if (escape === "esc") {
          escape = ch === "[" ? "csi" : ch === "O" ? "ss3" : "none";
          continue;
        }
        if (escape === "csi") {
          if (ch >= "@" && ch <= "~") escape = "none";
          continue;
        }
        if (escape === "ss3") {
          escape = "none";
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          const value = chars.join("");
          chars = [];
          resolve(value);
          return;
        }
        if (ch === "\u0003" || (ch === "\u0004" && chars.length === 0)) {
          chars = [];
          cleanup();
          reject(new WizardCancelled());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          chars.pop();
          continue;
        }
        if (ch === "\u001b") {
          escape = "esc";
          continue;
        }
        if (ch < " ") continue;
        if (chars.length < MAX_SECRET) chars.push(ch);
      }
    };
    input.setRawMode!(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}

/** The real terminal. */
export function terminalIO(): WizardIO {
  return {
    async ask(question: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let closedEarly = false;
      rl.once("close", () => {
        closedEarly = true;
      });
      try {
        const answer = await rl.question(question);
        return answer;
      } catch (err) {
        if (closedEarly) throw new WizardCancelled();
        throw err;
      } finally {
        rl.close();
      }
    },
    askHidden(question: string): Promise<string> {
      return readHidden(process.stdin as unknown as HiddenInput, process.stdout, question);
    },
    say(line = ""): void {
      process.stdout.write(`${line}\n`);
    },
  };
}
