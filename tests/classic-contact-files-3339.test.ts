import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, linkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageContactFiles } from "../src/contact-auth-files.js";
import { routeToolCall } from "../src/channel/tool-router.js";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function rig() {
  const home = mkdtempSync(join(tmpdir(), "room-file-")), inbox = join(home, "workspaces", "room", "inbox");
  mkdirSync(inbox, { recursive: true });
  const own = join(inbox, "public.txt"), outside = join(home, "private", "account.txt");
  mkdirSync(join(home, "private")); writeFileSync(own, "public room attachment"); writeFileSync(outside, "fake owner-only information");
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return { home, inbox, own, outside };
}
it("refuses an owner file, another room's inbox, a symlink and a hard link", async () => {
  const { home, inbox, own, outside } = rig();
  const other = join(home, "workspaces", "other", "inbox"); mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "public.txt"), "another room");
  const symlink = join(inbox, "link.txt"), hard = join(inbox, "hard.txt");
  symlinkSync(outside, symlink); linkSync(outside, hard);
  for (const path of [outside, join(other, "public.txt"), symlink, hard]) {
    await expect(stageContactFiles([path], home, inbox)).rejects.toThrow("this room's own inbox or scratch");
  }
  const lease = await stageContactFiles([own], home, inbox); cleanups.push(lease.dispose);
  expect(readFileSync(lease.paths[0]!, "utf8")).toBe("public room attachment");
});
it("validates before any platform post and sends a snapshot despite a rewrite during the text send", async () => {
  const { home, inbox, own, outside } = rig();
  const adapter = { sendText: vi.fn(async () => { writeFileSync(own, "rewritten"); return { messageId: "fake-message" }; }),
    sendFile: vi.fn(async (_chat: string, path: string) => { expect(readFileSync(path, "utf8")).toBe("public room attachment"); return { messageId: "fake-file" }; }) };
  const call = (files: string[]) => new Promise<{ result?: unknown; error?: string }>(resolve => {
    routeToolCall(adapter as any, "reply", { chat_id: "fake-room", text: "Public summary", files }, undefined,
      (result, error) => resolve({ result, error }), { prepareFiles: paths => stageContactFiles(paths, home, inbox) });
  });
  expect((await call([outside])).error).toContain("this room's own inbox or scratch");
  expect(adapter.sendText).not.toHaveBeenCalled(); expect(adapter.sendFile).not.toHaveBeenCalled();
  expect((await call([own])).error).toBeUndefined();
  expect(adapter.sendText).toHaveBeenCalledOnce(); expect(adapter.sendFile).toHaveBeenCalledOnce();
  const staged = adapter.sendFile.mock.calls[0]?.[1]; expect(staged).not.toBe(own);
});
it("does not turn cleanup failure into a second, retryable response", async () => {
  const { own } = rig();
  const respond = vi.fn(); let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const adapter = { sendText: async () => ({ messageId: "fake-message" }), sendFile: async () => ({ messageId: "fake-file" }) };
  routeToolCall(adapter as any, "reply", { chat_id: "fake-room", text: "Summary", files: [own] }, undefined, respond, {
    prepareFiles: async paths => ({ paths: [...paths], dispose: async () => { finish(); throw Error("fake-cleanup-failed"); } }),
  });
  await done;
  expect(respond).toHaveBeenCalledOnce(); expect(respond.mock.calls[0]?.[1]).toBeUndefined();
});
it("refuses unsafe Hub answer files before claiming the Hub correlation", async () => {
  const { home, inbox, outside } = rig();
  const hubReport = vi.fn(() => Promise.resolve({ ok: true })), response = vi.fn();
  await outboundHandlers.get("report_result")!({ prepareContactFiles: (_instance: string, paths: string[]) => stageContactFiles(paths, home, inbox),
    hubReport, getDaemonBootId: () => "fake-boot" } as any,
  { target_instance: "agend-hub", correlation_id: "hub-fake", summary: "Answer", files: [outside] }, response,
  { instanceName: "room", requestId: 1, senderSessionName: undefined, fleetRequestId: undefined, sourceDaemonBootId: "fake-boot" });
  expect(hubReport).not.toHaveBeenCalled(); expect(response.mock.calls[0]?.[1]).toContain("own inbox or scratch");
});

it.each(["reply", "react", "edit"])("binds HTTP %s to the actual room despite caller routing overrides", async op => {
  const { home } = rig();
  const adapter = { id: "fake-room-adapter", sendText: vi.fn(async () => ({ messageId: "fake-message" })),
    react: vi.fn(async () => {}), editMessage: vi.fn(async () => {}) };
  const ctx = { dataDir: home, fleetConfig: { defaults: {}, instances: { room: { tool_set: "full" } } },
    classicContactRestricted: () => true, restrictedClassicRouting: () => ({ adapterId: adapter.id, chatId: "fake-room", threadId: "fake-thread" }),
    getDaemonBootId: () => "fake-boot", adapters: new Map([[adapter.id, adapter]]),
    getAdapterForInstance: () => adapter, prepareContactFiles: async () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, clearCancelButton: vi.fn() } as any;
  const result = await dispatchAgentOperation(ctx, "room", op, { chat_id: "other-room", thread_id: "other-thread", adapter_id: "other-bot",
    message_id: "fake-message", text: "Public answer", emoji: "👍" });
  expect(result).not.toHaveProperty("error");
  const calls: unknown[][] = op === "reply" ? adapter.sendText.mock.calls : op === "react" ? adapter.react.mock.calls : adapter.editMessage.mock.calls;
  expect(calls[0]?.[0]).toBe("fake-room");
  if (op === "reply") expect(calls[0]?.[2]).toMatchObject({ threadId: "fake-thread" });
  else expect(calls[0]?.[3]).toBe("fake-thread");
});
