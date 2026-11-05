/**
 * Claude history in the View (leader cid-claude-history-build; the user, hmsg-a8947a2c / hmsg-b4c7ccdf), the page:
 * - the look is sampled from the live screen (a real Claude Code 2.1.318 pane: ❯ on its band, ● bullets, ⎿ results,
 *   its diff colours); another look on screen is followed; none: 2.1.318's own; a glyph the fonts lack falls back;
 * - only steps before the live screen are history (prompts and replies found on the screen are on it);
 * - in the View: scrolling up on a Claude agent reads its transcript once, draws the history above the screen as it is
 *   with the divider, reading; long output folds and opens whole on a click; older pages come near the top; about 1000
 *   steps at most, then the cap note; Jump to latest follows again; nothing before the screen: said, still following;
 * - en and zh-TW words. (An older server without it: view-scrollback-ui-m2267.test.ts.)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const SCREEN = readFileSync(new URL("./fixtures/view-history-claude-2.1.318.ansi", import.meta.url), "utf8");
const ROSTER = [{ instance_name: "alpha", display_name: "Alpha", status: "running", backend: "claude-code", tags: [], has_avatar: false }];
const lines = (n: number, w = "test") => Array.from({ length: n }, (_, i) => `${w} ${i + 1} passed`).join("\n");
/** Older turns, then the turn the live screen shows (its prompt and replies are on SCREEN). */
function steps(older: number, prefix = "q") {
  const out: any[] = [];
  for (let i = 1; i <= older; i++) out.push({ id: `${prefix}u${i}`, kind: "user", body: `question ${prefix}${i}` }, { id: `${prefix}a${i}`, kind: "assistant", body: `answer ${prefix}${i}` });
  return out;
}
const ON_SCREEN = [
  { id: "now-u", kind: "user", body: "The forecast command crashes when the city has a space in it. VHFIX please." },
  { id: "now-a", kind: "assistant", body: "I'll check how the city argument reaches the weather API." },
  { id: "now-t", kind: "tool", tool: "Bash", subject: "seq", status: "done", body: lines(3), more: 17 },
  { id: "now-z", kind: "assistant", body: "**Fixed**: the city is now URL-encoded, so \"New York\" no longer breaks the query string. All 20 forecast tests pass." },
];
let pages: Record<string, any> = {}, stepAnswers: Record<string, any> = {}, transcriptStatus = 200;
const reads: string[] = [];
let p: AppPage, view: any, i18n: any, vh: any;
const g = globalThis as any;
const jsonRes = (body: unknown, status = 200) => ({ ok: status === 200, status, headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) }, json: async () => body, text: async () => JSON.stringify(body) });

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/view/alpha", storage: { agend_tour_done: "1", agend_lang: "en" } });
  g.fetch = async (u: string) => {
    if (u === "/api/profiles") return { ok: true, status: 200, json: async () => ROSTER };
    if (u.startsWith("/api/pane/")) {
      reads.push(u);
      if (u.includes("?transcript=1")) {
        if (transcriptStatus !== 200) return jsonRes({ error: "x" }, transcriptStatus);
        const step = /[?&]step=([^&]+)/.exec(u);
        if (step) return jsonRes(stepAnswers[decodeURIComponent(step[1]!)] ?? { view_history: 1, supported: true, key: "1-1", step: null });
        const before = /[?&]before=(\d+)/.exec(u);
        return jsonRes(pages[before ? before[1]! : "newest"]);
      }
      const headers: Record<string, string> = { "X-Pane-Cols": "120", "X-Pane-Rows": "40" };
      return { ok: true, status: 200, headers: { get: (k: string) => headers[k] ?? null }, text: async () => SCREEN };
    }
    if (u.startsWith("/api/ai-usage")) return { ok: true, status: 200, json: async () => ({ providers: [], fetchedAt: Date.now() }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  g.getComputedStyle = () => ({ paddingLeft: "6px", paddingRight: "6px", paddingTop: "5px", paddingBottom: "5px", fontFamily: "monospace", fontSize: "1px", lineHeight: "1.2" });
  i18n = await import("/assets/app-i18n.js");
  view = await import("/assets/panel-view.js");
  vh = await import("/assets/view-history.js");
});
afterAll(async () => { await p.unmount(); p.restore(); for (const k of ["fetch", "getComputedStyle"]) delete g[k]; });
afterEach(async () => {
  await p.unmount();
  pages = {}; stepAnswers = {}; transcriptStatus = 200; reads.length = 0; i18n.setLang("en", { store: false });
});

const mount = async () => { await p.mount(h(view.ViewPanel, { route: { panel: "view", instance: "alpha" }, navKey: "view:alpha|1|en" })); await settle(10); };
const term = () => p.root.querySelector(".v-term")!;
const pre = () => p.root.querySelector(".v-pre")!;
const until = async (fn: () => unknown) => { for (let i = 0; i < 200 && !fn(); i++) await settle(5); };
const transcriptReads = () => reads.filter(u => u.includes("?transcript=1"));
const rgb = (n: number) => { n -= 16; const v = (x: number) => (x ? x * 40 + 55 : 0); return `rgb(${v(Math.floor(n / 36))},${v(Math.floor((n % 36) / 6))},${v(n % 6)})`; };
const grey = (n: number) => { const l = (n - 232) * 10 + 8; return `rgb(${l},${l},${l})`; };

describe("the look, sampled from the live screen", () => {
  it("a real Claude Code 2.1.318 pane: ❯ on its band, ● (white reply, green tool), ⎿, the diff's red and green", () => {
    const pal = vh.samplePalette(SCREEN);
    expect(pal).toMatchObject({
      promptGlyph: "❯", promptBand: grey(237), promptFg: grey(246), promptText: rgb(231),
      bullet: "●", replyFg: rgb(231), toolFg: rgb(114), resultGlyph: "⎿", resultFg: grey(246),
      delFg: rgb(167), delBg: rgb(52), addFg: rgb(77), addBg: rgb(22),
    });
    // Each read off the screen itself (these defaults are 2.1.318's own, so equal values alone would prove nothing).
    expect(vh.sampleScreen(SCREEN).found.sort()).toEqual(["addBg", "addFg", "bullet", "delBg", "delFg", "promptBand", "promptFg", "promptGlyph", "promptText", "replyFg", "resultFg", "resultGlyph", "toolFg"]);
  });
  it("another look on screen is followed (an older Claude: ⏺, > on a lighter band, other colours); none: 2.1.318's", () => {
    const E = "\u001b[";
    const older = [
      `${E}38;5;250m${E}48;5;236m> ${E}38;5;255mfix it${E}0m`,
      `${E}38;5;2m⏺${E}39m ${E}1mBash${E}0m(ls)`,
      `  ${E}38;5;244m└  ${E}0mfile`,
      `${E}38;5;15m⏺${E}39m done`,
      `   ${E}38;5;203m${E}48;5;88m 3 -${E}0m old`,
      `   ${E}38;5;120m${E}48;5;28m 3 +${E}0m new`,
    ].join("\n");
    expect(vh.samplePalette(older)).toMatchObject({
      promptGlyph: ">", promptBand: grey(236), promptFg: grey(250), promptText: grey(255),
      bullet: "⏺", toolFg: "#0dbc79", replyFg: "#ffffff", resultGlyph: "└", resultFg: grey(244),
      delFg: rgb(203), delBg: rgb(88), addFg: rgb(120), addBg: rgb(28),
    });
    expect(vh.samplePalette("")).toEqual(vh.DEFAULT_PALETTE);
    // The composer's bare glyph alone is enough for the glyph (no band there to sample).
    expect(vh.samplePalette("──\n❯ \n──")).toMatchObject({ promptGlyph: "❯", promptBand: vh.DEFAULT_PALETTE.promptBand });
  });
  it("a glyph the page's fonts lack falls back (⏺ → ●, ⎿ → └, ❯ → >); one they have is kept", () => {
    // A canvas that draws nothing for the glyphs a font lacks — exactly as it draws a code point no font has.
    const fakeDoc = (missing: string) => ({ createElement: () => ({ width: 0, height: 0, getContext: () => {
      let drawn = "";
      return { clearRect() {}, fillText(c: string) { drawn = c; }, getImageData: () => ({ data: Uint8ClampedArray.from({ length: 40 * 40 * 4 }, (_, i) => (i % 4 === 3 && !missing.includes(drawn) && drawn !== "\u{10FFFD}" ? 255 : 0)) }), set font(_v: string) {}, set fillStyle(_v: string) {}, set textBaseline(_v: string) {} };
    } }) });
    expect(["⏺", "⎿", "❯"].map(c => vh.drawable(c, "testfont-a", fakeDoc("⏺⎿❯")))).toEqual(["●", "└", ">"]);
    expect(["⏺", "⎿", "❯"].map(c => vh.drawable(c, "testfont-b", fakeDoc("")))).toEqual(["⏺", "⎿", "❯"]);
    expect(vh.hasGlyph("⏺", "testfont-c", null)).toBe(true);                  // no canvas: assumed drawn
  });
});

describe("only steps before the live screen", () => {
  it("prompts and replies found on the screen (markdown and wraps aside) are on it; the first one not found, and older, is history", () => {
    const all = [...steps(3), ...ON_SCREEN];
    expect(vh.beforeScreen(all, SCREEN).map((s: any) => s.id)).toEqual(steps(3).map(s => s.id));
    // Nothing of it on the screen (a long output fills it): all of it is history — a step may come twice, never none.
    expect(vh.beforeScreen(all, "just output\n").length).toBe(all.length);
    // A reply not found stops the walk, even if an older one with the same words is.
    const same = [{ id: "a", kind: "assistant", body: "continue please" }, { id: "b", kind: "assistant", body: "something else" }];
    expect(vh.beforeScreen(same, "● continue please").map((s: any) => s.id)).toEqual(["a", "b"]);
  });
});

describe("in the View", () => {
  const scroll = async () => { fire(term(), "wheel", { deltaY: -120 }); await until(() => term().className.includes("is-reading") || p.root.querySelector(".v-term-history-note")); };
  it("a Claude agent offers Earlier output (no Log bar); scrolling up draws its history above the screen, with the divider; reading", async () => {
    pages.newest = { view_history: 1, supported: true, key: "1-1", before: null, end: 900, steps: [...steps(2), ...ON_SCREEN] };
    await mount();
    expect([!!p.root.querySelector("button.v-term-earlier"), p.root.querySelector("a.v-term-log")]).toEqual([true, null]);
    await scroll();
    expect(transcriptReads()).toEqual(["/api/pane/alpha?transcript=1"]);
    const hist = pre().querySelector(".vh")!;
    expect([...hist.querySelectorAll(".vh-step")].map((s: any) => s.dataset.step)).toEqual(["qu1", "qa1", "qu2", "qa2"]);
    expect(pre().querySelector(".vh-divider")!.textContent).toBe("History above");
    // The screen as it was, right after the history (the history is a block of its own before it).
    expect(pre().childNodes[0]).toBe(hist);
    expect(pre().textContent!.slice(hist.textContent!.length)).toContain("Cogitated for 0s");
    expect(term().className).toContain("is-reading");
    // The sampled look: the prompt's band and glyph, the reply's bullet.
    const prompt = hist.querySelector(".vh-prompt") as any;
    expect([prompt.style.background, prompt.textContent]).toEqual([grey(237), "❯ question q1"]);
    expect((hist.querySelectorAll(".vh-step")[1] as any).textContent).toBe("● answer q1");
  });
  it("a tool's long output folds; a click opens it whole; a failed read says so and can be tried again", async () => {
    pages.newest = { view_history: 1, supported: true, key: "1-1", before: null, end: 900, steps: [{ id: "t9", kind: "tool", tool: "Edit", subject: "/w/a.ts", status: "done", diff: [{ del: ["old"], add: ["new"] }] }, { id: "t8", kind: "tool", tool: "Bash", subject: "seq 20", status: "done", body: lines(3), more: 17 }, ...ON_SCREEN] };
    await mount(); await scroll();
    const edit = pre().querySelector('[data-step="t9"]')!;
    expect([...edit.querySelectorAll(".vh-diff")].map((d: any) => [d.textContent, d.style.background, d.style.color])).toEqual([["- old", rgb(52), rgb(167)], ["+ new", rgb(22), rgb(77)]]);
    expect(edit.querySelector(".vh-b")!.textContent).toBe("Update");
    const more = () => pre().querySelector('[data-step="t8"] .vh-more') as any;
    expect(more().textContent).toBe("… +17 lines (click to expand)");
    transcriptStatus = 503;
    more().click(); await until(() => pre().querySelector(".vh-more-failed"));
    expect(pre().querySelector(".vh-more-failed")!.textContent).toContain("Could not load the full text.");
    transcriptStatus = 200;
    stepAnswers.t8 = { view_history: 1, supported: true, key: "1-1", step: { id: "t8", kind: "tool", tool: "Bash", subject: "seq 20", status: "done", body: lines(20), cut: 120 } };
    more().click(); await until(() => !more());
    const whole = pre().querySelector('[data-step="t8"]')!;
    expect(transcriptReads().at(-1)).toBe("/api/pane/alpha?transcript=1&step=t8&end=900&key=1-1");
    expect([whole.querySelectorAll(".vh-res").length, whole.textContent!.includes("test 20 passed"), whole.textContent!.includes("… 120 more characters not shown")]).toEqual([21, true, true]);
  });
  it("near the top, the page before comes above what is shown", async () => {
    pages.newest = { view_history: 1, supported: true, key: "1-1", before: 500, end: 900, steps: [...steps(2), ...ON_SCREEN] };
    pages["500"] = { view_history: 1, supported: true, key: "1-1", before: null, end: 500, steps: steps(1, "old") };
    await mount(); await scroll();
    // As a browser lays it out: taller than its box, the person near its top.
    const t = term() as any; t.scrollHeight = 2000; t.clientHeight = 200; t.scrollTop = 10;
    fire(term(), "scroll"); await until(() => pre().querySelector('[data-step="oldu1"]'));
    expect(transcriptReads().at(-1)).toBe("/api/pane/alpha?transcript=1&before=500&key=1-1");
    expect([...pre().querySelectorAll(".vh-step")].map((s: any) => s.dataset.step)).toEqual(["oldu1", "olda1", "qu1", "qa1", "qu2", "qa2"]);
    // Nothing older now: no further read.
    fire(term(), "scroll"); await settle(10);
    expect(transcriptReads().length).toBe(2);
  });
  it("Jump to latest follows again: the history goes, the newest screen is drawn", async () => {
    pages.newest = { view_history: 1, supported: true, key: "1-1", before: null, end: 900, steps: [...steps(1), ...ON_SCREEN] };
    await mount(); await scroll();
    (p.root.querySelector(".v-term-latest") as any).click(); await settle(10);
    expect([pre().querySelector(".vh"), term().className.includes("is-reading"), pre().textContent!.includes("Cogitated")]).toEqual([null, false, true]);
  });
  it("nothing before the screen: said briefly, still following; the next scroll asks again", async () => {
    pages.newest = { view_history: 1, supported: true, key: "1-1", before: null, end: 900, steps: ON_SCREEN };
    await mount(); await scroll();
    expect([p.root.querySelector(".v-term-history-note")!.textContent, term().className.includes("is-reading"), pre().querySelector(".vh")]).toEqual(["Nothing has scrolled off the screen yet.", false, null]);
  });
  it("everything in the newest page is on the screen: the page before it is the history", async () => {
    pages.newest = { view_history: 1, supported: true, key: "1-1", before: 300, end: 900, steps: ON_SCREEN };
    pages["300"] = { view_history: 1, supported: true, key: "1-1", before: null, end: 300, steps: steps(1) };
    await mount(); await scroll();
    expect([...pre().querySelectorAll(".vh-step")].map((s: any) => s.dataset.step)).toEqual(["qu1", "qa1"]);
  });
  it("no transcript yet (a fresh session): nothing earlier — still offered and asked again; no history at all: as a CLI without", async () => {
    pages.newest = { view_history: 1, supported: false, reason: "no_transcript" };
    await mount(); await scroll();
    expect([p.root.querySelector(".v-term-history-note")!.textContent, !!p.root.querySelector("button.v-term-earlier"), p.root.querySelector("a.v-term-log")])
      .toEqual(["Nothing has scrolled off the screen yet.", true, null]);
    pages.newest = { view_history: 1, supported: true, key: "1-1", before: null, end: 900, steps: [...steps(1), ...ON_SCREEN] };
    fire(term(), "wheel", { deltaY: -120 }); await until(() => pre().querySelector(".vh-step"));
    expect(pre().querySelectorAll(".vh-step").length).toBe(2);
    await p.unmount();
    pages.newest = { view_history: 1, supported: false, reason: "unsupported" };
    await mount(); await scroll();
    expect([p.root.querySelector(".v-term-history-note")!.textContent!.includes("redraws"), p.root.querySelector("button.v-term-earlier")]).toEqual([true, null]);
  });
  it("a failed read says so and stays following", async () => {
    transcriptStatus = 503;
    await mount(); await scroll();
    expect([p.root.querySelector(".v-term-history-note")!.textContent, term().className.includes("is-reading")]).toEqual(["Could not load earlier output.", false]);
  });
  it("zh-TW: the divider and the fold", async () => {
    i18n.setLang("zh-TW", { store: false });
    pages.newest = { view_history: 1, supported: true, key: "1-1", before: null, end: 900, steps: [{ id: "t8", kind: "tool", tool: "Bash", subject: "seq 20", status: "done", body: lines(3), more: 17 }, ...ON_SCREEN] };
    await mount(); await scroll();
    expect([pre().querySelector(".vh-divider")!.textContent, pre().querySelector(".vh-more")!.textContent]).toEqual(["以上是對話紀錄", "… 還有 17 行（點一下展開）"]);
  });
});

describe("about 1000 steps at most", () => {
  it("pages stop at the cap, and the note says so (en, zh-TW)", async () => {
    let n = 0;
    const fetch = async (u: string) => {
      const before = /before=(\d+)/.exec(u);
      const at = before ? Number(before[1]) : 100_000;
      n++;
      return jsonRes({ view_history: 1, supported: true, key: "1-1", before: at - 100, end: at, steps: steps(50, `p${at}-`) });
    };
    const hist = vh.createHistory({ name: "alpha", fetch, doc: p.document });
    expect((await hist.first("")).kind).toBe("ok");
    const kinds: string[] = [];
    for (let i = 0; i < 12; i++) kinds.push((await hist.older()).kind);
    expect(kinds.slice(0, 9)).toEqual(Array(9).fill("ok"));
    expect(kinds.slice(9)).toEqual(["capped", "capped", "capped"]);
    expect([n, hist.root.querySelectorAll(".vh-step").length, hist.hasOlder()]).toEqual([10, vh.HISTORY_STEP_CAP, false]);
    expect(hist.root.querySelector(".vh-cap")!.textContent).toBe("Only the latest 1000 steps are shown here.");
    i18n.setLang("zh-TW", { store: false });
    const zh = vh.createHistory({ name: "alpha", fetch, doc: p.document });
    await zh.first(""); for (let i = 0; i < 10; i++) await zh.older();
    expect(zh.root.querySelector(".vh-cap")!.textContent).toBe("這裡只顯示最近 1000 則紀錄。");
  });
  it("an older server (the pane's text, not JSON) is no history: unsupported", async () => {
    const hist = vh.createHistory({ name: "alpha", fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/plain; charset=utf-8" }, text: async () => "screen" }), doc: p.document });
    expect(await hist.first("")).toEqual({ kind: "unsupported" });
  });
});
