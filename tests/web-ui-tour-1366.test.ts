/**
 * #1366 item 4: the first sign-in tour in /ui. Shown once on this device, dismissed by Got it / Skip / Esc, replayed
 * from Tour in the sidebar, and built from classes only (#1300: no style attribute, no inline style). The tour
 * (chat-tour.js) and the shell's key handling (app-shell.js) run as the app imports them, in the mini DOM; what a
 * browser does with them is the smoke in the PR.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, MiniEvent, settle, type MiniPage } from "./helpers/mini-dom.js";

const UI = join(process.cwd(), "src", "ui");
const TOUR_SRC = readFileSync(join(UI, "chat-tour.js"), "utf8");
const PANEL_SRC = readFileSync(join(UI, "panel-chat.js"), "utf8");
const TOUR_KEY = "agend_tour_done";

let current: MiniPage | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  current?.restore();
  current = null;
});

/**
 * The page on a fresh load: the shell's element ids the tour outlines, and the app's own key listener (app.js installs
 * handleKey on the document). `storage` is this device's, shared across loads by passing a previous load's entries.
 * `blockTourKey`: this browser's storage throws for the tour's key (private windows, blocked site data).
 */
async function load(opts: { storage?: Record<string, string>; narrow?: boolean; lang?: string; blockTourKey?: boolean; install?: boolean } = {}) {
  vi.resetModules();
  const storage = { ...(opts.lang ? { agend_lang: opts.lang } : {}), ...(opts.storage ?? {}) };
  const dom = installDom({ storage, matchNarrow: !!opts.narrow });
  current = dom;
  const doc = dom.document;
  for (const id of ["instanceList", "main", "attachBtn", "sendBtn", "stopBtn", "sbOpen", "msgIn"]) {
    const e = doc.createElement("div"); e.id = id; doc.body.append(e);
  }
  (doc.getElementById("stopBtn") as any).hidden = true;
  if (opts.blockTourKey) {
    const real = (globalThis as any).localStorage;
    const refuse = (k: string) => { if (k === TOUR_KEY) throw new Error("SecurityError"); };
    (globalThis as any).localStorage = {
      getItem: (k: string) => { refuse(k); return real.getItem(k); },
      setItem: (k: string, v: string) => { refuse(k); real.setItem(k, v); },
      removeItem: (k: string) => real.removeItem(k),
    };
  }
  const shell = await import("/assets/app-shell.js");
  // @ts-expect-error — a JS module of the app, with no types (as app-harness.ts does for preact)
  const tour = await import("../src/ui/chat-tour.js");
  doc.addEventListener("keydown", shell.handleKey);
  if (opts.install !== false) tour.installTour();   // the chat's boot() does this on the page
  await settle();                                   // the first showing waits one macrotask
  const card = () => doc.getElementById("tour");
  const text = () => card()?.querySelector(".tour-text")?.textContent;
  const buttons = () => (card()?.querySelectorAll("button") ?? []) as any[];
  const button = (label: string) => buttons().find(b => b.textContent === label)!;
  const click = (el: any) => el.click();
  /** A key press goes to the focused element, as a browser sends it; a held key repeats. */
  const key = (k: string, repeat = false) => {
    const target = (doc.activeElement ?? doc.body) as any;
    target.dispatchEvent(new MiniEvent("keydown", { bubbles: true, key: k, repeat, isComposing: false }));
  };
  const spotted = () => (doc.querySelectorAll(".tour-spot") as any[]).map(e => e.id);
  return { doc, dom, shell, tour, storage: dom.storage, card, text, buttons, button, click, key, spotted };
}

describe("the first sign-in tour (#1366)", () => {
  it("opens on the first load: step 1 of 5, the instance list outlined, focus on Next", async () => {
    const p = await load();
    expect(p.card()?.getAttribute("role")).toBe("dialog");
    expect(p.text()).toMatch(/Pick an instance/);
    expect(p.card()!.querySelector(".tour-count")?.textContent).toBe("1 of 5");
    expect(p.spotted()).toEqual(["instanceList"]);
    expect(p.doc.activeElement?.textContent).toBe("Next");
    expect(p.buttons().map(b => b.textContent)).toEqual(["Skip", "Next"]);
  });

  it("walks the five points — same conversation, files, Stop, needs you — and Back goes back", async () => {
    const p = await load();
    p.click(p.button("Next"));
    expect([p.text(), p.spotted()]).toEqual([expect.stringMatching(/same conversation as its Telegram or Discord/), ["main"]]);
    p.click(p.button("Next"));
    expect([p.text(), p.spotted()]).toEqual([expect.stringMatching(/📎/), ["attachBtn"]]);
    p.click(p.button("Back"));
    expect(p.spotted()).toEqual(["main"]);
    p.click(p.button("Next")); p.click(p.button("Next"));
    expect([p.text(), p.spotted()]).toEqual([expect.stringMatching(/Stop reply appears/), ["sendBtn"]]);
    p.click(p.button("Next"));
    expect(p.text()).toMatch(/needs you/);
    expect(p.buttons().map(b => b.textContent)).toEqual(["Back", "Got it"]);
  });

  it("outlines Stop when it is showing, and a real needs-you badge when there is one", async () => {
    const p = await load();
    (p.doc.getElementById("stopBtn") as any).hidden = false;
    const badge = p.doc.createElement("span"); badge.id = "badge"; badge.className = "badge-await";
    p.doc.getElementById("instanceList")!.append(badge);
    for (let i = 0; i < 3; i++) p.click(p.button("Next"));
    expect(p.spotted()).toEqual(["stopBtn"]);
    p.click(p.button("Next"));
    expect(p.spotted()).toEqual(["badge"]);
  });

  it("Got it closes it, clears the outline, and it never opens again on this device", async () => {
    const first = await load();
    for (let i = 0; i < 4; i++) first.click(first.button("Next"));
    first.click(first.button("Got it"));
    expect([first.card(), first.spotted(), first.storage.get(TOUR_KEY)]).toEqual([null, [], "1"]);
    const again = await load({ storage: Object.fromEntries(first.storage) });
    expect(again.card()).toBeNull();
  });

  it("Skip and Esc dismiss it for good too", async () => {
    const a = await load();
    a.click(a.button("Skip"));
    expect([a.card(), a.storage.get(TOUR_KEY)]).toEqual([null, "1"]);
    const b = await load();
    b.click(b.button("Next"));
    b.key("Escape");
    expect([b.card(), b.spotted(), b.storage.get(TOUR_KEY)]).toEqual([null, [], "1"]);
  });

  it("Esc with the tour closed still does what it did before (closes the drawer)", async () => {
    const p = await load({ storage: { [TOUR_KEY]: "1" }, narrow: true });
    p.shell.openDrawer();
    p.key("Escape");
    expect(p.shell.shellStore.get().drawer).toBe(false);
  });

  it("a held Esc that closes the tour does not go on to the chat's Esc (Stop the reply); a new press does (#1369 review)", async () => {
    const p = await load();
    // The chat's own Esc handler, as ChatView registers it: it is reached through the shell only.
    const reached: string[] = [];
    p.shell.onPanelKey((e: { key: string }) => { reached.push(e.key); });
    p.key("Escape");                                    // closes the tour: the press is spent
    expect([p.card(), reached]).toEqual([null, []]);
    p.doc.body.focus();
    p.key("Escape", true); p.key("Escape", true);       // the same key, held
    expect(reached).toEqual([]);
    p.key("Escape");                                    // released and pressed again: not a repeat
    expect(reached).toEqual(["Escape"]);
  });

  it("on a phone, Tour from the open drawer closes the drawer first; Esc then closes the tour and focus goes back to ☰ (#1369 review)", async () => {
    const p = await load({ storage: { [TOUR_KEY]: "1" }, narrow: true });
    p.shell.openDrawer();
    (p.doc.getElementById("sbOpen") as any).focus();
    p.tour.startTour();
    expect(p.shell.shellStore.get().drawer).toBe(false);
    expect(p.card()).not.toBeNull();
    expect(p.doc.activeElement?.textContent).toBe("Next");
    p.key("Escape");
    expect([p.card(), p.doc.activeElement?.id]).toEqual([null, "sbOpen"]);
  });

  it("Settings → This device's Tour button does the same: the drawer closes first and the card opens (#1366, #1604)", async () => {
    const p = await load({ storage: { [TOUR_KEY]: "1" }, narrow: true, install: false });
    // The chat's boot() installs the tour; its replay lives in Settings → This device now (#1604), not the sidebar.
    // @ts-expect-error — a JS module of the app, with no types (as app-harness.ts does for preact)
    const panel = await import("../src/ui/panel-chat.js");
    const { appStore } = await import("/assets/app-store.js");
    panel.boot({ stream: { on() {} }, boot: undefined, deps: { fetch: () => new Promise(() => {}) } });
    appStore.set({ ready: true, instances: [] });
    expect(p.shell.shellStore.get().footer, "the chat adds nothing to the sidebar footer any more").toBeUndefined();
    const preact = await import("/assets/preact.module.js");
    // @ts-expect-error — a JS module of the app, with no types
    const settings = await import("../src/ui/panel-settings.js");
    const nav = await import("/assets/app-nav.js");
    nav.startRouter((globalThis as any).window);                      // the app starts its router at load (app.js)
    const host = p.doc.createElement("div"); p.doc.body.append(host);
    preact.render(preact.h(settings.DeviceSection, {}), host);
    await settle();
    const btn = host.querySelector("#tourBtn") as any;
    expect(btn.textContent).toMatch(/Tour/);
    p.shell.openDrawer();
    (p.doc.getElementById("sbOpen") as any).focus();
    // #1608 review: it waits for the CHAT (its Send button), not the shell's #main that every page has.
    const send = p.doc.getElementById("sendBtn") as any;
    send.remove();
    btn.click();
    await settle(); await settle();
    expect(!!p.card(), "not before the chat has drawn").toBe(false);
    p.doc.body.append(send);
    await new Promise(r => setTimeout(r, 150)); await settle();
    expect(p.shell.shellStore.get().drawer).toBe(false);
    expect(p.text()).toMatch(/Pick an instance/);
    expect(p.doc.activeElement?.textContent).toBe("Next");
    expect((globalThis as any).location.pathname, "replayed on the chat it points at").toBe("/ui");
    // Ended: the focus goes back to the composer — a place that is still there (not Settings' gone button).
    p.click(p.button("Skip"));
    expect(p.doc.activeElement?.id).toBe("msgIn");
  });

  it("on a phone it outlines what is on screen: ☰ for the instance list, the tab's badge for 'needs you' (#1408 step 5)", async () => {
    const p = await load({ narrow: true });
    expect(p.spotted()).toEqual(["sbOpen"]);
    for (let i = 0; i < 4; i++) p.click(p.button("Next"));          // step 5
    expect(p.spotted()).toEqual(["sbOpen"]);
    const tabs = p.doc.createElement("nav"); tabs.className = "tabs";
    const badge = p.doc.createElement("span"); badge.id = "tab-badge-1"; badge.className = "tab-badge";
    tabs.append(badge); p.doc.body.append(tabs);
    p.tour.refreshTourSpot();
    expect(p.spotted()).toEqual(["tab-badge-1"]);
  });

  it("on a desktop the same steps outline the instance list", async () => {
    const p = await load();
    expect(p.spotted()).toEqual(["instanceList"]);
  });

  it("Esc closes an open drawer before the tour (the drawer is on top of the card)", async () => {
    const p = await load({ narrow: true });
    p.shell.openDrawer();
    p.key("Escape");
    expect([p.shell.shellStore.get().drawer, p.card() !== null]).toEqual([false, true]);
    p.key("Escape");
    expect(p.card()).toBeNull();
  });

  it("the outline follows a redraw on the same step: a new needs-you badge, Send swapped for Stop — same card, same focus (#1369 review)", async () => {
    const p = await load();
    for (let i = 0; i < 4; i++) p.click(p.button("Next"));          // step 5: the badge, or the instance list
    expect(p.spotted()).toEqual(["instanceList"]);
    const card = p.card(), focused = p.doc.activeElement;
    // A status update redraws the list: a badge appears as a new element.
    const badge = p.doc.createElement("span"); badge.id = "badge-1"; badge.className = "badge-await";
    p.doc.getElementById("instanceList")!.append(badge);
    p.tour.refreshTourSpot();
    expect(p.spotted()).toEqual(["badge-1"]);
    const badge2 = p.doc.createElement("span"); badge2.id = "badge-2"; badge2.className = "badge-await";
    badge.remove(); p.doc.getElementById("instanceList")!.append(badge2);
    p.tour.refreshTourSpot();
    expect(p.spotted()).toEqual(["badge-2"]);
    expect(p.card()).toBe(card);
    expect(p.doc.activeElement).toBe(focused);

    p.click(p.button("Back"));                                       // step 4: Send, or Stop when it shows
    expect(p.spotted()).toEqual(["sendBtn"]);
    const card4 = p.card(), focused4 = p.doc.activeElement;          // a redraw on this step keeps both
    (p.doc.getElementById("stopBtn") as any).hidden = false;          // a busy agent shows Stop, Send goes
    (p.doc.getElementById("sendBtn") as any).hidden = true;
    p.tour.refreshTourSpot();
    expect(p.spotted()).toEqual(["stopBtn"]);
    expect(p.card()).toBe(card4);
    expect(p.doc.activeElement).toBe(focused4);
  });

  it("Tour replays it after it was dismissed", async () => {
    const p = await load({ storage: { [TOUR_KEY]: "1" } });
    expect(p.card()).toBeNull();
    p.tour.startTour();
    expect(p.text()).toMatch(/Pick an instance/);
  });

  it("when this browser's storage cannot be read, it is not shown at all (never on every load)", async () => {
    const p = await load({ blockTourKey: true });
    expect(p.card()).toBeNull();
    expect(p.tour.tourDone()).toBe(true);
  });

  it("speaks zh-TW where the dashboard does", async () => {
    const p = await load({ lang: "zh-TW" });
    expect(p.text()).toMatch(/選一個 instance/);
    expect(p.buttons().map(b => b.textContent)).toEqual(["略過", "下一步"]);
  });

  it("is styled by classes in the app's stylesheet: no style attribute, no inline style (#1300)", async () => {
    // Nothing in the tour's code reaches a style property or attribute, and nothing it builds carries one.
    const code = TOUR_SRC.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    expect(code).not.toMatch(/\.style\b|\bstyle\s*=|["']style["']/);
    expect(PANEL_SRC).not.toMatch(/id="tourBtn"[^>]*\sstyle\b/);
    const p = await load();
    for (let i = 0; i < 4; i++) p.click(p.button("Next"));
    p.click(p.button("Got it"));
    const css = readFileSync(join(UI, "shared", "app.css"), "utf8");
    for (const cls of [".tour {", ".tour-spot {", ".tour .tour-foot"]) expect(css).toContain(cls);
    const built = await load();
    for (const el of [built.card(), ...(built.doc.querySelectorAll(".tour-spot") as any[])] as any[]) {
      expect(el.hasAttribute("style")).toBe(false);
    }
  });
});
