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
