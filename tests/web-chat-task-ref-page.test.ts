/**
 * Task cards in the web chat — the page side, on the real ChatPanel in the mini DOM.
 *   - `#` in the chat box opens the list of task cards (the command palette's own look); typing narrows it, the arrows move,
 *     Enter / Tab put the number in (never a send), Esc closes it; not in a word or a URL, not on a command line.
 *   - A person's message or an agent's reply that names a card shows a chip (number, title, status) that links to the card;
 *     the number is the text until the card's answer arrives; a number that is no card (or one the server leaves out, as a
 *     hidden instance's card over the public link), a status line and a message from before this feature are drawn as they
 *     always were.
 *   - What is sent is the draft as typed (the server adds the card summary for the agent).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fire, settle } from "./helpers/mini-dom.js";
import type { AppPage } from "./helpers/app-harness.js";

const CARDS: Record<string, any> = {
  "M-1": { code: "M-1", title: "Build the login API", status: "claimed", assignee: "dev-a", kind: "main" },
  "S-2": { code: "S-2", title: "Write the tests", status: "open", assignee: null, kind: "sub" },
  "M-3": { code: "M-3", title: "<b>Ship</b> it", status: "done", assignee: null, kind: "main" },
};
const reads: string[] = [];
const sends: any[] = [];
let board = true;           // false: the page cannot read the board (an old host, a failure)
let panel: any, appStore: any, harness: any, current: AppPage | null = null;

/** A page of its own for each test (the modules are loaded afresh: the page's index of cards starts empty). */
async function boot() {
  vi.resetModules();
  harness = await import("./helpers/app-harness.js");
  current = harness.page({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  // @ts-expect-error — a JS module of the app, with no types
  panel = await import("../src/ui/panel-chat.js");
  ({ appStore } = await import("/assets/app-store.js"));
  const fetchFake = async (url: string, init: any = {}) => {
    reads.push(url);
    if (url.startsWith("/ui/tasks/refs")) {
      if (!board) return { ok: false, status: 503, json: async () => ({}) };
      const q = new URL(url, "http://x").searchParams;
      const refs = q.has("codes") ? q.get("codes")!.split(",").filter((c) => CARDS[c]).map((c) => CARDS[c])
        : Object.values(CARDS).filter((c) => !q.get("q") || c.code.toLowerCase().includes(q.get("q")!.toLowerCase()) || c.title.toLowerCase().includes(q.get("q")!.toLowerCase()));
      return { ok: true, status: 200, json: async () => ({ refs }) };
    }
    if (url === "/ui/send") { sends.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ sent: true, messageId: `m${sends.length}` }) }; }
    return new Promise(() => {});
  };
  panel.boot({ stream: { on() {} }, boot: null, deps: { fetch: fetchFake } });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running", state: "idle", backend: "claude-code" }] });
}
afterEach(async () => { await current?.unmount(); current?.restore(); current = null; reads.length = 0; sends.length = 0; board = true; });

const row = (id: number, role: string, text: string) => ({ boot: "b", id, instance: "w", sender: role === "user" ? "You" : "w", role, text, ts: `2026-01-01T00:00:0${id}Z` });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(msgs: any[] = []) {
  await boot();
  panel.store.state.msgs.w = msgs;
  await current!.mount(harness.h(panel.ChatPanel, { route: { instance: "w" }, navKey: "w1" }));
  await settle(); await settle();
  const root = current!.root as any;
  const box = () => root.querySelector("#msgIn");
  const type = async (text: string, caret?: number) => {
    box().value = text;
    if (caret !== undefined) box().selectionStart = caret;
    fire(box(), "input"); await settle(); await wait(150); await settle();
  };
  const key = async (k: string, init: Record<string, unknown> = {}) => { const e = fire(box(), "keydown", { key: k, ...init }); await settle(); return e; };
  const options = () => [...root.querySelectorAll(".task-ref-list li[role=option]")] as any[];
  const chips = () => [...root.querySelectorAll(".msg .md a.task-ref")] as any[];
  return { root, box, type, key, options, chips };
}

describe("typing # in the chat box", () => {
  it("opens the list of cards: number, title, status — the command palette's look; the box says it has a list", async () => {
    const c = await open();
    await c.type("#");
    expect(c.options().map((o) => o.querySelector(".cmd-name").textContent)).toEqual(["M-1", "S-2", "M-3"]);
    expect(c.options()[0].textContent).toContain("Build the login API");
    expect(c.options()[0].querySelector(".tb-pill.st-claimed")?.textContent).toBe("In progress");
    expect(c.options()[2].querySelector(".tb-pill.st-done")?.textContent).toBe("Done");
    expect(c.root.querySelector(".cmd-palette.task-ref-list")?.getAttribute("role")).toBe("listbox");
    expect([c.box().getAttribute("aria-expanded"), c.box().getAttribute("aria-activedescendant")]).toEqual(["true", c.options()[0].id]);
    expect(reads.filter((u) => u.startsWith("/ui/tasks/refs?limit=8&q="))).toEqual(["/ui/tasks/refs?limit=8&q="]);
  });
  it("what is typed after it narrows the list (the server's answer, by number or title)", async () => {
    const c = await open();
    await c.type("see #lo");
    expect(c.options().map((o) => o.querySelector(".cmd-name").textContent)).toEqual(["M-1"]);
    await c.type("see #s-2");
    expect(c.options().map((o) => o.querySelector(".cmd-name").textContent)).toEqual(["S-2"]);
    await c.type("see #zzz");
    expect(c.options()).toEqual([]);                          // no match: no list, and Enter sends as it always did
    expect(c.box().getAttribute("aria-expanded")).toBe("false");
  });
  it("↓ / ↑ move (and wrap); Enter puts the highlighted number in — it is not a send; the box keeps focus text", async () => {
    const c = await open();
    await c.type("fix #");
    await c.key("ArrowDown");
    expect(c.box().getAttribute("aria-activedescendant")).toBe(c.options()[1].id);
    await c.key("ArrowUp"); await c.key("ArrowUp");
    expect(c.box().getAttribute("aria-activedescendant")).toBe(c.options()[2].id);   // wraps
    await c.key("ArrowDown");
    const enter = await c.key("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(c.box().value).toBe("fix #M-1 ");
    expect(sends).toEqual([]);
    expect(c.options()).toEqual([]);                          // the list closes with the choice
  });
  it("Tab puts it in too; a choice in the middle of the text keeps what follows; a tap on a row chooses it", async () => {
    const c = await open();
    await c.type("fix #lo now", 7);
    const tab = await c.key("Tab");
    expect([tab.defaultPrevented, c.box().value]).toEqual([true, "fix #M-1 now"]);
    await c.type("#");
    fire(c.options()[1], "mousedown");
    await settle();
    expect(c.box().value).toBe("#S-2 ");
  });
  it("a press on a row is left to the row: the dock strip's pointer handler would cancel the press (and the row's mouse-down with it) on anything that is not a control", async () => {
    const c = await open();
    await c.type("#");
    const press = { button: 0, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true };
    const strip = fire(c.root.querySelector(".composer-hit"), "pointerdown", press);
    expect(strip.defaultPrevented, "control: a press on the strip itself is taken to focus the box").toBe(true);
    expect(c.options()[0].getAttribute("tabindex")).toBe("-1");
    expect(fire(c.options()[0], "pointerdown", press).defaultPrevented, "a press on a row is not").toBe(false);
    fire(c.options()[0], "mousedown");
    await settle();
    expect(c.box().value).toBe("#M-1 ");
  });
  it("the caret goes behind the number", async () => {
    const c = await open();
    let at: number | null = null;
    c.box().setSelectionRange = (a: number) => { at = a; };
    await c.type("a #");
    await c.key("Enter");
    expect([c.box().value, at]).toEqual(["a #M-1 ", 7]);
  });
  it("after a choice the list is closed at once, even while the box still reports the caret of the text it had (a real browser's, until the page has drawn)", async () => {
    const c = await open();
    c.box().setSelectionRange = (at: number) => { c.box().selectionStart = at; };   // as a browser's box: the caret is where it was put
    await c.type("fix #s-", 7);                                 // the box's caret: after the "s-"
    expect(c.options().map((o) => o.querySelector(".cmd-name").textContent)).toEqual(["S-2"]);
    await c.key("Enter");
    expect(c.box().value).toBe("fix #S-2 ");
    await wait(250); await settle();
    expect([c.options(), c.box().getAttribute("aria-expanded")]).toEqual([[], "false"]);
    // Read at the old caret the draft would be "#S-" again: a second list (and a second request) for what was just chosen.
    const asked = reads.filter((u) => u.startsWith("/ui/tasks/refs?limit=8&q=")).map((u) => new URL(u, "http://x").searchParams.get("q"));
    expect(asked).toEqual(["s-"]);
  });
  it("Esc closes the list and is not a Stop; it opens again when the draft changes", async () => {
    const c = await open();
    await c.type("#");
    const esc = await c.key("Escape");
    expect([esc.defaultPrevented, c.options()]).toEqual([true, []]);
    await c.type("#l");
    expect(c.options().map((o) => o.querySelector(".cmd-name").textContent)).toEqual(["M-1"]);
  });
  it("not in a word or a URL, not on a command line, and not when the board cannot be read", async () => {
    const c = await open();
    for (const text of ["page#top", "https://example.com/a#b", "/btw about #M"]) { await c.type(text); expect(c.options(), text).toEqual([]); }
    board = false;
    await c.type("#");
    expect(c.options()).toEqual([]);
    await c.key("Enter");
    expect(sends.map((s) => s.message)).toEqual(["#"]);       // Enter sends, as it did before this feature
  });
  it("Enter with no list sends the draft exactly as typed (the server adds the cards' summary for the agent)", async () => {
    const c = await open();
    await c.type("look at #M-1 and #M-3 please");
    await c.key("Enter");
    await settle(); await settle();
    expect(sends.map((s) => [s.instance, s.message])).toEqual([["w", "look at #M-1 and #M-3 please"]]);
  });
});

describe("a task card in a message", () => {
  it("a person's number is a chip with number, title, status and a link to the card — once the card's answer is in", async () => {
    const c = await open([row(1, "user", "please look at #M-1 and #S-2")]);
    await wait(20); await settle(); await settle();
    const chips = c.chips();
    expect(chips.map((a) => a.getAttribute("href"))).toEqual(["/ui/fleet?card=M-1", "/ui/fleet?card=S-2"]);
    expect(chips[0].querySelector(".task-ref-code").textContent).toBe("M-1");
    expect(chips[0].querySelector(".task-ref-title").textContent).toBe("Build the login API");
    expect(chips[0].querySelector(".tb-pill.st-claimed").textContent).toBe("In progress");
    expect(chips[0].getAttribute("title")).toBe("M-1 · Build the login API · In progress · @dev-a");
    expect(reads.filter((u) => u.startsWith("/ui/tasks/refs?codes="))).toEqual([`/ui/tasks/refs?codes=${encodeURIComponent("M-1,S-2")}`]);
  });
  it("a card's words are text, never markup", async () => {
    const c = await open([row(1, "user", "#M-3")]);
    await wait(20); await settle(); await settle();
    const chip = c.chips()[0];
    expect([chip.querySelector(".task-ref-title").textContent, chip.querySelector("b")]).toEqual(["<b>Ship</b> it", null]);
  });
  it("a number that is no card and a message from before this feature are drawn as they were", async () => {
    const c = await open([row(1, "user", "an old message about #M-99 and #S-98"), row(3, "user", "plain words, no numbers"), row(4, "user", "a bare M-1, as written before this feature, and `#M-3` in code")]);
    await wait(20); await settle(); await settle();
    expect(c.chips()).toEqual([]);
    const text = [...c.root.querySelectorAll(".msg .md")].map((m: any) => m.textContent);
    expect(text).toEqual(["an old message about #M-99 and #S-98", "plain words, no numbers", "a bare M-1, as written before this feature, and #M-3 in code"]);
    // The person's numbers are asked about, once (the page may ask about a number in code: the renderer draws no chip there).
    expect(reads.filter((u) => u.startsWith("/ui/tasks/refs?codes=")).map((u) => decodeURIComponent(u.split("codes=")[1]!))).toEqual(["M-99,S-98,M-3"]);
  });
  it("an agent's reply that writes a card's number is a chip, like a person's: asked once with the person's numbers, and never in code or for a card the server leaves out", async () => {
    // M-4 is a card the server does not give this viewer (a hidden instance's, over the public link): the answer leaves it out.
    const c = await open([row(1, "user", "where is #M-1?"), row(2, "agent", "#M-1 is in progress; #S-2 is next. #M-4 is not shown to you, and `#M-3` is code.")]);
    await wait(20); await settle(); await settle();
    const chips = c.chips();
    expect(chips.map((a) => a.getAttribute("href"))).toEqual(["/ui/fleet?card=M-1", "/ui/fleet?card=M-1", "/ui/fleet?card=S-2"]);
    const [personChip, agentChip] = [chips[0], chips[1]];
    expect([agentChip.querySelector(".task-ref-title").textContent, agentChip.querySelector(".tb-pill.st-claimed").textContent, agentChip.getAttribute("title")])
      .toEqual([personChip.querySelector(".task-ref-title").textContent, "In progress", "M-1 · Build the login API · In progress · @dev-a"]);
    // The agent's row: the chips are inside its own bubble, and the hidden card's number and the code are the text they were.
    const agentRow = [...c.root.querySelectorAll(".msg.agent .md")][0] as any;
    expect(agentRow.querySelectorAll("a.task-ref")).toHaveLength(2);
    expect(agentRow.textContent).toContain("#M-4 is not shown to you");
    expect(agentRow.querySelectorAll("code")[0].textContent).toBe("#M-3");
    expect(JSON.stringify(reads)).not.toContain("localhost");
    expect(reads.filter((u) => u.startsWith("/ui/tasks/refs?codes=")).map((u) => decodeURIComponent(u.split("codes=")[1]!))).toEqual(["M-1,S-2,M-4,M-3"]);
  });
  it("a status line is not read: its numbers are text, and nothing is asked for them", async () => {
    const c = await open([row(1, "status", "#M-1 was moved to done"), row(2, "agent", "ok")]);
    await wait(20); await settle(); await settle();
    expect(c.chips()).toEqual([]);
    expect(reads.filter((u) => u.startsWith("/ui/tasks/refs?codes="))).toEqual([]);
  });
  it("a board that cannot be read leaves the numbers as text (a chat from an older host, or a failure)", async () => {
    board = false;
    const c = await open([row(1, "user", "see #M-1")]);
    await wait(20); await settle(); await settle();
    expect([c.chips(), c.root.querySelector(".msg .md").textContent]).toEqual([[], "see #M-1"]);
  });
  it("a chip is a link the app opens in place (Fleet › Tasks, that card)", async () => {
    const c = await open([row(1, "user", "#M-1")]);
    await wait(20); await settle(); await settle();
    const a = c.chips()[0];
    expect([a.getAttribute("target"), a.hasAttribute("download")]).toEqual([null, false]);    // so the app's own router takes the click
  });
});
