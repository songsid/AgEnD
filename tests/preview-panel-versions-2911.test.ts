/**
 * #2911 (1), M-2216: the preview panel's versions (‹ v2 of 3 ›) and Changes (the previous version against this one).
 * Chrome only: the frame, its sandbox and the click to run are #1306/#1481's — a version is shown as Show it shows one,
 * waiting for Preview. The real modules run here in the mini DOM; what a browser draws is the smoke in the PR.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const BOOT = "e".repeat(32);
let PV: any, panel: any, pp: any, pv: any;
const stream: Record<string, (m: unknown) => void> = {};
let current: AppPage | null = null;
const realFetch = globalThis.fetch;

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
  // @ts-expect-error — a JS module of the app, with no types
  pv = await import("../src/ui/preview-versions.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({
    stream: { on(ev: string, fn: (m: unknown) => void) { stream[ev] = fn; } },
    boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" },
    deps: { fetch: () => new Promise(() => {}) },
  });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  await current?.unmount();
  PV.stopAll("test-end");
  pp.closePanel();
  panel.store.state.msgs.w = [];
  current?.restore();
  current = null;
});

const ts = (id: number) => `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`;
const agent = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: ts(id) });
const human = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "web-user", role: "user", text, ts: ts(id) });
const FENCE = (body: string) => "```html\n" + body + "\n```";
const PAGE = (v: number, title = "Counter") => `<title>${title}</title>\n<h1>v${v}</h1>\n<p>same</p>`;
const k = (x: any) => `${x.boot}-${x.id}`;
const withFile = (id: number, fileId: string, name: string) => ({ ...agent(id, "Here it is."), attachments: [{ id: fileId, kind: "document", name, size: 80, mime: "application/octet-stream" }] });
const ID1 = "1".repeat(32), ID2 = "2".repeat(32);

async function chat(msgs: unknown[]) {
  current = page({ storage: { agend_html_preview: "on", agend_tour_done: "1" } });
  panel.store.state.msgs.w = msgs;
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  (current.document.querySelector(".chat-split") as any).clientWidth = 1200;
  return current.document as any;
}
const cards = (doc: any) => [...doc.querySelectorAll(".msg.agent .html-card")] as any[];
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(); };
const at = (doc: any) => doc.querySelector(".pv-ver-at")?.textContent ?? null;
const shown = () => pp.panelStore.get().open?.key ?? null;

describe("versionsOf: which blocks are versions of the shown one", () => {
  it("titled: the agent's complete blocks with the same <title>, oldest first — not another title, a person's, or a cut block", () => {
    const msgs = [agent(1, FENCE(PAGE(1))), human(2, FENCE(PAGE(9))), agent(3, FENCE(PAGE(2, "Other")) + FENCE(PAGE(2))),
      agent(4, "```html\n" + PAGE(3)), agent(5, FENCE(PAGE(4)))];
    const open = { key: "b-3:f1", msgKey: "b-3", instance: "w", code: PAGE(2) };
    const v = pv.versionsOf(open, msgs, k);
    expect([v.list.map((x: any) => x.key), v.index]).toEqual([["b-1:f0", "b-3:f1", "b-5:f0"], 1]);
  });
  it("untitled: the untitled blocks only (a titled block is another page)", () => {
    const msgs = [agent(1, FENCE("<h1>a</h1>")), agent(2, FENCE(PAGE(1))), agent(3, FENCE("<h1>b</h1>"))];
    const v = pv.versionsOf({ key: "b-3:f0", msgKey: "b-3", instance: "w", code: "<h1>b</h1>" }, msgs, k);
    expect([v.list.map((x: any) => x.key), v.index]).toEqual([["b-1:f0", "b-3:f0"], 1]);
  });
  it("attached files: the agent's attachments of the same name (any case), read when picked", () => {
    const msgs = [withFile(1, ID1, "Page.html"), withFile(2, ID2, "other.html"), withFile(3, ID2, "page.HTML")];
    const v = pv.versionsOf({ key: `b-3:a${ID2}`, msgKey: "b-3", instance: "w", att: { id: ID2, name: "page.HTML" }, code: "x" }, msgs, k);
    expect([v.list.map((x: any) => [x.key, x.code]), v.index]).toEqual([[[`b-1:a${ID1}`, null], [`b-3:a${ID2}`, null]], 1]);
  });
  it("the shown block no longer in the thread: just itself, index -1 (no stepper)", () => {
    const open = { key: "b-9:f0", msgKey: "b-9", instance: "w", code: PAGE(1) };
    expect(pv.versionsOf(open, [agent(1, FENCE(PAGE(1)))], k)).toEqual({ list: [open], index: -1 });
  });
  it("preview-panel.js still exports htmlTitle (the feedback buttons read it there)", () => {
    expect(pp.htmlTitle("<title>  A\n b </title>")).toBe("A b");
  });
});

describe("lineDiff / diffHunks", () => {
  it("a minimal line diff, with the common head and tail as context", () => {
    expect(pv.lineDiff("a\nb\nc\n", "a\nx\nc\n")).toEqual([{ t: " ", text: "a" }, { t: "-", text: "b" }, { t: "+", text: "x" }, { t: " ", text: "c" }]);
    expect(pv.lineDiff("", "a")).toEqual([{ t: "+", text: "a" }]);
    expect(pv.lineDiff("a\r\nb", "a\nb")).toEqual([{ t: " ", text: "a" }, { t: " ", text: "b" }]);
  });
  it("bounded: too many edits, or a side over maxChars, is null (not a slow page)", () => {
    const L = { ...pv.DIFF_LIMITS, maxEdits: 5 };
    expect(pv.lineDiff("x\n".repeat(10), "y\n".repeat(10), L)).toBeNull();
    expect(pv.lineDiff("a".repeat(11), "b", { ...pv.DIFF_LIMITS, maxChars: 10 })).toBeNull();
    const big = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const edited = [...big]; edited[10000] = "changed";
    const t0 = performance.now();
    expect(pv.diffHunks(pv.lineDiff(big.join("\n"), edited.join("\n"))).length).toBe(1);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it("#2915 review: many short or blank lines are refused before anything is split or built (the 20k-line edit above still diffs)", () => {
    const blank = "\n".repeat(5_000_000);
    const t0 = performance.now();
    expect(pv.lineDiff(blank, blank)).toBeNull();
    expect(pv.lineDiff("a", "x\n".repeat(pv.DIFF_LIMITS.maxInputLines + 1))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
    const at = "x\n".repeat(pv.DIFF_LIMITS.maxInputLines);
    expect(pv.lineDiff(at, at)?.length, "exactly at the budget: still compared").toBe(pv.DIFF_LIMITS.maxInputLines);
  });
  it("#2915 review r2: the budget counts lines as the diff splits them — CR and CRLF end lines, a last unterminated line counts", () => {
    const max = pv.DIFF_LIMITS.maxInputLines;
    const t0 = performance.now();
    expect(pv.lineDiff("\r".repeat(5_000_000), "\r".repeat(5_000_000)), "5M lone CRs").toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
    expect(pv.lineDiff("a", "\r".repeat(max + 1)), "max + 1 lone CRs").toBeNull();
    expect(pv.lineDiff("a", "x\n".repeat(max) + "x"), "max LFs and an unterminated last line").toBeNull();
    expect(pv.lineDiff("a", "x\r\n".repeat(max + 1)), "max + 1 CRLFs").toBeNull();
    const crlf = "x\r\n".repeat(max);
    expect(pv.lineDiff(crlf, crlf)?.length, "exactly max CRLF lines: compared").toBe(max);
    const last = "x\n".repeat(max - 1) + "x";
    expect(pv.lineDiff(last, last)?.length, "max lines, the last unterminated: compared").toBe(max);
  });
  it("lineCount agrees with how the diff splits lines (random LF / CR / CRLF / text)", () => {
    let seed = 11; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const s = Array.from({ length: rnd(12) }, () => ["\n", "\r", "\r\n", "x", ""][rnd(5)]).join("");
      const ops = pv.lineDiff(s, s, { ...pv.DIFF_LIMITS, maxInputLines: 1e9 });
      expect(pv.lineCount(s), JSON.stringify(s)).toBe(ops.length);
    }
  });
  it("hunks: context around each change, merged when they touch, 1-based starts and counts as a unified diff has them", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], b = [...a];
    b[1] = "two"; b[8] = "nine";
    const hs = pv.diffHunks(pv.lineDiff(a.join("\n"), b.join("\n")), 1);
    expect(hs.map((x: any) => [x.oldStart, x.oldLines, x.newStart, x.newLines, x.lines.map((l: any) => l.t + l.text).join(",")]))
      .toEqual([[1, 3, 1, 3, " 1,-2,+two, 3"], [8, 3, 8, 3, " 8,-9,+nine, 10"]]);
    expect(pv.diffHunks(pv.lineDiff("a\nb", "a\nb"))).toEqual([]);
  });
});

describe("the panel's ‹ v of n › step", () => {
  it("three versions: the newest opened says v3 of 3; ‹ shows v2 waiting for Preview (the run stops, nothing starts); › at the end is disabled", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2))), agent(3, FENCE(PAGE(3)))]);
    await click(cards(doc)[2].querySelector(".pv-open"));
    expect([shown(), at(doc), PV.liveCount(), doc.querySelector(".pv-ver-next").disabled]).toEqual(["b-3:f0", "v3/3", 1, true]);
    await click(doc.querySelector(".pv-ver-prev"));
    expect([shown(), at(doc), PV.liveCount(), !!doc.querySelector(".pv-panel-run")]).toEqual(["b-2:f0", "v2/3", 0, true]);
    await click(doc.querySelector(".pv-ver-prev"));
    expect([shown(), at(doc), doc.querySelector(".pv-ver-prev").disabled]).toEqual(["b-1:f0", "v1/3", true]);
    await click(doc.querySelector(".pv-ver-next"));
    expect(shown()).toBe("b-2:f0");
  });

  it("one version, or another page in between: no stepper; a new reply with the same title adds a version", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2, "Other")))]);
    await click(cards(doc)[0].querySelector(".pv-open"));
    expect(doc.querySelector(".pv-ver")).toBeNull();
    stream.message(agent(3, FENCE(PAGE(3))));
    await settle();
    expect(at(doc)).toBe("v1/2");
  });

  it("a step keeps the Code view on screen (comparing source); a fresh open goes back to the page", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2)))]);
    await click(cards(doc)[1].querySelector(".pv-open"));
    await click([...doc.querySelectorAll(".pv-panel-bar .seg-inline .btn")].find((b: any) => /Code/.test(b.textContent)));
    await click(doc.querySelector(".pv-ver-prev"));
    expect([shown(), doc.querySelector(".pv-code code")?.textContent]).toEqual(["b-1:f0", PAGE(1)]);
  });

  it("attached files: a step reads the other file once, then shows it from memory", async () => {
    const files: Record<string, string> = { [ID1]: PAGE(1), [ID2]: PAGE(2) };
    globalThis.fetch = vi.fn(async (url: string) => {
      const id = /\/ui\/file\/([0-9a-f]{32})$/.exec(url)![1];
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(files[id]).buffer };
    }) as any;
    const doc = await chat([withFile(1, ID1, "page.html"), withFile(2, ID2, "page.html")]);
    await click(cards(doc)[1].querySelector(".pv-open"));
    await settle(); await settle();
    expect([shown(), at(doc)]).toEqual([`b-2:a${ID2}`, "v2/2"]);
    await click(doc.querySelector(".pv-ver-prev")); await settle(); await settle();
    expect([shown(), pp.panelStore.get().open.code]).toEqual([`b-1:a${ID1}`, PAGE(1)]);
    await click(doc.querySelector(".pv-ver-next")); await settle();
    await click(doc.querySelector(".pv-ver-prev")); await settle();
    expect([shown(), (globalThis.fetch as any).mock.calls.filter((c: any) => c[0].endsWith(ID1)).length]).toEqual([`b-1:a${ID1}`, 1]);
  });
});

describe("#2915 review: a version still being read never replaces a later open", () => {
  it("‹ to an attached v1 whose read is held; the panel closes and v2 is opened again; v1's late answer is dropped", async () => {
    const held: Record<string, () => void> = {};
    const files: Record<string, string> = { [ID1]: PAGE(1), [ID2]: PAGE(2) };
    globalThis.fetch = vi.fn((url: string) => {
      const id = /\/ui\/file\/([0-9a-f]{32})$/.exec(url)![1];
      const answer = { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(files[id]).buffer };
      return id === ID1 ? new Promise(r => { held[id] = () => r(answer); }) : Promise.resolve(answer);
    }) as any;
    const doc = await chat([withFile(1, ID1, "page.html"), withFile(2, ID2, "page.html")]);
    await click(cards(doc)[1].querySelector(".pv-open")); await settle(); await settle();
    expect(shown()).toBe(`b-2:a${ID2}`);
    await click(doc.querySelector(".pv-ver-prev"));             // v1's read is held
    const v2 = { ...pp.panelStore.get().open };
    pp.closePanel(); await settle();
    pp.openPanel(v2); await settle();                          // the same block again, before v1 answers
    held[ID1](); await settle(); await settle();
    expect([shown(), pp.panelStore.get().open.code]).toEqual([`b-2:a${ID2}`, PAGE(2)]);
  });
  it("control: with nothing in between, the held read shows v1 when it answers", async () => {
    let release = () => {};
    globalThis.fetch = vi.fn((url: string) => {
      const id = /\/ui\/file\/([0-9a-f]{32})$/.exec(url)![1];
      const answer = { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(id === ID1 ? PAGE(1) : PAGE(2)).buffer };
      return id === ID1 ? new Promise(r => { release = () => r(answer); }) : Promise.resolve(answer);
    }) as any;
    const doc = await chat([withFile(1, ID1, "page.html"), withFile(2, ID2, "page.html")]);
    await click(cards(doc)[1].querySelector(".pv-open")); await settle(); await settle();
    await click(doc.querySelector(".pv-ver-prev"));
    release(); await settle(); await settle();
    expect(shown()).toBe(`b-1:a${ID1}`);
  });
});

describe("Changes", () => {
  it("offered from v2 on; shows the previous version's removed and added lines as text, with the hunk header", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2)))]);
    await click(cards(doc)[0].querySelector(".pv-open"));
    expect(doc.querySelector(".pv-changes"), "v1 has nothing before it").toBeNull();
    await click(doc.querySelector(".pv-ver-next"));
    await click(doc.querySelector(".pv-changes"));
    expect(doc.querySelector(".pv-diff-head").textContent).toBe("Changes from v1");
    expect([...doc.querySelectorAll(".pv-diff .d-del")].map((s: any) => s.textContent)).toEqual(["- <h1>v1</h1>\n"]);
    expect([...doc.querySelectorAll(".pv-diff .d-add")].map((s: any) => s.textContent)).toEqual(["+ <h1>v2</h1>\n"]);
    expect(doc.querySelector(".pv-diff .d-hunk").textContent).toBe("@@ -1,3 +1,3 @@\n");
  });

  it("a step from Changes to v1 (nothing before it) shows the page, not a wait that never ends; the next step brings Changes back", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2))), agent(3, FENCE(PAGE(3)))]);
    await click(cards(doc)[1].querySelector(".pv-open"));
    await click(doc.querySelector(".pv-changes"));
    await click(doc.querySelector(".pv-ver-prev"));
    expect([shown(), doc.querySelector(".pv-diff-note"), doc.querySelector(".pv-panel-body").className, !!doc.querySelector(".pv-panel-run")])
      .toEqual(["b-1:f0", null, "pv-panel-body", true]);
    await click(doc.querySelector(".pv-ver-next"));
    expect(doc.querySelector(".pv-diff-head")?.textContent).toBe("Changes from v1");
  });

  it("the page's markup is never parsed: a <script> or <img> in a changed line stays text", async () => {
    const evil = (n: number) => `<title>T</title>\n<img src=x onerror="parent.boom=${n}"><script>parent.boom=${n}</script>`;
    const doc = await chat([agent(1, FENCE(evil(1))), agent(2, FENCE(evil(2)))]);
    await click(cards(doc)[1].querySelector(".pv-open"));
    await click(doc.querySelector(".pv-changes"));
    const diff = doc.querySelector(".pv-diff");
    expect([diff.querySelectorAll("script").length, diff.querySelectorAll("img").length]).toEqual([0, 0]);
    expect(diff.textContent).toContain("+ <img src=x onerror=\"parent.boom=2\"><script>parent.boom=2</script>");
  });

  it("no difference, and too large to compare, are said in words", async () => {
    const same = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(1)))]);
    await click(cards(same)[1].querySelector(".pv-open"));
    await click(same.querySelector(".pv-changes"));
    expect(same.querySelector(".pv-diff-note").textContent).toBe("No changes from v1.");
    await current!.unmount(); PV.stopAll("x"); pp.closePanel(); current!.restore(); current = null;
    const many = (c: string) => `<title>T</title>\n` + Array.from({ length: 2100 }, (_, i) => `${c}${i}`).join("\n");
    const doc = await chat([agent(1, FENCE(many("a"))), agent(2, FENCE(many("b")))]);
    await click(cards(doc)[1].querySelector(".pv-open"));
    await click(doc.querySelector(".pv-changes"));
    expect(doc.querySelector(".pv-diff-note").textContent).toMatch(/too large or too different/);
  });

  it("a long diff is cut at maxLines, and says so", async () => {
    const many = (c: string) => `<title>T</title>\n` + Array.from({ length: 3200 }, (_, i) => `${i % 4 ? "k" : c}${i}`).join("\n");
    const doc = await chat([agent(1, FENCE(many("a"))), agent(2, FENCE(many("b")))]);
    await click(cards(doc)[1].querySelector(".pv-open"));
    await click(doc.querySelector(".pv-changes"));
    expect(doc.querySelectorAll(".pv-diff code > span").length).toBe(pv.DIFF_LIMITS.maxLines);
    expect(doc.querySelector(".pv-diff-cut").textContent).toBe(`showing the first ${pv.DIFF_LIMITS.maxLines} lines`);
  });
});
