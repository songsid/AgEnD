/**
 * #1481: an agent's HTML preview in a side panel. The #1306 model is unchanged: the panel's frame is mountPreview's
 * (preview origin, sandbox allow-scripts only), started by a click, only for a server-marked agent reply, stopped
 * when the panel closes or the chat leaves. The real modules run here (panel-chat.js mounts the thread and the panel,
 * preview.js makes the frames) in the mini DOM; what a browser does with the frame is the smoke in the PR.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const BOOT = "e".repeat(32);
const PREVIEW_ORIGIN = "http://127.0.0.1:19281";
let PV: any, panel: any, pp: any;
const stream: Record<string, (m: unknown) => void> = {};
let current: AppPage | null = null;

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types (as app-harness.ts does for preact)
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  PV = (globalThis as any).AgendPreview;
  const base = installDom({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types
  panel = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  pp = await import("../src/ui/preview-panel.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({
    stream: { on(ev: string, fn: (m: unknown) => void) { stream[ev] = fn; } },
    boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: PREVIEW_ORIGIN, previewBoot: BOOT, previewReason: "" },
    deps: { fetch: () => new Promise(() => {}) },
  });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }, { name: "x", status: "running" }] });
  base.restore();
});

function fresh(storage: Record<string, string> = {}): AppPage {
  current = page({ storage: { agend_html_preview: "on", agend_tour_done: "1", ...storage } });
  return current;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await current?.unmount();
  PV.stopAll("test-end");
  pp.closePanel();
  panel.store.state.msgs.w = []; panel.store.state.msgs.x = [];
  current?.restore();
  current = null;
});

const ts = (id: number) => `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`;
const agent = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: ts(id) });
const human = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "web-user", role: "user", text, ts: ts(id) });
const FENCE = (body: string) => "```html\n" + body + "\n```";
const PAGE = (v: number, title = "Counter") => `<title>${title}</title><h1>v${v}</h1>`;

/** The chat for "w", with `msgs`, mounted the way the app mounts it; the split given a width (layout-free DOM). */
async function chat(msgs: unknown[], storage?: Record<string, string>) {
  const pg = fresh(storage);
  panel.store.state.msgs.w = msgs;
  await pg.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  const split = pg.document.querySelector(".chat-split") as any;
  split.clientWidth = 1200;
  return { pg, doc: pg.document as any, split };
}
const agentCards = (doc: any) => [...doc.querySelectorAll(".msg.agent .html-card")] as any[];
// The card's buttons are built from nodes with .onclick (chat-thread.js); the panel's are Preact listeners.
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(); };
/** Let the frame in `selector`'s holder answer ready, as the shim does; returns the frame. */
function ready(frame: any) {
  frame.contentWindow = { posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); } };
  PV.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "ready", ch: null, boot: BOOT } });
  return frame;
}
const ATTRS = (f: any) => Object.fromEntries(["sandbox", "allow", "referrerpolicy", "loading", "title"].map(k => [k, f.getAttribute(k)]));

describe("which blocks can go to the panel", () => {
  it("an agent's ```html block has Open in panel; the same block from a person has no card and so no panel action", async () => {
    const { doc } = await chat([human(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2)))]);
    expect(doc.querySelectorAll(".msg.user .html-card").length, "no card on the human's block").toBe(0);
    expect(doc.querySelectorAll(".msg.user .pv-open").length).toBe(0);
    expect(agentCards(doc).map(c => !!c.querySelector(".pv-open"))).toEqual([true]);
    expect(agentCards(doc)[0].querySelector(".pv-open").textContent).toBe("Open in panel");
  });
  it("a truncated block gets no Open in panel (as it gets no Preview)", async () => {
    const { doc } = await chat([agent(1, "```html\n<b>cut")]);
    expect(doc.querySelectorAll(".pv-open").length).toBe(0);
    expect(doc.querySelector(".html-card.truncated .pv-note").getAttribute("data-trust")).toBe("thread-control");
  });
});

describe("the panel's frame is the card's frame (#1306 §5.3)", () => {
  it("same attributes and preview-origin URL as an inline preview; filled by the panel, not by the frame's height messages", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    const card = agentCards(doc)[0];
    await click(card.querySelector(".pv-run"));
    const inline = PV.liveFrame("b-1:f0");
    const inlineAttrs = ATTRS(inline), inlineSrc = inline.src;
    await click(card.querySelector(".pv-open"));                    // moves the running preview
    const f = PV.liveFrame(pp.frameKey("b-1:f0"));
    expect(f, "the panel's frame runs").toBeTruthy();
    expect(ATTRS(f)).toEqual(inlineAttrs);
    expect(ATTRS(f)).toEqual({ sandbox: "allow-scripts", allow: "", referrerpolicy: "no-referrer", loading: "eager", title: "Untrusted HTML preview" });
    expect([f.src, inlineSrc]).toEqual([`${PREVIEW_ORIGIN}/frame`, `${PREVIEW_ORIGIN}/frame`]);
    expect(f.className).toBe("preview-frame fill");
    expect(doc.querySelector(".pv-panel .pv-holder").contains(f), "in the panel").toBe(true);
    ready(f);
    const ch = (f.contentWindow.posted[0] as any).ch;
    PV.onMessage({ source: f.contentWindow, origin: "null", data: { v: 1, type: "resize", ch, height: 900 } });
    await settle();
    expect(f.style.height ?? "", "the panel sizes it; no height is applied").toBe("");
  });
});

describe("open, move, close", () => {
  it("an idle card: Open in panel opens the panel and runs it there — that click is the Preview click (#1704); the card says where it is", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    const card = agentCards(doc)[0];
    expect(PV.liveCount(), "nothing runs before the click").toBe(0);
    await click(card.querySelector(".pv-open"));
    expect(!!doc.querySelector(".pv-panel"), "panel open").toBe(true);
    expect([PV.running(pp.frameKey("b-1:f0")), PV.running("b-1:f0"), PV.liveCount()], "in the panel, not in the card").toEqual([true, false, 1]);
    expect(card.querySelector(".pv-note").textContent).toBe("Shown in the panel.");
    expect([card.querySelector(".pv-run").hidden, card.querySelector(".pv-open").hidden]).toEqual([true, true]);
  });

  it("a running inline preview moves: the card's frame stops, the panel's starts — one frame on the page", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    const card = agentCards(doc)[0];
    await click(card.querySelector(".pv-run"));
    const inline = PV.liveFrame("b-1:f0");
    await click(card.querySelector(".pv-open"));
    expect([PV.running("b-1:f0"), inline.parentNode === null]).toEqual([false, true]);
    expect(card.querySelector(".pv-note").textContent, "the card was moved, not pre-empted by another preview").toBe("Shown in the panel.");
    expect([PV.running(pp.frameKey("b-1:f0")), PV.liveCount()]).toEqual([true, 1]);
    expect(!!doc.querySelector(".pv-panel .pv-banner"), "the #1306 banner goes with the running preview").toBe(true);
  });

  it("Close stops the frame and closes the panel; the card offers it again", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    const card = agentCards(doc)[0];
    await click(card.querySelector(".pv-open"));
    const f = PV.liveFrame(pp.frameKey("b-1:f0"));
    await click(doc.querySelectorAll(".pv-panel-close")[1]);
    expect([PV.liveCount(), f.parentNode === null, !!doc.querySelector(".pv-panel"), pp.panelStore.get().open]).toEqual([0, true, false, null]);
    expect([card.querySelector(".pv-open").hidden, card.querySelector(".pv-run").hidden, card.querySelector(".pv-note").textContent]).toEqual([false, false, ""]);
  });

  it("Stop removes the frame and keeps the panel; Reload runs it afresh (a new frame)", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    const f1 = ready(PV.liveFrame(pp.frameKey("b-1:f0")));
    await settle();
    await click(doc.querySelector(".pv-panel-reload"));
    const f2 = PV.liveFrame(pp.frameKey("b-1:f0"));
    expect([f2 !== f1, f1.parentNode === null, PV.liveCount()]).toEqual([true, true, 1]);
    await click(doc.querySelector(".pv-panel-stop"));
    expect([PV.liveCount(), f2.parentNode === null, !!doc.querySelector(".pv-panel"), !!doc.querySelector(".pv-panel-run")]).toEqual([0, true, true, true]);
  });

  it("Esc inside the panel closes it (and is not the chat's Stop reply)", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    const ev = new (globalThis as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    doc.querySelector(".pv-panel-run, .pv-panel-stop").dispatchEvent(ev);
    await settle();
    expect([ev.defaultPrevented, PV.liveCount(), !!doc.querySelector(".pv-panel")]).toEqual([true, 0, false]);
  });

  it("another instance opened: the panel and its frame are gone before the new chat shows", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    const f = PV.liveFrame(pp.frameKey("b-1:f0"));
    await pg.mount(h(panel.ChatPanel, { route: { instance: "x" }, navKey: "two" }));
    expect([PV.liveCount(), f.parentNode === null, !!doc.querySelector(".pv-panel"), pp.panelStore.get().open]).toEqual([0, true, false, null]);
  });

  it("the chat unmounts: the same", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    await pg.unmount();
    expect([PV.liveCount(), pp.panelStore.get().open]).toEqual([0, null]);
  });

  it("the device's opt-out (another tab) stops the panel's frame, and the panel says why", async () => {
    const { doc, pg } = await chat([agent(1, FENCE(PAGE(1)))]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    pg.storage.delete("agend_html_preview");
    PV.onStorage({ key: "agend_html_preview" });
    await settle();
    expect(PV.liveCount()).toBe(0);
    expect(doc.querySelector(".pv-panel .pv-note").textContent).toMatch(/switched off on this device/);
    expect(doc.querySelector(".pv-panel-run").disabled, "Preview is not offered while opted out").toBe(true);
    pg.storage.set("agend_html_preview", "on");
    PV.onStorage({ key: "agend_html_preview" });            // allowed again (another tab): offered again, nothing runs
    await settle();
    expect([doc.querySelector(".pv-panel-run").disabled, PV.liveCount()]).toEqual([false, 0]);
  });

  it("starting a preview in a card stops the panel's (one preview per page)", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2, "Other")))]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    await click(agentCards(doc)[1].querySelector(".pv-run"));
    expect([PV.running(pp.frameKey("b-1:f0")), PV.running("b-2:f0"), PV.liveCount()]).toEqual([false, true, 1]);
  });
});

describe("a newer version is offered, never swapped in", () => {
  it("a later reply with the same <title>: offered; the panel keeps running v1; Show it puts v2 there, not running", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1)))]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    const f = PV.liveFrame(pp.frameKey("b-1:f0"));
    stream.message(agent(2, "Updated:\n" + FENCE(PAGE(2))));
    await settle();
    expect(doc.querySelector(".pv-newer")?.textContent).toMatch(/A newer version is in the reply from/);
    expect([pp.panelStore.get().open.key, PV.liveFrame(pp.frameKey("b-1:f0")) === f]).toEqual(["b-1:f0", true]);
    await click(doc.querySelector(".pv-newer-show"));
    expect([pp.panelStore.get().open.key, PV.liveCount(), f.parentNode === null, !!doc.querySelector(".pv-panel-run")]).toEqual(["b-2:f0", 0, true, true]);
    expect(pp.panelStore.get().open.code).toContain("<h1>v2</h1>");
    expect(!!doc.querySelector(".pv-newer"), "nothing newer than v2").toBe(false);
  });

  it("which block counts as a newer version", () => {
    const k = (x: any) => `${x.boot}-${x.id}`;
    const open = { key: "b-1:f0", msgKey: "b-1", instance: "w", code: PAGE(1) };
    const at = (msgs: any[]) => pp.newerVersion(open, msgs, k)?.key ?? null;
    expect(at([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2, "Other")))]), "another title is another page").toBeNull();
    expect(at([agent(1, FENCE(PAGE(1))), human(2, FENCE(PAGE(2)))]), "a person's block is not the agent's version").toBeNull();
    expect(at([agent(1, FENCE(PAGE(1))), agent(2, "```html\n" + PAGE(2))]), "a cut block is not offered").toBeNull();
    expect(at([agent(0, FENCE(PAGE(9))), agent(1, FENCE(PAGE(1)))]), "an earlier reply is not newer").toBeNull();
    expect(at([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2))), agent(3, FENCE(PAGE(3, "Other")) + FENCE(PAGE(3)))]), "the newest match").toBe("b-3:f1");
    const untitled = { ...open, code: "<h1>v1</h1>" };
    expect(pp.newerVersion(untitled, [agent(1, FENCE("<h1>v1</h1>")), agent(2, FENCE(PAGE(2, "Anything")))], k)?.key, "untitled: the newest block").toBe("b-2:f0");
    expect(pp.newerVersion(open, [agent(5, FENCE(PAGE(5)))], k), "its own message gone: nothing offered").toBeNull();
  });
});

describe("the divider", () => {
  it("arrow keys, Home and End resize within [320, split − 368]; the width is kept for this device", async () => {
    const { doc, split, pg } = await chat([agent(1, FENCE(PAGE(1)))]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    const d = doc.querySelector(".pv-divider");
    expect([d.getAttribute("role"), d.getAttribute("aria-orientation"), d.getAttribute("tabindex"), d.getAttribute("aria-label")])
      .toEqual(["separator", "vertical", "0", "Resize the preview panel"]);
    expect(split.style["--pv-w"], "half the split at first").toBe("600px");
    const key = async (k: string) => { d.dispatchEvent(new (globalThis as any).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); await settle(); };
    await key("ArrowLeft");
    expect([split.style["--pv-w"], d.getAttribute("aria-valuenow"), pg.storage.get("agend_preview_panel_w")]).toEqual(["632px", "632", "632"]);
    await key("ArrowRight"); await key("ArrowRight");
    expect(split.style["--pv-w"]).toBe("568px");
    await key("Home");
    expect([split.style["--pv-w"], d.getAttribute("aria-valuemax")]).toEqual(["832px", "832"]);
    await key("End");
    expect(split.style["--pv-w"]).toBe("320px");
    await key("ArrowLeft");
    await click(doc.querySelectorAll(".pv-panel-close")[1]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    expect(split.style["--pv-w"], "reopened at the kept width").toBe("352px");
  });

  it("without storage the panel still opens and resizes", async () => {
    const { doc, split, pg } = await chat([agent(1, FENCE(PAGE(1)))]);
    const ls = (globalThis as any).localStorage;
    vi.spyOn(ls, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(ls, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    const d = doc.querySelector(".pv-divider");
    d.dispatchEvent(new (globalThis as any).KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await settle();
    expect(split.style["--pv-w"]).toBe("632px");
  });

  it("clampWidth: never under 320; the thread keeps 360 (+ the divider)", () => {
    expect([pp.clampWidth(100, 1200), pp.clampWidth(5000, 1200), pp.clampWidth(500, 1200), pp.clampWidth(500, 500)]).toEqual([320, 832, 500, 320]);
  });
});

describe("the source message", () => {
  it("'From …' shows the message the block came from", async () => {
    const { doc } = await chat([agent(1, FENCE(PAGE(1))), agent(2, "later")]);
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    expect(doc.querySelector(".pv-source").textContent).toMatch(/^From w, /);
    await click(doc.querySelector(".pv-source"));
    const msgs = [...doc.querySelectorAll(".thread .msg")] as any[];
    expect(msgs.map(m => m.classList.contains("flash"))).toEqual([true, false]);
  });
});

// #1770 (Prism r1 P2): the panel's source and newer-version lines say the day as the thread does, and follow it when the
// fleet's day changes while the panel is open — a render of the panel only: the same frame keeps running.
describe("#1770: the panel's labels follow the fleet's day", () => {
  const TZ = "Asia/Taipei";
  const at = (iso: string) => ({ ...agent(0, ""), ts: iso });
  const hm = (iso: string) => new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(Date.parse(iso));
  /** The page's day timers (onDayChange's: the thread's and the open panel's), as setTimeout saw them. */
  function dayTimers() {
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const armed = () => set.mock.calls.map((c, i) => ({ fn: c[0] as () => void, ms: c[1], id: set.mock.results[i]!.value }))
      .filter(c => String(c.fn).includes("if (live) arm()"));
    const fired = new Set<unknown>();
    const cleared = () => new Set(clear.mock.calls.map(c => c[0]));
    const live = () => armed().filter(c => !cleared().has(c.id) && !fired.has(c.id));
    /** Run the live day timers now, as their time coming would (the real ones are then spent). */
    const fire = () => { for (const t of live()) { fired.add(t.id); clearTimeout(t.id); t.fn(); } };
    return { live, fire };
  }
  async function openWithNewer() {
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-13T15:30:00Z") }); // 23:30 in Taipei
    const timers = dayTimers();
    const pg = fresh();
    (pg.document as any).body.dataset.fleetTz = TZ;
    const one = { ...at("2026-10-13T15:10:00Z"), id: 1, text: FENCE(PAGE(1)) };
    const two = { ...at("2026-10-13T15:20:00Z"), id: 2, text: "Updated:\n" + FENCE(PAGE(2)) };
    panel.store.state.msgs.w = [one];
    await pg.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
    const doc = pg.document as any;
    doc.querySelector(".chat-split").clientWidth = 1200;
    await click(agentCards(doc)[0].querySelector(".pv-open"));
    stream.message(two);
    await settle();
    const frame = PV.liveFrame(pp.frameKey("b-1:f0"));
    return { pg, doc, frame, timers, one, two };
  }
  const labels = (doc: any) => ({
    thread: [...doc.querySelectorAll(".thread .meta .time")].map((e: any) => e.textContent),
    source: doc.querySelector(".pv-source")?.textContent,
    newer: doc.querySelector(".pv-newer span")?.textContent,
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("at the fleet's midnight the open panel relabels (Yesterday) with the thread — same frame, same open block, still running", async () => {
    const { doc, frame, timers, one, two } = await openWithNewer();
    expect(labels(doc)).toEqual({ thread: [hm(one.ts), hm(two.ts)], source: `From w, ${hm(one.ts)} — show the message`, newer: `A newer version is in the reply from ${hm(two.ts)}.` });
    expect(timers.live().map(t => t.ms), "the thread's and the panel's, for 00:00:01 in Taipei").toEqual([30 * 60_000 + 1000, 30 * 60_000 + 1000]);
    vi.setSystemTime(Date.parse("2026-10-13T16:01:00Z"));                   // 00:01 on the 14th
    timers.fire();
    await settle();
    expect(labels(doc)).toEqual({
      thread: [`Yesterday ${hm(one.ts)}`, `Yesterday ${hm(two.ts)}`],
      source: `From w, Yesterday ${hm(one.ts)} — show the message`,
      newer: `A newer version is in the reply from Yesterday ${hm(two.ts)}.`,
    });
    expect([PV.liveFrame(pp.frameKey("b-1:f0")) === frame, PV.liveCount(), pp.panelStore.get().open.key]).toEqual([true, 1, "b-1:f0"]);
    expect(timers.live().map(t => t.ms), "armed again (an hour at most)").toEqual([3_600_000, 3_600_000]);
  });

  it("control — a late clock with no timer: the panel's next render (Code) relabels it; the frame is the same", async () => {
    const { doc, frame, one } = await openWithNewer();
    vi.setSystemTime(Date.parse("2026-10-14T16:05:00Z"));                   // two days on, no timer has run
    await click([...doc.querySelectorAll(".pv-panel-bar .btn")].find((b: any) => b.textContent.includes("Code")));
    expect(labels(doc).source).toBe(`From w, 10/13 ${hm(one.ts)} — show the message`);
    expect(PV.liveFrame(pp.frameKey("b-1:f0")) === frame).toBe(true);
  });

  it("closing the panel keeps the thread's timer; leaving the chat clears it — nothing is left armed", async () => {
    const { pg, doc, timers } = await openWithNewer();
    await click(doc.querySelector(".pv-panel-close"));
    expect(!!doc.querySelector(".pv-panel")).toBe(false);
    expect(timers.live(), "the panel's went with it; the thread still has lines").toHaveLength(1);
    vi.setSystemTime(Date.parse("2026-10-13T16:01:00Z"));
    expect(() => timers.fire(), "the closed panel's listener is gone").not.toThrow();
    await settle();
    expect(labels(doc).thread[0]).toMatch(/^Yesterday /);
    await pg.unmount();
    current = null; pg.restore();
    expect(timers.live(), "no day timer after the chat left").toEqual([]);
  });
});
