/**
 * Task cards in the web chat — the pure parts and the page's modules.
 *   1. The rule for what names a card (`#M-3`, `#s3`; a bare M-3 is a word) is one: the server's, the page's and the renderer's
 *      return the same numbers for one list of cases — and leave alone what is not a reference (a word, a path, a URL, a
 *      decimal). Code, a link's label and a URL are no reference either: what the server hands the agent is exactly the chips
 *      the page draws.
 *   2. Typing `#`: where the list opens, what it searches for, what goes in when a card is chosen.
 *   3. The chip: number, title, status, a link to the card; only for a card the page knows; the card's own words are escaped;
 *      nothing in a code span or a URL; a page that does not ask (an agent's message, the Hub) draws what it always drew.
 *   4. The page's index of cards: asks only for a person's own numbers, each once, again after a board change; an answer that
 *      never comes leaves the number as text; a newer list request wins.
 *   5. A thread's cached Markdown follows what the page knows of a card.
 */
import { describe, expect, it, vi } from "vitest";
import "../src/ui/chat-render.js";
import { taskRefCodes as serverCodes } from "../src/chat-task-refs.js";
// @ts-expect-error — page modules: plain JS, no declarations
import { createTaskRefIndex, insertTaskRef, taskRefAt, taskRefCode, taskRefCodes as pageCodes } from "../src/ui/chat-task-refs.js";
// @ts-expect-error — page module
import { clearRenderedMarkdown, renderedMarkdown } from "../src/ui/shared/chat-thread.js";

const R = () => (globalThis as any).AgendChatRender;

/** [text, the numbers it names] — the one list the three readers are held to. */
const CASES: Array<[string, string[]]> = [
  ["#M-3", ["M-3"]],
  ["#m3", ["M-3"]],
  ["#S-34 and #s-34", ["S-34"]],
  ["look at #M-3 please", ["M-3"]],
  ["#M-3, #S-4; #M-3 again", ["M-3", "S-4"]],
  ["請看#M-3的進度", ["M-3"]],
  ["看#M-3怎麼了", ["M-3"]],
  ["(#M-12)", ["M-12"]],
  ["line one\n#S-7\n#M-9", ["S-7", "M-9"]],
  ["#M-007", ["M-7"]],
  // not references
  ["M-3 and S-4 without the #", []],
  ["fix M-3304 now", []],
  ["m-3 in lowercase with a hyphen is a word", []],
  ["M3 bare, no hyphen", []],
  ["a#M-3", []],
  ["##M-3", []],
  ["/usr/#M-3 and https://example.com/#M-3 and https://example.com/page#S-4", []],
  ["version #M-3.5", []],
  ["#S-3-2 and #M-3x", []],
  ["#12 is an issue", []],
  ["#", []],
  ["#M-", []],
  ["#M-1234567890", []],
];
/** Code, links and URLs: not references — what the page draws no chip in, the server hands the agent no card for. */
const PROSE_CASES: Array<[string, string[]]> = [
  ["`#M-3`", []],
  ["run `git log` then #M-3 and `#S-4`", ["M-3"]],
  ["```\n#M-3\n```", []],
  ["```js\nconst a = '#M-3';\n```\nafter: #S-4", ["S-4"]],
  ["```\n#M-3 in a fence that is never closed", []],
  ["[#M-3](https://example.com/a)", []],
  ["[see #M-3 here](mailto:a@example.com) and #S-4", ["S-4"]],
  ["[#M-3](not-a-link) is text", ["M-3"]],
  ["[x](https://example.com) #M-4", ["M-4"]],
  ["https://example.com/?a=1.#M-3 and #S-4", ["S-4"]],
  ["see https://example.com/a #M-3", ["M-3"]],
  ["~~~\n#M-3\n~~~", ["M-3"]],                     // only ``` fences are code in this renderer
];

describe("what names a card: one rule in three places", () => {
  it.each(CASES)("%j → %j", (text, expected) => {
    expect(serverCodes(text)).toEqual(expected);
    expect(pageCodes(text)).toEqual(expected);
    expect(R().taskRefCodes(text)).toEqual(expected);
  });
  // The page asks about, and keys its cache on, every number it can read in a text (a superset, harmless); the server and the
  // renderer are the two that decide: the cards handed to the agent are exactly the chips drawn.
  it.each([...CASES, ...PROSE_CASES])("the agent gets what the page draws: %j → %j", (text, expected) => {
    expect(serverCodes(text)).toEqual(expected);
    const html = R().renderMarkdown(text, { taskRefs: (code: string) => ({ title: `Card ${code}`, status: "open", statusLabel: "To do" }) });
    expect([...new Set([...html.matchAll(/data-task-ref="([MS]-\d+)"/g)].map((m) => m[1]))]).toEqual(expected);
  });
  it("at most ten numbers, each once", () => {
    const many = Array.from({ length: 14 }, (_, i) => `#M-${i + 1}`).join(" ");
    expect(serverCodes(many)).toHaveLength(10);
    expect(pageCodes(many)).toHaveLength(10);
    expect(R().taskRefCodes(many)).toHaveLength(10);
    expect(serverCodes("#M-1 #M-1 #m1")).toEqual(["M-1"]);
  });
  it("a card number as the board writes it", () => {
    expect([taskRefCode("#s3"), taskRefCode(" m - 12 "), taskRefCode("M-3"), taskRefCode("x3"), taskRefCode("M-"), taskRefCode("")]).toEqual(["S-3", "M-12", "M-3", null, null, null]);
  });
});

describe("typing # in the chat box", () => {
  const at = (text: string, caret = text.length) => taskRefAt(text, caret);
  it("opens on a # that starts the text or follows a space, a bracket or a full-width mark; the query is what follows it", () => {
    expect(at("#")).toEqual({ start: 0, query: "" });
    expect(at("#lo")).toEqual({ start: 0, query: "lo" });
    expect(at("see #M-1")).toEqual({ start: 4, query: "M-1" });
    expect(at("(#M")).toEqual({ start: 1, query: "M" });
    expect(at("請看，#登入")).toEqual({ start: 3, query: "登入" });
    expect(at("a\n#x")).toEqual({ start: 2, query: "x" });
  });
  it("not in a word, a path or a URL, not after a second #, not past a space, not in a command line", () => {
    for (const text of ["page#top", "a/b#c", "x@y#z", "##x", "# x", "see # x", "/btw look at #M-3", "  /btw #M"]) expect(at(text), JSON.stringify(text)).toBeNull();
  });
  it("reads up to the caret: a caret in the middle of the text, and before the # there is nothing to complete", () => {
    expect(at("fix #login now", 10)).toEqual({ start: 4, query: "login" });
    expect(at("fix #login now", 3)).toBeNull();
    expect(at("fix #login now", 14)).toBeNull();
  });
  it("a chosen card puts its number in the place of the query, one space after, the caret behind it", () => {
    const text = "see #lo";
    expect(insertTaskRef(text, at(text)!, text.length, "M-3")).toEqual({ text: "see #M-3 ", caret: 9 });
    const mid = "fix #lo now";
    expect(insertTaskRef(mid, at(mid, 7)!, 7, "S-12")).toEqual({ text: "fix #S-12 now", caret: 10 });
    const nl = "#\nnext";
    expect(insertTaskRef(nl, at(nl, 1)!, 1, "M-1")).toEqual({ text: "#M-1\nnext", caret: 4 });
  });
});

const CARD = { title: "Build the leaderboard", status: "claimed", statusLabel: "In progress", tip: "M-3 · Build the leaderboard · In progress · @dev-a" };
const known = (map: Record<string, unknown>) => (code: string) => (map[code] as any) ?? null;
const draw = (text: string, cards: Record<string, unknown> = { "M-3": CARD }) => R().renderMarkdown(text, { taskRefs: known(cards) });

describe("the chip", () => {
  it("a known card: number, title, status, a link to it (Fleet › Tasks, ?card=), the card's own tip", () => {
    const html = draw("look at #M-3 now");
    expect(html).toBe('<p>look at <a class="task-ref" href="/ui/fleet?card=M-3" data-task-ref="M-3" title="M-3 · Build the leaderboard · In progress · @dev-a">'
      + '<span class="task-ref-code">M-3</span><span class="task-ref-title">Build the leaderboard</span><span class="tb-pill st-claimed">In progress</span></a> now</p>');
  });
  it("a hand-typed number is the same chip, in either case of the letter and with or without the hyphen", () => {
    for (const text of ["#M-3", "#m3", "#m-3", "#M3"]) expect(draw(text), text).toContain('data-task-ref="M-3"');
  });
  it("a bare number — no # — is the word it is, even for a card the page knows", () => {
    for (const text of ["M-3", "fix M-3 now", "S-4 and M-3304"]) expect(draw(text, { "M-3": CARD, "S-4": CARD, "M-3304": CARD }), text).toBe(`<p>${text}</p>`);
  });
  it("a number that is no card (not asked yet, not a card, or deleted) stays the text it was", () => {
    expect(draw("see #M-99 and #M-98", {})).toBe("<p>see #M-99 and #M-98</p>");
    expect(draw("see #M-3 and #M-99")).toContain("#M-99");
  });
  it("the card's words are escaped, the class comes from the fixed list, the href from the digits", () => {
    const evil = { title: '<img src=x onerror=alert(1)> "q"', status: 'x" onclick="y', statusLabel: "<b>done</b>", tip: '" onmouseover="z' };
    const html = draw("#M-3", { "M-3": evil });
    expect(html).not.toMatch(/<img|<b>|onclick="y|onmouseover="z"/);
    expect(html).toContain("&lt;img");
    expect(html).toContain('class="tb-pill st-open"');
    expect(html).toContain('href="/ui/fleet?card=M-3"');
  });
  it("nothing inside a code span, a link or a URL; a card next to one is still a chip", () => {
    expect(draw("`#M-3`")).toBe("<p><code>#M-3</code></p>");
    expect(draw("[#M-3](https://example.com/a)")).not.toContain("task-ref");
    expect(draw("https://example.com/#M-3 and https://example.com/M-3")).not.toContain("task-ref");
    expect(draw("https://example.com/x #M-3")).toContain('data-task-ref="M-3"');
  });
  it("two cards, and one card twice, are chips each time", () => {
    const html = draw("#M-3 then #S-4 then #M-3", { "M-3": CARD, "S-4": { ...CARD, title: "Write tests", status: "open", statusLabel: "To do" } });
    expect([...html.matchAll(/data-task-ref="([MS]-\d+)"/g)].map((m) => m[1])).toEqual(["M-3", "S-4", "M-3"]);
  });
  it("a page that does not ask draws what it always drew (an agent's message, the Hub, a message before this feature)", () => {
    for (const text of ["#M-3", "see #M-3 and #S-4 done"]) {
      expect(R().renderMarkdown(text, {})).toBe(`<p>${text}</p>`);
      expect(R().renderMarkdown(text)).toBe(`<p>${text}</p>`);
    }
    expect(R().renderMarkdown("<@123456789012345678> #M-3", { mentions: () => null })).not.toContain("task-ref");
  });
  it("Markdown around it still works: a list item, a table cell, bold", () => {
    expect(draw("- #M-3 first\n- **#M-3** second")).toContain("<li>");
    expect(draw("| a |\n|---|\n| #M-3 |")).toContain("<td><a class=\"task-ref\"");
  });
});

describe("the thread's cached Markdown follows what the page knows", () => {
  it("the same text is drawn again when the card's words or status change, and not before", () => {
    clearRenderedMarkdown();
    let card: any = CARD;
    const info = (code: string) => (code === "M-3" ? card : null);
    const spy = vi.spyOn(R(), "renderMarkdown");
    const a = renderedMarkdown("#M-3", false, undefined, undefined, undefined, info);
    renderedMarkdown("#M-3", false, undefined, undefined, undefined, info);
    expect(spy).toHaveBeenCalledTimes(1);                       // kept
    card = { ...CARD, status: "done", statusLabel: "Done" };
    const b = renderedMarkdown("#M-3", false, undefined, undefined, undefined, info);
    expect(spy).toHaveBeenCalledTimes(2);
    expect([a.includes("st-claimed"), b.includes("st-done")]).toEqual([true, true]);
    card = null;                                                // no longer a card: the text again
    expect(renderedMarkdown("#M-3", false, undefined, undefined, undefined, info)).toBe("<p>#M-3</p>");
    spy.mockRestore();
  });
  it("a page without cards renders and caches as before (the Hub, an agent's message)", () => {
    clearRenderedMarkdown();
    expect(renderedMarkdown("#M-3 and #M-4", true, undefined, undefined, undefined)).toBe("<p>#M-3 and #M-4</p>");
  });
});

describe("the page's index of cards", () => {
  const viewOf = (code: string, over: Record<string, unknown> = {}) => ({ code, title: `Title of ${code}`, status: "open", assignee: null, kind: code[0] === "M" ? "main" : "sub", ...over });
  function rig(answer: (url: string) => unknown = () => ({ refs: [] })) {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => { calls.push(url); const body = await answer(url); return body === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => body }; };
    return { calls, index: createTaskRefIndex(fetchImpl) };
  }
  const settleAll = async (index: any) => { for (let i = 0; i < 20 && index.pending(); i++) await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const user = (text: string) => ({ role: "user", text });

  it("asks for the numbers a person's messages name, each once, in one request, and knows them when they come", async () => {
    const { calls, index } = rig((url) => ({ refs: decodeURIComponent(url.split("codes=")[1]!).split(",").filter((c) => c !== "M-99").map((c) => viewOf(c)) }));
    const seen = vi.fn();
    index.subscribe(seen);
    index.ensure([user("see #M-3 and #M-99 and M-55"), user("again #M-3 and #S-4"), { role: "agent", text: "I did #M-77" }, { role: "user", text: 5 }, null]);
    await settleAll(index);
    expect(calls).toEqual([`/ui/tasks/refs?codes=${encodeURIComponent("M-3,M-99,S-4")}`]);
    expect([index.get("M-3")?.title, index.get("S-4")?.title, index.get("M-99"), index.get("M-77")]).toEqual(["Title of M-3", "Title of S-4", null, null]);
    expect(seen).toHaveBeenCalledTimes(1);
    index.ensure([user("#M-3 once more")]);
    await settleAll(index);
    expect(calls).toHaveLength(1);                              // asked already, answered or not
  });
  it("an answer that never comes (no board, an error) leaves the number as text, and it is asked again after a change", async () => {
    let ok = false;
    const { calls, index } = rig(() => (ok ? { refs: [viewOf("M-3")] } : null));
    index.ensure([user("#M-3")]);
    await settleAll(index);
    expect(index.get("M-3")).toBeNull();
    ok = true;
    index.refresh();
    await settleAll(index);
    expect(calls).toHaveLength(2);
    expect(index.get("M-3")?.title).toBe("Title of M-3");
  });
  it("after a board change the cards asked about are asked again, and a chip follows the card (status, title, or gone)", async () => {
    let status = "open", exists = true;
    const { index } = rig(() => ({ refs: exists ? [viewOf("M-3", { status })] : [] }));
    const seen = vi.fn();
    index.ensure([user("#M-3")]);
    await settleAll(index);
    index.subscribe(seen);
    status = "done"; index.refresh(); await settleAll(index);
    expect([index.get("M-3")?.status, seen.mock.calls.length]).toEqual(["done", 1]);
    exists = false; index.refresh(); await settleAll(index);
    expect([index.get("M-3"), seen.mock.calls.length]).toEqual([null, 2]);
    index.refresh(); await settleAll(index);
    expect(seen.mock.calls.length).toBe(2);                     // nothing new, nothing drawn
  });
  it("the cards offered for what follows #: the server's list, the query encoded; only the newest request counts", async () => {
    const waiting: Array<() => void> = [];
    const { calls, index } = rig((url) => new Promise((resolve) => waiting.push(() => resolve({ refs: [viewOf(url.includes("q=a") ? "M-1" : "M-2")] }))) as never);
    const first = index.suggest("a b/#");
    const second = index.suggest("b");
    await Promise.resolve(); await Promise.resolve();
    waiting[1]!(); waiting[0]!();
    expect(await second).toEqual([viewOf("M-2")]);
    expect(await first).toEqual([]);
    expect(calls[0]).toBe(`/ui/tasks/refs?limit=8&q=${encodeURIComponent("a b/#")}`);
    expect(index.get("M-2")?.title).toBe("Title of M-2");        // what the list showed is what a chip says
  });
  it("a list that cannot be read is no list", async () => {
    const { index } = rig(() => null);
    expect(await index.suggest("")).toEqual([]);
  });
});
