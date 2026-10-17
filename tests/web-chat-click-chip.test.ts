/**
 * A person's click on a reply button shows in the web chat as a chip with the button's label — never the line the
 * agent was given (`[button] <label> (value: <value>)`), which stays exactly as it was.
 * - The history keeps the click with person messages only (a malformed or an agent's one is dropped), keeps its label
 *   and set id while live, and only the label across a fleet restart (#1565).
 * - The page draws the chip from `click` (escaped), links it to the reply its buttons were on while live, and draws a
 *   restored one plain; any other person message is Markdown as before.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
// @ts-expect-error — a JS module of the app, with no types (as web-preview-card-1306 imports it)
import { createThread } from "../src/ui/chat-thread.js";
import { WebChatHistory, type StoredWebChatMessage } from "../src/web-chat-history.js";

const SET = "a".repeat(32);
describe("the history keeps a click", () => {
  it("on a person's message: label and set; on an agent's, or malformed: none", () => {
    const h = new WebChatHistory({ boot: "b1" });
    const user = h.record({ instance: "w", sender: "alice", role: "user", text: "[button] Deploy (value: deploy-prod)", ts: "t", click: { label: "Deploy", of: SET } });
    expect(user).toMatchObject({ text: "[button] Deploy (value: deploy-prod)", click: { label: "Deploy", of: SET } });
    expect(h.record({ instance: "w", sender: "w", role: "agent", text: "x", ts: "t", click: { label: "Deploy" } }).click).toBeUndefined();
    for (const click of [{ label: "" }, { label: 5 }, "Deploy", null, [{ label: "x" }]]) expect(h.record({ instance: "w", sender: "a", text: "x", ts: "t", click }).click, JSON.stringify(click)).toBeUndefined();
    expect(h.record({ instance: "w", sender: "a", text: "x", ts: "t", click: { label: "L", of: "not-a-set" } }).click).toEqual({ label: "L" });
    expect(h.record({ instance: "w", sender: "a", text: "x", ts: "t", click: { label: "x".repeat(500) } }).click!.label).toHaveLength(200);
  });
  it("across a fleet restart: the label comes back, the link to the buttons does not", () => {
    let rows: StoredWebChatMessage[] = [];
    const store = { schedule: (_i: string, snap: () => StoredWebChatMessage[]) => { rows = snap(); }, flush() {} } as never;
    const a = new WebChatHistory({ boot: "b1", store });
    a.record({ instance: "w", sender: "alice", role: "user", text: "[button] Deploy (value: deploy-prod)", ts: "t", click: { label: "Deploy", of: SET } });
    expect(rows[0]!.click).toEqual({ label: "Deploy" });
    const b = new WebChatHistory({ boot: "b2" });
    b.restore("w", JSON.parse(JSON.stringify(rows)));
    expect(b.list("w")[0]).toMatchObject({ text: "[button] Deploy (value: deploy-prod)", click: { label: "Deploy" } });
    expect(b.list("w")[0]!.click!.of).toBeUndefined();
    const c = new WebChatHistory({ boot: "b3" });
    c.restore("w", [{ ...rows[0], boot: "b9", role: "agent" }]);
    expect(c.list("w")[0]!.click, "never on an agent's message").toBeUndefined();
  });
});

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types: sets the page's AgendChatRender global
  await import("../src/ui/chat-render.js");
});
let pg: AppPage | null = null;
afterEach(() => { if (pg) { pg.restore(); pg = null; } });
function threadAt() {
  pg = page({ storage: { agend_tour_done: "1" } });
  const doc = pg.document as any;
  const scroller = doc.createElement("div"), list = doc.createElement("div");
  scroller.append(list); doc.body.append(scroller);
  const tr = (k: string) => ({ "chat.clicked": "Clicked:", "chat.clickShow": "Show the message these buttons were on" } as Record<string, string>)[k] ?? k;
  const thread = createThread(list, scroller, {
    t: tr, tf: tr, isUser: (x: any) => x.sender === "me", onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
  });
  return { list, thread };
}
const agent = { boot: "b", id: 1, instance: "w", sender: "w", role: "agent", text: "Deploy now?", ts: "2026-10-16T00:00:00.000Z", buttons: { id: SET, labels: ["Deploy <b>now</b>", "Wait"], state: "chosen", chosen: 0, by: "me" } };
const click = (extra: Record<string, unknown>, sender = "me") => ({ boot: "b", id: 2, instance: "w", sender, role: "user", text: "[button] Deploy <b>now</b> (value: deploy-prod)", ts: "2026-10-16T00:01:00.000Z", ...extra });

describe("the page draws a click as a chip", () => {
  it("🔘 and the label, escaped — never the value; live, it shows the reply its buttons were on", () => {
    const { list, thread } = threadAt();
    thread.render([agent, click({ click: { label: "Deploy <b>now</b>", of: SET } })]);
    const chip = list.children[1].querySelector(".click-chip") as any;
    expect(chip.textContent).toBe("🔘Clicked: Deploy <b>now</b>");
    expect(list.children[1].textContent).not.toContain("deploy-prod");
    expect(list.children[1].querySelector("b")).toBeNull();
    const link = chip.querySelector("button.click-link");
    expect(link.getAttribute("data-arg")).toBe(SET);
    let shown = 0;
    list.children[0].scrollIntoView = () => { shown++; };
    thread.onClick({ target: link });
    expect([shown, list.children[0].classList.contains("flash")]).toEqual([1, true]);
  });
  it("a restored click (no set): plain, not a button; a click from another person (Discord, Telegram) is a chip too", () => {
    const { list, thread } = threadAt();
    thread.render([click({ click: { label: "Deploy" } }, "alice")]);
    expect([list.querySelector(".click-chip .click-text")?.textContent, list.querySelector("button.click-link")]).toEqual(["🔘Clicked: Deploy", null]);
  });
  it("a person's message without a click is Markdown as before; an agent's `click` is ignored", () => {
    const { list, thread } = threadAt();
    thread.render([click({}), { ...agent, id: 3, buttons: undefined, click: { label: "nope" } }]);
    expect([list.children[0].querySelector(".click-chip"), list.children[0].querySelector(".md")?.textContent]).toEqual([null, "[button] Deploy <b>now</b> (value: deploy-prod)"]);
    expect(list.children[1].querySelector(".click-chip")).toBeNull();
  });
});
