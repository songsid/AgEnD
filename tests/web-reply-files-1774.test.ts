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
    hold.open(); await done;
    expect([fm.webChatHistory.list("gone"), snapshots("gone")]).toEqual([[], []]);
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
