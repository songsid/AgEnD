import { isRemovedBackend, removedBackendMessage } from "./removed.js";
import type { CliBackend } from "./types.js";
import { ClaudeCodeBackend } from "./claude-code.js";
import { CodexBackend } from "./codex.js";
import { OpenCodeBackend } from "./opencode.js";
import { KiroBackend } from "./kiro.js";
import { AntigravityBackend } from "./antigravity.js";
import { GrokBackend } from "./grok.js";
import { MuseBackend } from "./muse.js";
import { MockBackend } from "./mock.js";

export function createBackend(name: string, instanceDir: string): CliBackend {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeBackend(instanceDir);
    case "codex":
      return new CodexBackend(instanceDir);
    case "opencode":
      return new OpenCodeBackend(instanceDir);
    case "kiro-cli":
      return new KiroBackend(instanceDir);
    case "antigravity":
      return new AntigravityBackend(instanceDir);
    case "grok":
      return new GrokBackend(instanceDir);
    case "muse":
      return new MuseBackend(instanceDir);
    case "mock":
      return new MockBackend(instanceDir);
    default:
      // A removed backend says so and names its replacement (#1280); it is never swapped for another silently.
      if (isRemovedBackend(name)) throw new Error(removedBackendMessage(name));
      throw new Error(`Unknown backend: ${name}. Available: claude-code, codex, opencode, kiro-cli, antigravity, grok, muse, mock`);
  }
}

/** Fleet factory: constructors receive a resolved path and do no synchronous discovery. */
export async function createBackendAsync(name: string, instanceDir: string, beforeConstruct?: () => void): Promise<CliBackend> {
  const binaries: Record<string, string> = { "claude-code": "claude", codex: "codex", opencode: "opencode",
    "kiro-cli": "kiro-cli", antigravity: "agy", grok: "grok", muse: "muse" };
  if (!Object.hasOwn(binaries, name)) { beforeConstruct?.(); return createBackend(name, instanceDir); }
  const { resolveBinaryAsync } = await import("./binary-discovery.js");
  const binary = await resolveBinaryAsync(binaries[name]!);
  beforeConstruct?.();
  switch (name) {
    case "claude-code": return new ClaudeCodeBackend(instanceDir, binary);
    case "codex": return new CodexBackend(instanceDir, binary);
    case "opencode": return new OpenCodeBackend(instanceDir, binary);
    case "kiro-cli": return new KiroBackend(instanceDir, undefined, binary);
    case "antigravity": return new AntigravityBackend(instanceDir, undefined, undefined, binary);
    case "grok": return new GrokBackend(instanceDir, binary);
    case "muse": return new MuseBackend(instanceDir, binary);
    default: throw new Error(`Unknown backend: ${name}`);
  }
}
