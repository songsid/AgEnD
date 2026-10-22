/**
 * The page a guest's browser gets for a page it cannot open (#2399 smoke: the gate's bare JSON before). The gate's side
 * is in web-guest-access-1920.test.ts; here, what the page says: the browser's language (as the sign-in page), the
 * case the gate named ("members": a page that is not a guest's; "ended": no chat shared any more, and nothing to open).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(process.cwd(), "src", "ui", "guest-refused.html"), "utf8");
const js = readFileSync(join(process.cwd(), "src", "ui", "shared", "guest-refused.js"), "utf8");

function render(why: string, language: string) {
  const el = (attrs: Record<string, string> = {}) => ({ textContent: "", attrs, removed: false, dataset: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v; }, remove() { this.removed = true; } });
  const nodes: Record<string, ReturnType<typeof el>> = { refused: el(), title: el(), lead: el(), go: el({ href: "/ui" }) };
  nodes.refused!.dataset.why = why;
  const document = { documentElement: { lang: "en" }, title: "AgEnD", getElementById: (id: string) => nodes[id] ?? null };
  vm.runInNewContext(js, { document, navigator: { language } });
  return { lang: document.documentElement.lang, title: document.title, h1: nodes.title!.textContent, lead: nodes.lead!.textContent,
    go: nodes.go!.removed ? null : { text: nodes.go!.textContent, href: nodes.go!.attrs.href } };
}

describe("the guest's refused page", () => {
  it("the gate fills in the case; the HTML carries English for a browser without scripts, and the app's look", () => {
    expect(html).toContain('data-why="__WHY__"');
    expect(html).toContain('<link rel="stylesheet" href="/assets/tokens.css">');
    expect(html).toContain('<script src="/assets/guest-refused.js"></script>');
    expect(html).not.toMatch(/ style="/);                                           // CSP: no inline style attributes
  });

  it("a page that is not a guest's: in English, and in zh-TW on a zh browser, with the way back to its chats", () => {
    expect(render("members", "en-US")).toEqual({ lang: "en", title: "AgEnD — This page is not open to guests", h1: "This page is not open to guests",
      lead: "This page is for the fleet's members. As a guest you can use the chats shared with you.", go: { text: "Open your chats", href: "/ui" } });
    expect(render("members", "zh-TW")).toMatchObject({ lang: "zh-Hant", h1: "訪客無法開啟這個頁面", go: { text: "打開你的聊天", href: "/ui" } });
    expect(render("members", "zh-CN").lang).toBe("zh-Hant");
  });

  it("#2449: the server's no-script English for \"ended\" is the script's own English", async () => {
    const { serveGuestRefusedPage } = await import("../src/auth-api.js");
    let body = "";
    const res = { setHeader() {}, writeHead() {}, end(b: string) { body = b; } } as any;
    serveGuestRefusedPage(res, 401, "ended");
    const ended = render("ended", "en");
    expect(body).toContain(`<h1 id="title">${ended.h1}</h1>`);
    expect(body).toContain(`<p id="lead">${ended.lead}</p>`);
    expect(body).not.toContain('id="go"');
  });

  it("no chat shared any more: says so, and offers nothing to open (the chats would answer this page again)", () => {
    expect(render("ended", "en")).toMatchObject({ h1: "No chats are shared with you", go: null });
    expect(render("ended", "zh-TW")).toMatchObject({ h1: "目前沒有分享給你的聊天", go: null });
    expect(render("anything else", "en").h1).toBe("This page is not open to guests");   // an unknown case: the plain one
  });
});
