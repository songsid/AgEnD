/**
 * #1704: "Open in panel" on an HTML card is the person's click that runs the preview — the panel opens and starts it,
 * as if Preview were clicked there. A device that has not allowed previews is offered Allow first, and allowing runs
 * the block that click opened; where previews cannot run (web.preview: false, a public link) nothing runs; a newer
 * version is offered, never run; a running card's preview still moves. Nothing runs by itself. The real modules
 * (panel-chat.js mounting the thread and the panel, preview.js making the frames) in the mini DOM.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const BOOT = "e".repeat(32);
const ORIGIN = "http://127.0.0.1:19280";
const ON = { dashboardOrigin: ORIGIN, previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" };
let PV: any, panel: any, pp: any, confirm: any;
const stream: Record<string, (m: unknown) => void> = {};
let current: AppPage | null = null;

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  PV = (globalThis as any).AgendPreview;
  const base = installDom({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types
  panel = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  pp = await import("../src/ui/preview-panel.js");
  confirm = await import("/assets/ui-confirm.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({ stream: { on(ev: string, fn: (m: unknown) => void) { stream[ev] = fn; } }, boot: ON, deps: { fetch: () => new Promise(() => {}) } });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await current?.unmount();
  PV.stopAll("test-end");
  pp.closePanel();
  PV.init(ON);
  for (const q of confirm.confirmStore.get().queue) confirm.answerConfirm(q.id, false);
  (globalThis as any).confirm = () => true;
  panel.store.state.msgs.w = [];
  current?.restore();
  current = null;
});

const ts = (id: number) => `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`;
const agent = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: ts(id) });
const FENCE = (body: string) => "```html\n" + body + "\n```";
const PAGE = (v: number, title = "Counter") => `<title>${title}</title><h1>v${v}</h1>`;
const ALLOWED = { agend_html_preview: "on" };

/** The chat for "w" with `msgs`, as the app mounts it; `storage` decides this device's opt-in. */
async function chat(msgs: unknown[], storage: Record<string, string> = ALLOWED) {
  current = page({ url: `${ORIGIN}/ui/chat/w`, storage: { agend_tour_done: "1", ...storage } });
  panel.store.state.msgs.w = msgs;
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  const doc = current.document as any;
  doc.querySelector(".chat-split").clientWidth = 1200;
  return { doc, pg: current };
}
const cards = (doc: any) => [...doc.querySelectorAll(".msg.agent .html-card")] as any[];
// The card's buttons are nodes with .onclick (chat-thread.js); the panel's are Preact listeners.
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(); };
const openIn = (doc: any, i = 0) => click(cards(doc)[i].querySelector(".pv-open"));
/** What the panel shows: running here, the frames on the page, Allow offered, Preview offered (and enabled), the note. */
const panelState = (doc: any, key = "b-1:f0") => ({
  running: PV.running(pp.frameKey(key)), live: PV.liveCount(),
  allow: !!doc.querySelector(".pv-panel .pv-panel-allow"),
  preview: doc.querySelector(".pv-panel-run") ? (doc.querySelector(".pv-panel-run").disabled ? "disabled" : "enabled") : "none",
});
/** The app's confirm answered `yes` (as confirm() would). */
const answering = (yes: boolean) => { (globalThis as any).confirm = () => yes; };
/** Click the panel's Allow and leave its confirm open; returns the answer to give later. */
async function allowHeld(doc: any) {
  (globalThis as any).confirm = undefined;
  doc.querySelector(".pv-panel-allow").click(); await settle();
  const q = confirm.confirmStore.get().queue[0];
  expect(q, "the confirm is asking").toBeTruthy();
  return async (yes: boolean) => { confirm.answerConfirm(q.id, yes); await settle(); await settle(); };
}
// An agent reply attaching an .html file (#1306 Q4): its HTML is read from /ui/file/<id> on the first click.
const ID1 = "1".repeat(32);
const withFile = (id: number, fileId: string, name: string) => ({ ...agent(id, "Here it is."), attachments: [{ id: fileId, kind: "document", name, size: 8400, mime: "application/octet-stream" }] });
const ID2 = "2".repeat(32);
/** /ui/file/<id> answers files[id], each held until release(id). */
function heldFiles(files: Record<string, string>) {
  const held = new Map<string, () => void>();
  globalThis.fetch = vi.fn((url: string) => {
    const id = /\/ui\/file\/([0-9a-f]{32})$/.exec(url)![1];
    return new Promise(r => held.set(id, () => r({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(files[id]).buffer })));
  }) as any;
  return { release: async (id: string) => { held.get(id)!(); held.delete(id); await settle(); await settle(); } };
}
/** /ui/file answers `body`, held until release(). */
function heldFile(body: string) {
  const held: Array<() => void> = [];
  globalThis.fetch = vi.fn(() => new Promise(r => held.push(() => r({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer })))) as any;
  return { release: async () => { for (const r of held.splice(0)) r(); await settle(); await settle(); } };
}

describe("one click: Open in panel runs it", () => {
  it("an idle card: the panel opens running — no Preview to click; the card's own frame never starts", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    expect(PV.liveCount(), "nothing runs on load").toBe(0);
    await openIn(doc);
    expect(panelState(doc)).toEqual({ running: true, live: 1, allow: false, preview: "none" });
    expect(PV.running("b-1:f0"), "not in the card").toBe(false);
    expect(doc.querySelector(".pv-panel .pv-holder").contains(PV.liveFrame(pp.frameKey("b-1:f0"))), "the frame is the panel's").toBe(true);
  });

  it("a card whose preview runs: it moves (stopped in the card, started in the panel) — one frame on the page", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    await click(cards(doc)[0].querySelector(".pv-run"));
    const inline = PV.liveFrame("b-1:f0");
    await openIn(doc);
    expect([PV.running("b-1:f0"), inline.parentNode === null, panelState(doc)]).toEqual([false, true, { running: true, live: 1, allow: false, preview: "none" }]);
  });

  it("stopped in the panel, it stays stopped: a new message, the Code tab and back start nothing", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    await openIn(doc);
    await click(doc.querySelector(".pv-panel-stop"));
    stream.message(agent(2, "just text")); await settle();
    const [page_, code] = doc.querySelectorAll(".pv-panel-bar .seg-inline button");
    await click(code); await click(page_);
    expect(panelState(doc)).toEqual({ running: false, live: 0, allow: false, preview: "enabled" });
  });

  it("a second card's Open in panel: the first block's frame stops, the second's runs", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2, "Other")))]);
    await openIn(doc, 0);
    await openIn(doc, 1);
    expect([PV.running(pp.frameKey("b-1:f0")), PV.running(pp.frameKey("b-2:f0")), PV.liveCount()]).toEqual([false, true, 1]);
  });
});

describe("a device that has not allowed previews", () => {
  it("the panel opens on the Allow offer, nothing running; Allow (confirmed) runs it at once", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);
    expect(panelState(doc)).toEqual({ running: false, live: 0, allow: true, preview: "disabled" });
    answering(true);
    await click(doc.querySelector(".pv-panel-allow")); await settle();
    expect([pg.storage.get("agend_html_preview"), panelState(doc)]).toEqual(["on", { running: true, live: 1, allow: false, preview: "none" }]);
  });

  it("Allow refused: nothing stored, nothing runs, still offered", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);
    answering(false);
    await click(doc.querySelector(".pv-panel-allow")); await settle();
    expect([pg.storage.get("agend_html_preview") ?? null, panelState(doc)]).toEqual([null, { running: false, live: 0, allow: true, preview: "disabled" }]);
  });

  it("allowed in another tab meanwhile: nothing runs here — Preview is offered, a click runs it", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);
    pg.storage.set("agend_html_preview", "on"); PV.onStorage({ key: "agend_html_preview" }); await settle();
    expect(panelState(doc)).toEqual({ running: false, live: 0, allow: false, preview: "enabled" });
    await click(doc.querySelector(".pv-panel-run"));
    expect(panelState(doc).running).toBe(true);
  });

  it("the panel moved on to a newer version before Allow: allowing does not run the newer one (it waits for its Preview)", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);
    stream.message(agent(2, "v2:\n" + FENCE(PAGE(2)))); await settle();
    await click(doc.querySelector(".pv-newer-show"));
    answering(true);
    await click(doc.querySelector(".pv-panel-allow")); await settle();
    expect([pp.panelStore.get().open.key, panelState(doc, "b-2:f0")]).toEqual(["b-2:f0", { running: false, live: 0, allow: false, preview: "enabled" }]);
  });
});

describe("Allow runs only the click it was offered for", () => {
  it("the click came while previews were switched off for the session (Never): Never undone, then Allow — nothing runs, Preview is offered", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))], {});
    PV.setNever(true);
    try { await openIn(doc); } finally { PV.setNever(false); }
    await settle();
    answering(true);
    await click(doc.querySelector(".pv-panel-allow")); await settle();
    expect(panelState(doc)).toEqual({ running: false, live: 0, allow: false, preview: "enabled" });
  });

  it("the panel moved on while the confirm was open: allowing runs neither the old block nor the new one", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2, "Other")))], {});
    await openIn(doc, 0);
    (globalThis as any).confirm = undefined;                      // the dialog stays open until answered below
    doc.querySelector(".pv-panel-allow").click(); await settle();
    const q = confirm.confirmStore.get().queue[0];
    expect(q?.message, "the confirm is asking").toBeTruthy();
    const b = pp.panelStore.get().open;
    pp.openPanel({ ...b, key: "b-2:f0", msgKey: "b-2", n: 0, code: PAGE(2, "Other") }); await settle();
    confirm.answerConfirm(q.id, true); await settle(); await settle();
    expect([PV.liveCount(), PV.running(pp.frameKey("b-1:f0")), PV.running(pp.frameKey("b-2:f0")), pp.panelStore.get().open.key]).toEqual([0, false, false, "b-2:f0"]);
  });

  it("a click already run (Preview, after another tab allowed) is used up: opted out and allowed again here, nothing reruns", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);
    pg.storage.set("agend_html_preview", "on"); PV.onStorage({ key: "agend_html_preview" }); await settle();
    await click(doc.querySelector(".pv-panel-run"));
    expect(panelState(doc).running).toBe(true);
    pg.storage.delete("agend_html_preview"); PV.onStorage({ key: "agend_html_preview" }); await settle();
    expect(panelState(doc), "stopped by the opt-out; Allow offered").toEqual({ running: false, live: 0, allow: true, preview: "disabled" });
    answering(true);
    await click(doc.querySelector(".pv-panel-allow")); await settle();
    expect(panelState(doc)).toEqual({ running: false, live: 0, allow: false, preview: "enabled" });
  });

  it("each block shown starts with no click waiting: a later Open in panel made under Never is not run by Allow", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);                                           // waits for Allow
    stream.message(agent(2, "v2:\n" + FENCE(PAGE(2)))); await settle();
    await click(doc.querySelector(".pv-newer-show"));            // another block shown (no click to run it)
    PV.setNever(true);
    try { await openIn(doc, 0); } finally { PV.setNever(false); }  // a click while previews are switched off
    await settle();
    answering(true);
    await click(doc.querySelector(".pv-panel-allow")); await settle();
    expect([pp.panelStore.get().open.key, panelState(doc)]).toEqual(["b-1:f0", { running: false, live: 0, allow: false, preview: "enabled" }]);
  });
});

describe("review r1: a waiting click is used once, by its own Allow, for what it opened", () => {
  it("control: Allow answered later — the same click runs", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);
    const answer = await allowHeld(doc);
    await answer(true);
    expect(panelState(doc)).toEqual({ running: true, live: 1, allow: false, preview: "none" });
  });

  for (const [how, away] of [["closed", () => pp.closePanel()], ["shown without a run", () => pp.openPanel({ ...pp.panelStore.get().open }, { run: false })]] as const) {
    it(`A's Allow is waiting; the panel ${how}, then B opened: the answer runs neither (no run token is ever reused)`, async () => {
      const { doc } = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2, "Other")))], {});
      await openIn(doc, 0);
      const answer = await allowHeld(doc);
      away(); await settle();
      await openIn(doc, 1);
      await answer(true);
      expect([pp.panelStore.get().open.key, PV.running(pp.frameKey("b-1:f0")), panelState(doc, "b-2:f0")])
        .toEqual(["b-2:f0", false, { running: false, live: 0, allow: false, preview: "enabled" }]);
    });
  }

  it("A's Allow is waiting; the panel moves on to a newer version (no click to run it): the answer runs nothing", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1))), agent(2, "v2:\n" + FENCE(PAGE(2)))], {});
    await openIn(doc, 0);
    const answer = await allowHeld(doc);
    await click(doc.querySelector(".pv-newer-show"));
    await answer(true);
    expect([pp.panelStore.get().open.key, PV.running(pp.frameKey("b-1:f0")), panelState(doc, "b-2:f0")])
      .toEqual(["b-2:f0", false, { running: false, live: 0, allow: false, preview: "enabled" }]);
  });

  it("A's Allow is waiting; another tab allows, Preview here runs it, Stop — the late answer does not run it again", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);
    const answer = await allowHeld(doc);
    pg.storage.set("agend_html_preview", "on"); PV.onStorage({ key: "agend_html_preview" }); await settle();
    await click(doc.querySelector(".pv-panel-run"));
    expect(panelState(doc).running).toBe(true);
    await click(doc.querySelector(".pv-panel-stop"));
    await answer(true);
    expect(panelState(doc)).toEqual({ running: false, live: 0, allow: false, preview: "enabled" });
  });

  it("the card's Never cancels the waiting click: undone, then Allow — nothing runs; Preview needs a new click", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);
    const never = cards(doc)[0].querySelector(".pv-never");
    await click(never);                                          // Never preview (this session)
    await click(never);                                          // undone
    answering(true);
    await click(doc.querySelector(".pv-panel-allow")); await settle();
    expect(panelState(doc)).toEqual({ running: false, live: 0, allow: false, preview: "enabled" });
  });
});

describe("review r2", () => {
  it("A's Allow is waiting; another tab allows and then disallows: the click is cancelled — the answer allows, nothing runs", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))], {});
    await openIn(doc);
    const answer = await allowHeld(doc);
    pg.storage.set("agend_html_preview", "on"); PV.onStorage({ key: "agend_html_preview" }); await settle();
    pg.storage.delete("agend_html_preview"); PV.onStorage({ key: "agend_html_preview" }); await settle();
    await answer(true);
    expect([pg.storage.get("agend_html_preview"), panelState(doc)]).toEqual(["on", { running: false, live: 0, allow: false, preview: "enabled" }]);
  });

  it("two files clicked in turn, both still reading: A answers first — dropped; B answers — shown and running", async () => {
    const f = heldFiles({ [ID1]: PAGE(1), [ID2]: PAGE(2, "Other") });
    const { doc } = await chat([withFile(1, ID1, "a.html"), withFile(2, ID2, "b.html")]);
    await openIn(doc, 0);
    await openIn(doc, 1);
    await f.release(ID1);
    expect([pp.panelStore.get().open, PV.liveCount()], "A's late answer opens nothing").toEqual([null, 0]);
    await f.release(ID2);
    expect([pp.panelStore.get().open?.key, PV.running(pp.frameKey(`b-2:a${ID2}`)), PV.liveCount()]).toEqual([`b-2:a${ID2}`, true, 1]);
  });

  it("control: the same two, B answers first — B shown and running; A's later answer leaves it", async () => {
    const f = heldFiles({ [ID1]: PAGE(1), [ID2]: PAGE(2, "Other") });
    const { doc } = await chat([withFile(1, ID1, "a.html"), withFile(2, ID2, "b.html")]);
    await openIn(doc, 0);
    await openIn(doc, 1);
    await f.release(ID2);
    await f.release(ID1);
    expect([pp.panelStore.get().open?.key, PV.running(pp.frameKey(`b-2:a${ID2}`)), PV.liveCount()]).toEqual([`b-2:a${ID2}`, true, 1]);
  });

  it("A's file is reading when B's Preview in a card is clicked (its file reading too): A answers first — no panel; B runs in its card", async () => {
    const f = heldFiles({ [ID1]: PAGE(1), [ID2]: PAGE(2, "Other") });
    const { doc } = await chat([withFile(1, ID1, "a.html"), withFile(2, ID2, "b.html")]);
    await openIn(doc, 0);
    await click(cards(doc)[1].querySelector(".pv-run"));
    await f.release(ID1);
    expect([pp.panelStore.get().open, PV.liveCount()]).toEqual([null, 0]);
    await f.release(ID2);
    expect([PV.running(`b-2:a${ID2}`), pp.panelStore.get().open, PV.liveCount()]).toEqual([true, null, 1]);
  });

  it("review r3: A's Preview in its card is reading when B is opened in the panel (reading too): A answers first — dropped; B runs in the panel", async () => {
    const f = heldFiles({ [ID1]: PAGE(1), [ID2]: PAGE(2, "Other") });
    const { doc } = await chat([withFile(1, ID1, "a.html"), withFile(2, ID2, "b.html")]);
    await click(cards(doc)[0].querySelector(".pv-run"));
    await openIn(doc, 1);
    await f.release(ID1);
    await f.release(ID2);
    expect([pp.panelStore.get().open?.key, PV.running(`b-1:a${ID1}`), PV.running(pp.frameKey(`b-2:a${ID2}`)), PV.liveCount()]).toEqual([`b-2:a${ID2}`, false, true, 1]);
  });

  it("a second Open in panel on a card still reading claims nothing: the first click opens it when its file comes", async () => {
    const f = heldFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([withFile(1, ID1, "a.html")]);
    await openIn(doc, 0);
    await openIn(doc, 0);
    await f.release(ID1);
    expect([pp.panelStore.get().open?.key, PV.running(pp.frameKey(`b-1:a${ID1}`))]).toEqual([`b-1:a${ID1}`, true]);
  });

  it("review r3 control: A's Preview read and running before B's Open in panel — B runs in the panel, A stops", async () => {
    const f = heldFiles({ [ID1]: PAGE(1), [ID2]: PAGE(2, "Other") });
    const { doc } = await chat([withFile(1, ID1, "a.html"), withFile(2, ID2, "b.html")]);
    await click(cards(doc)[0].querySelector(".pv-run"));
    await f.release(ID1);
    expect(PV.running(`b-1:a${ID1}`)).toBe(true);
    await openIn(doc, 1);
    await f.release(ID2);
    expect([pp.panelStore.get().open?.key, PV.running(`b-1:a${ID1}`), PV.running(pp.frameKey(`b-2:a${ID2}`)), PV.liveCount()]).toEqual([`b-2:a${ID2}`, false, true, 1]);
  });

  it("review r4: A's Preview in its card is reading when the panel's own Preview runs B: A answers — B keeps running, A does not start", async () => {
    const f = heldFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([withFile(1, ID1, "a.html"), agent(2, FENCE(PAGE(2, "Other")))]);
    await openIn(doc, 1);
    await click(doc.querySelector(".pv-panel-stop"));
    await click(cards(doc)[0].querySelector(".pv-run"));
    await click(doc.querySelector(".pv-panel-run"));
    expect(PV.running(pp.frameKey("b-2:f0"))).toBe(true);
    await f.release(ID1);
    expect([PV.running(`b-1:a${ID1}`), PV.running(pp.frameKey("b-2:f0")), PV.liveCount()]).toEqual([false, true, 1]);
  });

  it("review r4 control: the same without the panel's Preview — A's read completes and runs in its card", async () => {
    const f = heldFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([withFile(1, ID1, "a.html"), agent(2, FENCE(PAGE(2, "Other")))]);
    await openIn(doc, 1);
    await click(doc.querySelector(".pv-panel-stop"));
    await click(cards(doc)[0].querySelector(".pv-run"));
    await f.release(ID1);
    expect([PV.running(`b-1:a${ID1}`), PV.liveCount()]).toEqual([true, 1]);
  });

  it("A's Preview in its card is reading when the panel (showing B) is closed: A still runs in its card — a close is not a newer click", async () => {
    const f = heldFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([withFile(1, ID1, "a.html"), agent(2, FENCE(PAGE(2, "Other")))]);
    await openIn(doc, 1);
    await click(cards(doc)[0].querySelector(".pv-run"));
    await click(doc.querySelectorAll(".pv-panel-close")[1]);
    await f.release(ID1);
    expect([PV.running(`b-1:a${ID1}`), pp.panelStore.get().open, PV.liveCount()]).toEqual([true, null, 1]);
  });

  it("A's file is reading when the panel (showing B) is closed: A's answer opens nothing — closing is newer than the click", async () => {
    const f = heldFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([withFile(1, ID1, "a.html"), agent(2, FENCE(PAGE(2, "Other")))]);
    await openIn(doc, 1);
    await openIn(doc, 0);
    await click(doc.querySelectorAll(".pv-panel-close")[1]);
    await f.release(ID1);
    expect([pp.panelStore.get().open, PV.liveCount()]).toEqual([null, 0]);
  });

  it("A's file is reading when the panel's own Preview runs what it shows (B): A answers — B keeps running", async () => {
    const f = heldFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([withFile(1, ID1, "a.html"), agent(2, FENCE(PAGE(2, "Other")))]);
    await openIn(doc, 1);
    await click(doc.querySelector(".pv-panel-stop"));
    await openIn(doc, 0);
    await click(doc.querySelector(".pv-panel-run"));
    expect(PV.running(pp.frameKey("b-2:f0"))).toBe(true);
    await f.release(ID1);
    expect([pp.panelStore.get().open.key, PV.running(pp.frameKey("b-2:f0")), PV.liveCount()]).toEqual(["b-2:f0", true, 1]);
  });
});

describe("review r1: a late attachment read never undoes a newer click", () => {
  it("control: Open in panel on an attached file — read, opened, running", async () => {
    const f = heldFile(PAGE(1));
    const { doc } = await chat([withFile(1, ID1, "a.html")]);
    await openIn(doc);
    expect(PV.liveCount(), "still reading").toBe(0);
    await f.release();
    expect([pp.panelStore.get().open?.key, PV.running(pp.frameKey(`b-1:a${ID1}`))]).toEqual([`b-1:a${ID1}`, true]);
  });

  it("A's file is still being read when B is opened in the panel (running): A's answer comes — B keeps running, A is not shown", async () => {
    const f = heldFile(PAGE(1));
    const { doc } = await chat([withFile(1, ID1, "a.html"), agent(2, FENCE(PAGE(2, "Other")))]);
    await openIn(doc, 0);
    await openIn(doc, 1);
    expect(PV.running(pp.frameKey("b-2:f0"))).toBe(true);
    await f.release();
    expect([pp.panelStore.get().open.key, PV.running(pp.frameKey("b-2:f0")), PV.running(pp.frameKey(`b-1:a${ID1}`)), PV.liveCount()]).toEqual(["b-2:f0", true, false, 1]);
  });

  it("not allowed: A's file is still being read when B is opened in the panel (its Allow offered, nothing runs): A's answer comes — the panel keeps B", async () => {
    const f = heldFile(PAGE(1));
    const { doc } = await chat([withFile(1, ID1, "a.html"), agent(2, FENCE(PAGE(2, "Other")))], {});
    await openIn(doc, 0);
    await openIn(doc, 1);
    await f.release();
    expect([pp.panelStore.get().open.key, PV.liveCount(), panelState(doc, "b-2:f0").allow]).toEqual(["b-2:f0", 0, true]);
  });

  it("A's file is still being read when B's own Preview runs in its card: A's answer comes — B keeps running, no panel", async () => {
    const f = heldFile(PAGE(1));
    const { doc } = await chat([withFile(1, ID1, "a.html"), agent(2, FENCE(PAGE(2, "Other")))]);
    await openIn(doc, 0);
    await click(cards(doc)[1].querySelector(".pv-run"));
    await f.release();
    expect([PV.running("b-2:f0"), pp.panelStore.get().open, PV.liveCount()]).toEqual([true, null, 1]);
  });
});

describe("where previews cannot run", () => {
  for (const [what, code] of [["web.preview: false", "fleetOff"], ["a public link", "publicLink"]] as const) {
    it(`${what}: the panel opens with nothing running, no Allow, Preview off — the server's reason said`, async () => {
      PV.init({ dashboardOrigin: ORIGIN, previewOrigin: "", previewBoot: "", previewReason: "server words", previewReasonCode: code });
      const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
      await openIn(doc);
      expect(panelState(doc)).toEqual({ running: false, live: 0, allow: false, preview: "disabled" });
      expect(doc.querySelector(".pv-panel .pv-note").textContent).toBe(PV.availability().reason);
    });
  }

  it("Never preview (this session) on a device that allowed them: nothing runs, no Allow", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    PV.setNever(true);
    try {
      await openIn(doc);
      expect(panelState(doc)).toEqual({ running: false, live: 0, allow: false, preview: "disabled" });
    } finally { PV.setNever(false); }
  });
});

describe("a newer version is offered, not run", () => {
  it("while v1 runs in the panel, v2 arrives: offered; Show it puts v2 there with Preview to click — nothing runs", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    await openIn(doc);
    const f = PV.liveFrame(pp.frameKey("b-1:f0"));
    stream.message(agent(2, "Updated:\n" + FENCE(PAGE(2)))); await settle();
    expect([!!doc.querySelector(".pv-newer"), PV.liveFrame(pp.frameKey("b-1:f0")) === f], "offered; v1 keeps running").toEqual([true, true]);
    await click(doc.querySelector(".pv-newer-show"));
    expect([pp.panelStore.get().open.key, f.parentNode === null, panelState(doc, "b-2:f0")]).toEqual(["b-2:f0", true, { running: false, live: 0, allow: false, preview: "enabled" }]);
    await click(doc.querySelector(".pv-panel-run"));
    expect(panelState(doc, "b-2:f0").running, "its own Preview click runs it").toBe(true);
  });
});
