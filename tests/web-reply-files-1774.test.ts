/**
 * #1774 (Fable's #1772 review P3s), an agent reply whose files are being copied for the web chat (#1770):
 * - Ordering: the reply takes its place in the chat when it is sent. A person's message sent while its files are still
 *   being copied comes after it — in the history, on a live page (by id), in a reconnect's replay and in a poll whose
 *   cursor already passed that place (the reply counts as seen when it is recorded: seenSeq).
 * - Removal: an instance removed while its reply's files are being copied gets no chat back from that reply, and the
 *   files copied for it are deleted (none left behind, none served); copying stops at the next file.
 * The real FleetManager and WebChatHistory on a scratch home; nothing started (lifecycle and delivery are stubs).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "agend-1774-home-"));
process.env.AGEND_HOME = home;

let FleetManager: typeof import("../src/fleet-manager.js").FleetManager;
let authorizeExplicitInstanceRemoval: typeof import("../src/instance-removal.js").authorizeExplicitInstanceRemoval;
const { WebChatHistory } = await import("../src/web-chat-history.js");
const { webFilesDir } = await import("../src/web-reply-files.js");
beforeAll(async () => {
  ({ FleetManager } = await import("../src/fleet-manager.js"));
  ({ authorizeExplicitInstanceRemoval } = await import("../src/instance-removal.js"));
}, 60_000);
const dirs: string[] = [home];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function gate() { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; }
function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1774-fleet-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  return fm;
}
/** A reply with one file, whose copy waits at `hold` — before copying (`when: "before"`) or after it (`"after"`). */
function slowCopies(fm: any, hold: Promise<void>, when: "before" | "after") {
  const real = fm.webReplyAttachments.bind(fm);
  vi.spyOn(fm, "webReplyAttachments").mockImplementation(async (...a: unknown[]) => {
    if (when === "before") { await hold; return real(...a); }
    const out = await real(...a); await hold; return out;
  });
}
function agentFile(name: string): string {
  const d = mkdtempSync(join(tmpdir(), "agend-1774-agent-")); dirs.push(d);
  const p = join(d, name); writeFileSync(p, "a report\n"); return p;
}
const texts = (fm: any, i: string) => fm.webChatHistory.list(i).map((m: any) => m.text);

describe("#1774 ordering: a reply's place is when it was sent, not when its files were copied", () => {
  it("a person's message sent during the copy comes after the reply — in the history, on a live page, in a replay and a poll", async () => {
    const fm = fleet();
    const writes: string[] = [];
    fm.sseClients.add({ write: (s: string) => { writes.push(s); return true; }, writableEnded: false, destroyed: false, on() {}, once() {}, end() {} });
    const hold = gate();
    slowCopies(fm, hold.promise, "before");
    const done = fm.afterReplyRouted("w", { text: "Here is the report", files: [agentFile("report.md")] });
    fm.emitSseEvent("message", { instance: "w", sender: "Ann", role: "user", text: "Thanks — and the chart?", ts: new Date().toISOString() });
    const userRow = fm.webChatHistory.list("w").at(-1);
    const cursor = { boot: userRow.boot, id: userRow.id };              // a page that has seen the person's message
    hold.open(); await done;
    const reply = fm.webChatHistory.list("w").find((m: any) => m.role === "agent");
    const frame = writes.filter((w) => w.includes("event: message")).at(-1)!;
    expect([
      texts(fm, "w"), reply.id < userRow.id, reply.attachments?.length,
      fm.webChatHistory.replayFor(cursor).map((m: any) => m.text),        // a reconnect / a poll from that cursor
      frame.startsWith(`id: ${fm.webChatHistory.cursorOf(reply)}\n`), Number(fm.webChatHistory.cursorOf(reply).split("-")[1]) > userRow.id,
    ]).toEqual([["Here is the report", "Thanks — and the chart?"], true, 1, ["Here is the report"], true, true]);
  });
  it("a reply with no files and nothing before it is recorded at once, where it is (no reserved place)", async () => {
    const fm = fleet();
    await fm.afterReplyRouted("w", { text: "plain" });
    const row = fm.webChatHistory.list("w").at(-1);
    expect([row.text, row.seenSeq, fm.webChatHistory.cursorOf(row)]).toEqual(["plain", undefined, `${row.boot}-${row.id}`]);
  });
});

describe("#1774 removal: an instance removed while its reply's files are copied", () => {
  async function removed(fm: any, name: string) {
    fm.lifecycle = { daemons: new Map(), remove: async () => {} };
    fm.statuslineWatcher = { unwatch() {} };
    await fm.removeInstance(name, authorizeExplicitInstanceRemoval("dashboard-confirmed"));
  }
  const snapshots = (name: string) => { const d = webFilesDir(home, name); return d && existsSync(d) ? readdirSync(d) : []; };
  it("removed before the copy: nothing is copied, and the reply makes no chat again", async () => {
    const fm = fleet();
    fm.webChatHistory.record({ instance: "gone", sender: "Ann", text: "earlier", ts: "t" });
    const hold = gate();
    slowCopies(fm, hold.promise, "before");
    const done = fm.afterReplyRouted("gone", { text: "late reply", files: [agentFile("a.md")] });
    await removed(fm, "gone");
    const registered = vi.spyOn(fm.webFiles, "registerServed");            // copying stops: nothing even made, then dropped
    hold.open(); await done;
    expect([fm.webChatHistory.list("gone"), snapshots("gone"), registered.mock.calls.length]).toEqual([[], [], 0]);
  });
  it("removed after the copy, before it is shown: the copy is deleted and not served; no chat again", async () => {
    const fm = fleet();
    fm.webChatHistory.record({ instance: "gone2", sender: "Ann", text: "earlier", ts: "t" });
    const hold = gate();
    slowCopies(fm, hold.promise, "after");
    const done = fm.afterReplyRouted("gone2", { text: "late reply", files: [agentFile("b.md")] });
    await vi.waitFor(() => expect(snapshots("gone2").length).toBe(1));   // copied, waiting to be shown
    const copied = snapshots("gone2")[0]!;
    await removed(fm, "gone2");
    hold.open(); await done;
    expect([fm.webChatHistory.list("gone2"), snapshots("gone2"), fm.webFiles.lookup?.(copied.split(".")[0]) ?? null]).toEqual([[], [], null]);
  });
  it("removal deletes the copies of its replies' files (the web chat's own), never a file it served from the agent's own path", async () => {
    const fm = fleet();
    await fm.afterReplyRouted("gone3", { text: "with a copy", files: [agentFile("d.md")] });
    const own = agentFile("e.md");
    const served = fm.webFiles.registerServed({ path: own, instance: "gone3" });
    expect([snapshots("gone3").length, !!served]).toEqual([1, true]);
    await removed(fm, "gone3");
    expect([snapshots("gone3"), existsSync(own)]).toEqual([[], true]);
  });
  it("Prism r1: a same-name replacement registered during the removal — the old reply goes (its copy too), the new one's own reply stays", async () => {
    const fm = fleet();
    fm.fleetConfig = { instances: { twin: { working_directory: "/x" } } };
    const hold = gate();
    slowCopies(fm, hold.promise, "after");
    const old = fm.afterReplyRouted("twin", { text: "OLD INSTANCE REPLY", files: [agentFile("old.md")] });
    await vi.waitFor(() => expect(snapshots("twin").length).toBe(1));      // the old one's copy is made, not yet shown
    let fresh: Promise<void> | undefined;
    fm.lifecycle = { daemons: new Map(), isPaused: () => false, hasWorkLease: () => false, remove: async () => {
      fm.fleetConfig.instances.twin = { working_directory: "/y" };          // the replacement, while the old one goes
      fresh = fm.afterReplyRouted("twin", { text: "NEW INSTANCE REPLY", files: [agentFile("new.md")] });
    } };
    fm.statuslineWatcher = { unwatch() {} };
    await fm.removeInstance("twin", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    hold.open(); await old; await fresh;
    const rows = fm.webChatHistory.list("twin");
    expect([rows.map((m: any) => m.text), rows[0].attachments.length, snapshots("twin").length]).toEqual([["NEW INSTANCE REPLY"], 1, 1]);
  });
  it("the removed instance's own reply sent while it was being removed is not the replacement's either", async () => {
    const fm = fleet();
    fm.fleetConfig = { instances: { dup: { working_directory: "/x" } } };
    const oldDaemon = { name: "old" }, newDaemon = { name: "new" };
    const daemons = new Map<string, unknown>([["dup", oldDaemon]]);       // the fleet's daemons are the lifecycle's
    const hold = gate();
    slowCopies(fm, hold.promise, "before");
    let late: Promise<void> | undefined, fresh: Promise<void> | undefined;
    fm.lifecycle = { daemons, isPaused: () => false, hasWorkLease: () => false, remove: async () => {
      late = fm.afterReplyRouted("dup", { text: "OLD, MID-REMOVAL", files: [agentFile("late.md")] });   // still the old daemon
      daemons.set("dup", newDaemon);                                       // the replacement registers
      fm.fleetConfig.instances.dup = { working_directory: "/y" };
      fresh = fm.afterReplyRouted("dup", { text: "NEW", files: [agentFile("n.md")] });
    } };
    fm.statuslineWatcher = { unwatch() {} };
    await fm.removeInstance("dup", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    hold.open(); await late; await fresh;
    expect([texts(fm, "dup"), snapshots("dup").length]).toEqual([["NEW"], 1]);
  });
  it("control — a removal that fails takes nothing: the held reply is still the instance's, shown", async () => {
    const fm = fleet();
    const hold = gate();
    slowCopies(fm, hold.promise, "before");
    const done = fm.afterReplyRouted("stays", { text: "still mine", files: [agentFile("f.md")] });
    fm.lifecycle = { daemons: new Map(), remove: async () => { throw new Error("lifecycle refused"); } };
    await expect(fm.removeInstance("stays", authorizeExplicitInstanceRemoval("dashboard-confirmed"))).rejects.toThrow("lifecycle refused");
    hold.open(); await done;
    expect([texts(fm, "stays"), snapshots("stays").length]).toEqual([["still mine"], 1]);
  });
  it("Prism r2 (a): the old copy settles while the removal is still going (replacement registered) — it waits, then goes", async () => {
    const fm = fleet();
    fm.fleetConfig = { instances: { mid: { working_directory: "/x" } } };
    const hold = gate();
    slowCopies(fm, hold.promise, "before");
    const old = fm.afterReplyRouted("mid", { text: "OLD INSTANCE REPLY", files: [agentFile("o.md")] });
    const oldIdentity = fm.webChatIdentity("mid");                          // a file-less reply of the old one, sent now…
    let fresh: Promise<void> | undefined, oldNoFiles: Promise<void> | undefined;
    fm.lifecycle = { daemons: new Map(), isPaused: () => false, hasWorkLease: () => false, remove: async () => {
      fm.fleetConfig.instances.mid = { working_directory: "/y" };          // the replacement
      oldNoFiles = fm.afterReplyRouted("mid", { text: "OLD, NO FILES" }, undefined, null, false, undefined, oldIdentity);   // …landing mid-removal
      fresh = fm.afterReplyRouted("mid", { text: "NEW INSTANCE REPLY" });
      hold.open();                                                          // the old copy finishes now, removal not yet
      await vi.waitFor(() => expect(snapshots("mid").length).toBe(1));
      await new Promise((r) => setTimeout(r, 20));
    } };
    fm.statuslineWatcher = { unwatch() {} };
    await fm.removeInstance("mid", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    await old; await fresh; await oldNoFiles;
    expect([texts(fm, "mid"), snapshots("mid")]).toEqual([["NEW INSTANCE REPLY"], []]);
  });
  it("a file-less reply of the removed one landing mid-removal (nothing else pending) waits too, and goes", async () => {
    const fm = fleet();
    fm.fleetConfig = { instances: { bare: { working_directory: "/x" } } };
    const oldIdentity = fm.webChatIdentity("bare");
    let late: Promise<void> | undefined;
    fm.lifecycle = { daemons: new Map(), isPaused: () => false, hasWorkLease: () => false, remove: async () => {
      fm.fleetConfig.instances.bare = { working_directory: "/y" };         // the replacement
      late = fm.afterReplyRouted("bare", { text: "OLD, NO FILES" }, undefined, null, false, undefined, oldIdentity);
      await new Promise((r) => setTimeout(r, 20));
    } };
    fm.statuslineWatcher = { unwatch() {} };
    await fm.removeInstance("bare", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    await late;
    expect(texts(fm, "bare")).toEqual([]);
  });
  it("control — the removal fails after the old copy settled during it: the reply is still its own, shown", async () => {
    const fm = fleet();
    const hold = gate();
    slowCopies(fm, hold.promise, "before");
    const old = fm.afterReplyRouted("kept2", { text: "still mine", files: [agentFile("k.md")] });
    fm.lifecycle = { daemons: new Map(), remove: async () => {
      hold.open(); await vi.waitFor(() => expect(snapshots("kept2").length).toBe(1)); await new Promise((r) => setTimeout(r, 20));
      throw new Error("lifecycle refused");
    } };
    await expect(fm.removeInstance("kept2", authorizeExplicitInstanceRemoval("dashboard-confirmed"))).rejects.toThrow("lifecycle refused");
    await old;
    expect([texts(fm, "kept2"), snapshots("kept2").length]).toEqual([["still mine"], 1]);
  });
  it("Prism r2 (b): a reply's sender is who sent it — an old daemon's slow platform send lands after its removal and a same-name replacement: not shown", async () => {
    const fm = fleet();
    const cfg = { id: "tg", type: "telegram", group_id: "G", access: { mode: "open", allowed_users: [] } };
    fm.fleetConfig = { defaults: {}, channels: [cfg], instances: { pal: { working_directory: "/x", topic_id: "T" } } };
    const held = gate();
    let first = true;
    const adapter = { id: "tg", type: "telegram", sendText: vi.fn(async (chatId: string, _t: string, opts: any) => {
      if (first) { first = false; await held.promise; return { messageId: "old-1", chatId, threadId: opts?.threadId }; }
      return { messageId: "new-1", chatId, threadId: opts?.threadId };
    }) };
    fm.adapter = adapter; fm.adapters.set("tg", adapter); fm.worlds.set("tg", { id: "tg", adapter, channelConfig: cfg, groupId: "G" });
    fm.routing.rebuild(fm.fleetConfig);
    const daemons = new Map<string, unknown>([["pal", { name: "old daemon" }]]);
    fm.lifecycle = { daemons, isPaused: () => false, hasWorkLease: () => false, remove: async () => {
      daemons.set("pal", { name: "new daemon" });                           // the replacement registers
      fm.fleetConfig.instances.pal = { working_directory: "/y", topic_id: "T" };
    } };
    fm.statuslineWatcher = { unwatch() {} };
    fm.instanceIpcClients.set("pal", { connected: true, send: () => true });
    const reply = (text: string, requestId: number) => fm.handleOutboundFromInstance("pal", { type: "fleet_outbound", tool: "reply", args: { chat_id: "G", text }, requestId, adapterId: "tg" });
    const old = reply("OLD PLATFORM REPLY", 1);                             // its platform send is held
    await vi.waitFor(() => expect(adapter.sendText).toHaveBeenCalledTimes(1));
    await fm.removeInstance("pal", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    await reply("NEW INSTANCE REPLY", 2);
    await vi.waitFor(() => expect(texts(fm, "pal")).toContain("NEW INSTANCE REPLY"));
    held.open(); await old;
    await new Promise((r) => setTimeout(r, 20));
    expect(texts(fm, "pal")).toEqual(["NEW INSTANCE REPLY"]);
  });
  it("Prism r3: identity is taken before the handler's first await — a held sticker check (Discord list) is no window either", async () => {
    const fm = fleet();
    const cfg = { id: "dc", type: "discord", group_id: "G", access: { mode: "open", allowed_users: [] } };
    fm.fleetConfig = { defaults: {}, channels: [cfg], instances: { stk: { working_directory: "/x", topic_id: "T" } } };
    const list = gate();
    let firstList = true;
    const adapter = { id: "dc", type: "discord",
      sendText: vi.fn(async (chatId: string, _t: string, opts: any) => ({ messageId: `m${Math.random()}`, chatId, threadId: opts?.threadId })),
      sendStickers: vi.fn(async (chatId: string) => ({ messageId: "st", chatId })),
      listStickers: vi.fn(async () => { if (firstList) { firstList = false; await list.promise; } return { scope: "G", stickers: [{ id: "s1", name: "ok", emoji_or_tags: "", format: "png", available: true }] }; }) };
    fm.adapter = adapter; fm.adapters.set("dc", adapter); fm.worlds.set("dc", { id: "dc", adapter, channelConfig: cfg, groupId: "G" });
    fm.routing.rebuild(fm.fleetConfig);
    const daemons = new Map<string, unknown>([["stk", { name: "old daemon" }]]);
    fm.lifecycle = { daemons, isPaused: () => false, hasWorkLease: () => false, remove: async () => {
      daemons.set("stk", { name: "new daemon" });
      fm.fleetConfig.instances.stk = { working_directory: "/y", topic_id: "T" };
    } };
    fm.statuslineWatcher = { unwatch() {} };
    fm.instanceIpcClients.set("stk", { connected: true, send: () => true });
    const reply = (text: string, requestId: number, extra: Record<string, unknown> = {}) =>
      fm.handleOutboundFromInstance("stk", { type: "fleet_outbound", tool: "reply", args: { chat_id: "G", text, ...extra }, requestId, adapterId: "dc" });
    const old = reply("OLD PLATFORM REPLY", 1, { stickers: ["s1"] });   // its sticker check waits for the list
    await vi.waitFor(() => expect(adapter.listStickers).toHaveBeenCalledTimes(1));
    await fm.removeInstance("stk", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    await reply("NEW INSTANCE REPLY", 2);
    await vi.waitFor(() => expect(texts(fm, "stk")).toContain("NEW INSTANCE REPLY"));
    list.open(); await old;
    await new Promise((r) => setTimeout(r, 20));
    expect(texts(fm, "stk")).toEqual(["NEW INSTANCE REPLY"]);
  });
  it("control — not removed: the same slow reply is shown with its file", async () => {
    const fm = fleet();
    const hold = gate();
    slowCopies(fm, hold.promise, "after");
    const done = fm.afterReplyRouted("kept", { text: "on time", files: [agentFile("c.md")] });
    hold.open(); await done;
    expect([texts(fm, "kept"), fm.webChatHistory.list("kept")[0].attachments.length, snapshots("kept").length]).toEqual([["on time"], 1, 1]);
  });
});

describe("#1774 WebChatHistory: a reserved place", () => {
  it("Prism r1: a quiet poll while the copy is held (nothing else recorded) still gets the reply on its next poll", () => {
    const h = new WebChatHistory({ boot: "aa" });
    h.record({ instance: "w", sender: "Ann", text: "before", ts: "t" });
    const prior = { boot: "aa", id: Number(h.pollCursor().split("-")[1]) };   // control: a cursor from before the reply
    const place = h.reserve();
    const quiet = { boot: "aa", id: Number(h.pollCursor().split("-")[1]) };   // a poll while the copy is held
    h.record({ instance: "w", sender: "w", role: "agent", text: "reply", ts: "t", reserved: place });
    const after = { boot: "aa", id: Number(h.pollCursor().split("-")[1]) };
    expect([quiet.id >= place, h.replayFor(quiet).map(m => m.text), h.replayFor(prior).map(m => m.text), h.replayFor(after)]).toEqual([true, ["reply"], ["reply"], []]);
  });
  it("Prism r1: a replay's cursors only rise — a stream cut after any frame loses nothing; bounded, it keeps the newest published; restored too", () => {
    let saved: any[] = [];
    const build = (replayMax?: number) => {
      const h = new WebChatHistory({ boot: "aa", ...(replayMax ? { replayMax } : {}), store: { schedule: (_i: string, rows: () => unknown[]) => { saved = rows() as any[]; }, remove: async () => {} } });
      const place = h.reserve();
      h.record({ instance: "w", sender: "Ann", text: "person", ts: "t" });
      h.record({ instance: "w", sender: "w", role: "agent", text: "reply", ts: "t", reserved: place });
      return h;
    };
    const h = build();
    const frames = h.after(0).map(m => [m.text, Number(h.cursorOf(m).split("-")[1])] as const);
    const resumed = h.replayFor({ boot: "aa", id: frames[0]![1] }).map(m => m.text);    // cut after the first frame
    const one = build(1).after(0).map(m => m.text);
    const back = new WebChatHistory({ boot: "bb" });
    back.restore("w", JSON.parse(JSON.stringify(saved)));
    expect([frames, resumed, one, back.replayFor({ boot: "aa", id: 0 }).map(m => m.text), back.replayFor({ boot: "aa", id: frames[0]![1] }).map(m => m.text), h.list("w").map(m => m.text)])
      .toEqual([[["person", 2], ["reply", 3]], ["reply"], ["reply"], ["person", "reply"], ["reply"], ["reply", "person"]]);
  });
  it("taken once: recorded there (late: seenSeq), kept on disk and restored; a place already used is not reused", () => {
    let saved: any[] = [];
    const h = new WebChatHistory({ boot: "b1", store: { schedule: (_i: string, rows: () => unknown[]) => { saved = rows() as any[]; }, remove: async () => {} } });
    const place = h.reserve();
    h.record({ instance: "w", sender: "Ann", text: "meanwhile", ts: "t" });
    const late = h.record({ instance: "w", sender: "w", role: "agent", text: "reply", ts: "t", reserved: place });
    const again = h.record({ instance: "w", sender: "w", role: "agent", text: "not there", ts: "t", reserved: place });
    const back = new WebChatHistory({ boot: "b2" });
    back.restore("w", JSON.parse(JSON.stringify(saved)));
    expect([h.list("w").map(m => [m.id, m.text]), late.seenSeq! > 2, again.id > place, back.list("w").map(m => [m.text, m.seenSeq ?? null])])
      .toEqual([[[1, "reply"], [2, "meanwhile"], [late.seenSeq! + 1, "not there"]], true, true, [["reply", late.seenSeq], ["meanwhile", null], ["not there", null]]]);
  });
});
