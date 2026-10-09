/**
 * alpha.2 (user report, a kiro TUI instance): a message sent from the web chat must reach the agent with the same
 * envelope as a Discord/Telegram one — who sent it, its message id, and the reply instruction — on every backend, and
 * a turn that ends without a reply must be caught by the reply-completion guard wherever that guard runs.
 *
 * Driven through the real Daemon ingress (pushChannelMessage → formatInboundMessage → deliverMessage → markTurnStarted)
 * and the real idle-edge guard; the backend is a stub carrying only the capability the daemon reads.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { Logger } from "../src/logger.js";

vi.mock("../src/backend/types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/backend/types.js")>(),
  resolveBinary: (name: string) => name,
}));

const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Which backends run the reply-completion guard (#1144: only those with a verified turn-end signal). */
const BACKENDS = [
  { backend: "claude-code", binaryName: "claude", guard: true },
  { backend: "kiro-cli", binaryName: "kiro-cli", guard: true },     // the TUI and legacy launch plans opt in
  { backend: "codex", binaryName: "codex", guard: false },
  { backend: "muse", binaryName: "muse", guard: false },
] as const;

function daemonFor(b: (typeof BACKENDS)[number]) {
  const dir = mkdtempSync(join(tmpdir(), `agend-web-inbound-${b.backend}-`));
  dirs.push(dir);
  const daemon = new Daemon("my-project", {
    backend: b.backend, working_directory: dir, log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, true, { binaryName: b.binaryName, replyCompletionGuard: b.guard } as any, undefined, logger) as any;
  daemon.tmux = {};
  daemon.deliverMessage = vi.fn(async () => true);
  daemon.deliverDaemonReply = vi.fn(async () => true);
  daemon.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
  daemon.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true) };
  return daemon;
}

/** What web-api.ts /ui/send hands the daemon: bound to a platform (chat_id = its group), or a web-only fleet (none). */
const webMeta = (bound: boolean) => ({
  chat_id: bound ? "guild-1" : "", thread_id: bound ? "topic-7" : "", message_id: "web-abc123",
  user: "web-user", user_id: "web-user", ts: "2026-10-10T00:00:00.000Z", source: "web", ...(bound ? { adapter_id: "dc" } : {}),
});
const discordMeta = { chat_id: "guild-1", thread_id: "topic-7", message_id: "999", user: "han", user_id: "42", ts: "2026-10-10T00:00:00.000Z", source: "discord", adapter_id: "dc" };
const REPLY_LINE = "(Reply using the reply tool — do NOT respond with direct text)";

describe("a web message reaches the agent with the full envelope, on every backend", () => {
  for (const b of BACKENDS) {
    for (const bound of [true, false]) {
      it(`${b.backend}, ${bound ? "platform-bound" : "web-only fleet"}: sender, message id and the reply instruction`, async () => {
        const daemon = daemonFor(b);
        daemon.pushChannelMessage("那先不用", webMeta(bound));
        await daemon.pasteLock;
        const pasted = String(daemon.deliverMessage.mock.calls[0]![0]);
        expect(pasted.split("\n")).toEqual(["[user:web-user via web, id:web-user] 那先不用", "(message_id: web-abc123)", REPLY_LINE]);
      });
    }
  }
  it("the same shape as a Discord message (only the sender and the id differ)", async () => {
    const daemon = daemonFor(BACKENDS[1]);
    daemon.pushChannelMessage("那先不用", discordMeta);
    await daemon.pasteLock;
    expect(String(daemon.deliverMessage.mock.calls[0]![0]).split("\n")).toEqual(["[user:han via discord, id:42] 那先不用", "(message_id: 999)", REPLY_LINE]);
  });
});

describe("the reply-completion guard covers web messages", () => {
  const idle = () => ({ state: "idle", unchangedForMs: 0, observedAt: Date.now(), stateChangedAt: Date.now() }) as any;
  const working = () => ({ state: "working", unchangedForMs: 0, observedAt: Date.now(), stateChangedAt: Date.now() }) as any;
  async function silentTurn(daemon: any) {
    daemon.applyInstanceStateSnapshot(working(), "thinking…");
    daemon.applyInstanceStateSnapshot(idle(), "answered in text\n❯");
    await vi.advanceTimersByTimeAsync(61_000);
    daemon.applyInstanceStateSnapshot(idle(), "answered in text\n❯");
    await daemon.pasteLock;
  }
  for (const b of BACKENDS.filter(x => x.guard)) {
    for (const bound of [true, false]) {
      it(`${b.backend}, ${bound ? "platform-bound" : "web-only fleet"}: armed by the web message; a turn ended without a reply gets the one recovery prompt`, async () => {
        vi.useFakeTimers();
        const daemon = daemonFor(b);
        daemon.pushChannelMessage("那先不用", webMeta(bound));
        await daemon.pasteLock;
        expect(daemon.turnReplyGuard.snapshot(), "armed").toMatchObject({ target: { messageId: "web-abc123" } });
        daemon.deliverMessage.mockClear();
        await silentTurn(daemon);
        expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
        expect(String(daemon.deliverMessage.mock.calls[0]![0])).toMatch(/^\[system:reply-required\]/);
        // The status the person sees goes to where they wrote from: their chat, or (no chat) the fleet's web sink.
        const target = daemon.deliverDaemonReply.mock.calls[0]![3];
        expect(target).toMatchObject(bound ? { chatId: "guild-1", threadId: "topic-7" } : { chatId: "" });
      });
    }
  }
  it("codex and muse do not run the guard (no verified turn-end signal, #1144) — documented, not changed here", async () => {
    for (const b of BACKENDS.filter(x => !x.guard)) {
      vi.useFakeTimers();
      const daemon = daemonFor(b);
      daemon.pushChannelMessage("那先不用", webMeta(true));
      await daemon.pasteLock;
      daemon.deliverMessage.mockClear();
      await silentTurn(daemon);
      expect(daemon.deliverMessage, b.backend).not.toHaveBeenCalled();
      vi.useRealTimers();
    }
  });
  it("a cross-instance message still never arms it", async () => {
    const daemon = daemonFor(BACKENDS[0]);
    daemon.markTurnStarted({ ...webMeta(false), source: "", from_instance: "worker-2" }, "handoff");
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
  });
});
