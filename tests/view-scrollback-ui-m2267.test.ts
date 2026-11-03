/**
 * M-2267 (the user, hmsg-435f6df6): the View's terminal scrolls back, and live updates never yank the reader down.
 * The panel in the fake DOM with a fake pane (the layout numbers a browser would give are set by hand):
 *  - following, it reads the screen only (never the history on its 800 ms refresh) and offers "Earlier output";
 *  - the wheel up, a touch drag down, PageUp/↑/Home or the button read the scrollback ONCE and show it: reading;
 *  - reading, the refresh never redraws: new output only says "New output below"; Jump to latest, End, or scrolling to
 *    the bottom follows again (with the newest screen);
 *  - a CLI that keeps no scrollback (full screen) says so and stays following; a refused or failed read says so (a
 *    guest over its limit: silently) and stays following;
 *  - en and zh-TW words.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const ROSTER = [{ instance_name: "alpha", display_name: "Alpha", status: "running", backend: "codex", tags: [], has_avatar: false }];
let screen = "SCREEN 1", historyText = "old 1\nold 2\nold 3\nSCREEN 1", historyHeaders: Record<string, string> = { "X-Pane-Alternate": "0", "X-Pane-History-Lines": "3" };
let historyStatus = 200;
const reads: string[] = [];
let p: AppPage, view: any, i18n: any;
const g = globalThis as any;

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/view/alpha", storage: { agend_tour_done: "1", agend_lang: "en" } });
  g.fetch = async (u: string) => {
    if (u === "/api/profiles") return { ok: true, status: 200, json: async () => ROSTER };
    if (u.startsWith("/api/pane/")) {
      reads.push(u);
      const history = u.endsWith("?history=1");
      const headers: Record<string, string> = { "X-Pane-Cols": "80", "X-Pane-Rows": "1", ...(history ? historyHeaders : {}) };
      const status = history ? historyStatus : 200;
      return { ok: status === 200, status, headers: { get: (k: string) => headers[k] ?? null }, text: async () => (history ? historyText : screen) };
    }
    if (u.startsWith("/api/ai-usage")) return { ok: true, status: 200, json: async () => ({ providers: [], fetchedAt: Date.now() }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  g.getComputedStyle = () => ({ paddingLeft: "6px", paddingRight: "6px", paddingTop: "5px", paddingBottom: "5px", fontFamily: "monospace", fontSize: "1px", lineHeight: "1.2" });
  i18n = await import("/assets/app-i18n.js");
  view = await import("/assets/panel-view.js");
});
afterAll(async () => { await p.unmount(); p.restore(); for (const k of ["fetch", "getComputedStyle"]) delete g[k]; });
afterEach(async () => {
  await p.unmount();
  screen = "SCREEN 1"; historyText = "old 1\nold 2\nold 3\nSCREEN 1"; historyHeaders = { "X-Pane-Alternate": "0", "X-Pane-History-Lines": "3" }; historyStatus = 200;
  reads.length = 0; i18n.setLang("en", { store: false });
});

const mount = async () => { await p.mount(h(view.ViewPanel, { route: { panel: "view", instance: "alpha" }, navKey: "view:alpha|1|en" })); await settle(10); };
const term = () => p.root.querySelector(".v-term")!;
const pre = () => p.root.querySelector(".v-pre")!;
const button = (cls: string) => p.root.querySelector(cls);
const tick = (ms = 900) => new Promise(r => setTimeout(r, ms));
const historyReads = () => reads.filter(u => u.endsWith("?history=1")).length;
/** As a browser lays it out: the snapshot taller than the box. */
const layout = (scrollHeight: number, clientHeight = 200) => { const t = term(); t.scrollHeight = scrollHeight; t.clientHeight = clientHeight; (pre() as any).scrollHeight = scrollHeight; };

describe("following", () => {
  it("reads the screen only, every refresh — never the history — and offers Earlier output", async () => {
    await mount();
    await tick(1700);
    expect(pre().textContent).toBe("SCREEN 1");
    expect([reads.length >= 2, historyReads()]).toEqual([true, 0]);
    expect(button(".v-term-earlier")!.textContent).toContain("Earlier output");
    expect(button(".v-term-latest")).toBeNull();
  });
});

describe("scrolling up reads the scrollback once, and nothing yanks the reader", () => {
  for (const [how, act] of [
    ["the wheel up", () => fire(term(), "wheel", { deltaY: -120 })],
    ["a touch drag down", () => { fire(term(), "touchstart", { touches: [{ clientY: 100 }] }); fire(term(), "touchmove", { touches: [{ clientY: 160 }] }); }],
    ["PageUp", () => fire(term(), "keydown", { key: "PageUp" })],
    ["the Earlier output button", () => (button(".v-term-earlier") as any).click()],
  ] as const) {
    it(`${how}: the scrollback is shown, reading; Earlier output gives way to Jump to latest`, async () => {
      await mount();
      act();
      await settle(10);
      expect(historyReads()).toBe(1);
      expect(pre().textContent).toBe("old 1\nold 2\nold 3\nSCREEN 1");
      expect(term().className).toContain("is-reading");
      expect([button(".v-term-earlier"), !!button(".v-term-latest")]).toEqual([null, true]);
    });
  }
  it("the wheel down, or a wheel up while not at the top, reads nothing", async () => {
    await mount();
    fire(term(), "wheel", { deltaY: 120 });
    term().scrollTop = 40; fire(term(), "wheel", { deltaY: -120 });
    await settle(10);
    expect(historyReads()).toBe(0);
  });
  it("reading: new output never redraws under the reader — it says so; Jump to latest follows with the newest screen", async () => {
    await mount();
    layout(1000);
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    const at = term().scrollTop;
    expect(at).toBeGreaterThan(0);                                              // where they were: near the bottom, a little up
    screen = "SCREEN 2";
    await tick();
    expect(pre().textContent).toBe("old 1\nold 2\nold 3\nSCREEN 1");           // not yanked: the same text…
    expect(term().scrollTop).toBe(at);                                          // …at the same place
    expect(button(".v-term-latest")!.textContent).toContain("New output below");
    expect(historyReads()).toBe(1);                                             // the refresh read the screen only
    (button(".v-term-latest") as any).click();
    expect(pre().textContent).toBe("SCREEN 2");                                 // the newest screen at once, not after a read
    await settle(10);
    expect([pre().textContent, term().className.includes("is-reading"), !!button(".v-term-earlier")]).toEqual(["SCREEN 2", false, true]);
  });
  it("scrolling to the bottom follows again; End too", async () => {
    await mount();
    layout(1000);
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    term().scrollTop = 800; fire(term(), "scroll"); await settle(5);          // 1000 − 800 − 200 = 0: at the bottom
    expect(term().className).not.toContain("is-reading");
    layout(200); term().scrollTop = 0;                                          // following: the screen alone fits the box
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    expect(term().className).toContain("is-reading");
    fire(term(), "keydown", { key: "End" }); await settle(5);
    expect(term().className).not.toContain("is-reading");
    expect(historyReads()).toBe(2);                                             // every visit up reads afresh
  });
  it("no new output while reading: Jump to latest without the new-output words", async () => {
    await mount();
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    await tick();
    expect(button(".v-term-latest")!.textContent).not.toContain("New output below");
  });
});

describe("when there is nothing to read", () => {
  it("a full-screen CLI keeps no scrollback: said (briefly), still following, Earlier output no longer offered nor read again", async () => {
    historyHeaders = { "X-Pane-Alternate": "1", "X-Pane-History-Lines": "0" };
    await mount();
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    expect(p.root.querySelector(".v-term-history-note")!.textContent).toContain("redraws its whole screen");
    expect([pre().textContent, term().className.includes("is-reading"), button(".v-term-earlier")]).toEqual(["SCREEN 1", false, null]);
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    expect(historyReads()).toBe(1);                                             // known now: not read again
    expect(p.root.querySelector(".v-term-history-note")!.textContent).toContain("redraws its whole screen");
    await tick(6200);
    expect(p.root.querySelector(".v-term-history-note")).toBeNull();            // gone after a few seconds
  }, 15_000);
  it("a CLI that redraws in place (Grok: no history outside the alternate screen) says the same", async () => {
    historyHeaders = { "X-Pane-Alternate": "0", "X-Pane-History-Lines": "0" };
    ROSTER[0]!.backend = "grok";
    try {
      await mount();
      fire(term(), "keydown", { key: "Home" }); await settle(10);
      expect(p.root.querySelector(".v-term-history-note")!.textContent).toContain("redraws its whole screen");
    } finally { ROSTER[0]!.backend = "codex"; }
  });
  it("any other CLI with an empty history has simply not scrolled yet: said so — not that it never keeps any", async () => {
    historyHeaders = { "X-Pane-Alternate": "0", "X-Pane-History-Lines": "0" };
    await mount();
    fire(term(), "keydown", { key: "Home" }); await settle(10);
    expect(p.root.querySelector(".v-term-history-note")!.textContent).toBe("Nothing has scrolled off the screen yet.");
  });
  it("a failed read says so; a guest over its read limit (429) silently stays following", async () => {
    historyStatus = 500;
    await mount();
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    expect(p.root.querySelector(".v-term-history-note")!.textContent).toBe("Could not load earlier output.");
    await p.unmount();
    historyStatus = 429;
    await mount();
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    expect([p.root.querySelector(".v-term-history-note"), term().className.includes("is-reading"), pre().textContent]).toEqual([null, false, "SCREEN 1"]);
  });
});

describe("a full-screen CLI's earlier output: the Log tab (option 2, the leader's safe default)", () => {
  const as = async (backend: string, opts: { logTab?: boolean; viewOnly?: boolean } = {}) => {
    ROSTER[0]!.backend = backend;
    p.document.body.setAttribute("data-log-tab", opts.logTab === false ? "0" : "1");
    const { appStore } = await import("/assets/app-store.js") as any;
    appStore.set({ viewOnly: !!opts.viewOnly });
    await mount();
  };
  afterEach(async () => { ROSTER[0]!.backend = "codex"; p.document.body.removeAttribute("data-log-tab"); const { appStore } = await import("/assets/app-store.js") as any; appStore.set({ viewOnly: false }); });
  it("Claude Code, signed in, the Log tab on: the top control is the link to its Log; nothing is read, nothing offered", async () => {
    await as("claude-code");
    const link = p.root.querySelector("a.v-term-log")!;
    expect([link.textContent, link.getAttribute("href")]).toEqual(["Earlier output is in the Log tab", "/ui/log/alpha"]);
    expect(p.root.querySelector("button.v-term-earlier")).toBeNull();
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    expect(historyReads()).toBe(0);                                             // known full screen: no read at all
    expect(p.root.querySelector(".v-term-history-note")!.textContent).toContain("redraws its whole screen");
  });
  it("the Log tab off: says so, and links to where it is turned on (Settings → Web dashboard)", async () => {
    await as("claude-code", { logTab: false });
    const link = p.root.querySelector("a.v-term-log")!;
    expect([link.textContent, link.getAttribute("href")]).toEqual(["Earlier output: the Log tab is off. Turn it on in Settings", "/settings/web-dashboard"]);
  });
  it("a reader who cannot open the Log (View-only) gets the plain words only, no link", async () => {
    await as("claude-code", { viewOnly: true });
    expect([p.root.querySelector("a.v-term-log"), p.root.querySelector("button.v-term-earlier")]).toEqual([null, null]);
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    expect(p.root.querySelector(".v-term-history-note")!.textContent).toContain("redraws its whole screen");
  });
  it("a full-screen CLI the Log does not read (Grok, OpenCode): no link — the Log would not have it either", async () => {
    for (const backend of ["grok", "opencode"]) {
      await as(backend);
      expect([p.root.querySelector("a.v-term-log"), p.root.querySelector("button.v-term-earlier")], backend).toEqual([null, null]);
      await p.unmount();
    }
  });
  it("a CLI that keeps scrollback (Codex) is unchanged: Earlier output, no Log link", async () => {
    await as("codex");
    expect([!!p.root.querySelector("button.v-term-earlier"), p.root.querySelector("a.v-term-log")]).toEqual([true, null]);
  });
  it("zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false });
    await as("claude-code");
    expect(p.root.querySelector("a.v-term-log")!.textContent).toBe("較早的輸出在「紀錄」分頁");
  });
});

describe("words", () => {
  it("zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect(button(".v-term-earlier")!.textContent).toContain("較早的輸出");
    fire(term(), "wheel", { deltaY: -120 }); await settle(10);
    screen = "SCREEN 2"; await tick();
    expect(button(".v-term-latest")!.textContent).toContain("下方有新的輸出");
    expect(button(".v-term-latest")!.textContent).toContain("跳到最新");
  });
});
