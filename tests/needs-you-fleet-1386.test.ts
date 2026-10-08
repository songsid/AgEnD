/**
 * #1386 through the real FleetManager (scratch data dir, one fake Discord world, no daemons, no tmux): a prompt
 * answered in Discord leaves the web list with no web action; an interaction change is pushed at once, not at the
 * 10 s tick; the live message lands in that world's General.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
const fleets: any[] = [];
afterEach(async () => {
  for (const fm of fleets.splice(0)) await fm.needsYou?.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "needs-fleet-1386-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  fleets.push(fm);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  const channel = { id: "dc", type: "discord", mode: "topic", group_id: "111111", access: { allowed_users: ["100"] } };
  fm.fleetConfig = {
    defaults: {}, channels: [channel],
    instances: {
      alpha: { working_directory: dir, topic_id: "700001", channel_id: "dc" },
      gen: { working_directory: dir, topic_id: "900001", channel_id: "dc", general_topic: true },
    },
  };
  let n = 0;
  const posts: Array<{ text: string; threadId?: string }> = [];
  const adapter = {
    type: "discord",
    notifyAlert: vi.fn(async (chatId: string, alert: { message: string }, opts?: { threadId?: string }) => {
      posts.push({ text: alert.message, threadId: opts?.threadId });
      return { messageId: String(500000 + ++n), chatId, threadId: opts?.threadId };   // Discord ids are snowflakes
    }),
    editAlert: vi.fn(async () => {}),
    editMessageRemoveButtons: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    sendText: vi.fn(async () => ({ messageId: "t", chatId: "111111" })),
  };
  fm.worlds.set("dc", { id: "dc", adapter, type: "discord", groupId: "111111", channelConfig: channel });
  fm.adapter = adapter;
  const frames: Array<{ event: string; data: any }> = [];
  fm.sseClients.add({ write: (chunk: string) => {
    const m = /^(?:id: [^\n]*\n)?event: (\w+)\ndata: (.*)\n\n$/s.exec(chunk);
    if (m) frames.push({ event: m[1]!, data: JSON.parse(m[2]!) });
    return true;
  }, writableEnded: false, destroyed: false, on() {}, once() {}, end() {} });
  return { fm, adapter, frames, posts };
}

const flush = () => new Promise(r => setTimeout(r, 10));
const needsInstances = (frames: Array<{ event: string; data: any }>) => frames.filter(f => f.event === "needs").at(-1)?.data.items.map((i: any) => `${i.type}:${i.instance}`) ?? null;

describe("#1386 through the real fleet", () => {
  it("a prompt appears; a Discord click on its own button removes it from the web list — no web action", async () => {
    const { fm, adapter, frames, posts } = fleet();
    fm.startNeedsYou();
    await flush();
    const nonce: string = await fm.postNonceButtonPromptOrThrow({
      prefix: "exit-restart:", alertType: "exit_restart", instanceName: "alpha", adapter, adapterId: "dc",
      chatId: "111111", threadId: "900001", message: "alpha exited",
      choices: [{ action: "restart", label: "Restart" }, { action: "ignore", label: "Ignore" }], expiredText: "expired",
    });
    await flush();
    expect(needsInstances(frames)).toEqual(["prompt:alpha"]);
    const item = fm.needsYouItems()[0];
    expect(item).toMatchObject({ id: `prompt:${nonce}`, reason: "exited", nonce, actions: [{ id: "restart", label: "Restart" }, { id: "ignore", label: "Ignore" }] });
    // The live message in this world's General links to the prompt's own message.
    await new Promise(r => setTimeout(r, 3_200));
    expect(posts.some(p => p.threadId === "900001" && p.text.includes("https://discord.com/channels/111111/900001/500001"))).toBe(true);

    // A Discord admin answers on the prompt's own message.
    const acks: string[] = [];
    await fm.dispatchAdapterCallback({ callbackData: `exit-restart:${nonce}:ignore`, chatId: "111111", threadId: "900001", messageId: "500001", userId: "100", ack: (n?: string) => acks.push(n ?? "") }, "dc", adapter);
    await flush();
    expect(needsInstances(frames)).toEqual([]);
    expect(fm.needsYouItems()).toEqual([]);
  }, 10_000);

  it("an interaction change is pushed at once (instance_interaction), not at the 10 s tick", async () => {
    const { fm, frames } = fleet();
    fm.startNeedsYou();
    await flush();
    vi.spyOn(fm, "instancePresentation").mockImplementation((name: unknown) => name === "alpha"
      ? { state: "awaiting_input", execution_state: "working", interaction_summary: "Permission prompt · 2s",
          interaction: { phase: "waiting", kind: "permission", reason: "permission", episode: 3, owner: { bootId: "b", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 }, since: Date.now(), observedAt: null, confirmedAt: null, ageMs: 0, stale: false, suspected: false } }
      : { state: null, execution_state: null, interaction: null, interaction_summary: null });
    vi.spyOn(fm, "getInstanceInteraction").mockImplementation((name: unknown) => name === "alpha" ? fm.instancePresentation("alpha").interaction : null);
    fm.onInstanceInteraction("alpha");
    await flush();
    expect(needsInstances(frames)).toEqual(["awaiting_input:alpha"]);
  });
});
