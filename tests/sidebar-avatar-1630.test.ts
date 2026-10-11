/**
 * #1630 part B (design: the comment on #1630): the sidebar calls each instance by its display name (its name on hover,
 * and on the row only when two rows share a display name), draws what the server decided stands for it (a same-origin
 * picture, an emoji, or the first character; a picture that fails to load → the first character), rings it in its
 * bot's colour (CSSOM, no style attribute in markup), and puts its status on a dot with a label — not colour alone.
 * The real Shell, store and router in the mini DOM (tests/helpers/app-harness.ts); the chat header through the real
 * ChatPanel.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fire, installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const mounted: AppPage[] = [];
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } });
async function sidebar(instances: Array<Record<string, unknown>>) {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances });
  await pg.mount(h(Shell, { panels: new Map(), onNewInstance() {} }));
  return pg;
}
const row = (pg: AppPage, name: string) => pg.root.querySelectorAll("#instanceList a.inst").find((a: any) => a.getAttribute("href").endsWith(`/${encodeURIComponent(name)}`)) as any;
const base = (name: string, extra: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", execution_state: "idle", ...extra });

describe("names", () => {
  it("the display name when there is one, else the instance name; the instance name is on hover", async () => {
    const pg = await sidebar([base("web-dev", { display_name: "Sentinel" }), base("api-server")]);
    expect([row(pg, "web-dev").querySelector(".inst-name").textContent, row(pg, "api-server").querySelector(".inst-name").textContent]).toEqual(["Sentinel", "api-server"]);
    expect(row(pg, "web-dev").getAttribute("title").split("\n").slice(0, 2)).toEqual(["Sentinel", "(web-dev)"]);
    expect([row(pg, "web-dev").querySelector(".inst-id"), row(pg, "api-server").querySelector(".inst-id")]).toEqual([null, null]);
  });
  it("two rows with the same display name each keep their instance name under it", async () => {
    const pg = await sidebar([base("rev-a", { display_name: "Reviewer" }), base("rev-b", { display_name: "Reviewer" }), base("solo", { display_name: "Solo" })]);
    expect(["rev-a", "rev-b", "solo"].map(n => row(pg, n).querySelector(".inst-id")?.textContent ?? null)).toEqual(["rev-a", "rev-b", null]);
  });
  it("the filter finds a row by either name", async () => {
    const { instanceMatchesFilter } = await import("/assets/instance-nav.js");
    const it1 = { name: "web-dev", display_name: "Sentinel" };
    expect([instanceMatchesFilter(it1, "sent"), instanceMatchesFilter(it1, "web-d"), instanceMatchesFilter(it1, "zzz")]).toEqual([true, true, false]);
  });
});

describe("the avatar", () => {
  it("draws what the server decided: a picture, an emoji (text or picture), the first character", async () => {
    const pg = await sidebar([
      base("pic", { avatar: { kind: "image", src: "/ui/img/bot/discord-2?v=abc" } }),
      base("fox", { avatar: { kind: "emoji", text: "🦊" } }),
      base("blob", { avatar: { kind: "emoji", src: "/ui/img/emoji/123456789012345678", alt: ":blob:" } }),
      base("kira", { display_name: "élan", avatar: { kind: "initial", text: "É" } }),
    ]);
    const av = (n: string) => row(pg, n).querySelector(".av");
    expect(av("pic").querySelector("img").getAttribute("src")).toBe("/ui/img/bot/discord-2?v=abc");
    expect([av("fox").querySelector(".av-text").textContent, av("fox").getAttribute("class")]).toEqual(["🦊", "av av-emoji"]);
    expect(av("blob").querySelector("img").getAttribute("src")).toBe("/ui/img/emoji/123456789012345678");
    expect(av("kira").querySelector(".av-text").textContent).toBe("É");
    // Decorative: the picture has no text of its own (the row's name says who it is).
    expect(av("pic").querySelector("img").getAttribute("alt")).toBe("");
  });
  it("no avatar in the frame (an older server, the anonymous roster): the first character of what the row is called", async () => {
    const pg = await sidebar([base("web-dev", { display_name: "  zeta" }), base("👨‍👩‍👧-team")]);
    expect([row(pg, "web-dev").querySelector(".av-text").textContent, row(pg, "👨‍👩‍👧-team").querySelector(".av-text").textContent]).toEqual(["Z", "👨‍👩‍👧"]);
  });
  it("a picture that is not a same-origin /ui/img path is never put in the page — the first character instead", async () => {
    const pg = await sidebar([
      base("cdn", { avatar: { kind: "image", src: "https://cdn.discordapp.com/avatars/1/a.png" } }),
      base("js", { avatar: { kind: "image", src: "javascript:alert(1)" } }),
      base("rel", { avatar: { kind: "emoji", src: "//evil.example/x.png", alt: ":x:" } }),
      base("other", { avatar: { kind: "image", src: "/ui/file/abc" } }),
    ]);
    for (const n of ["cdn", "js", "rel", "other"]) expect([row(pg, n).querySelector("img")?.getAttribute("src") ?? null, row(pg, n).querySelector(".av-text")?.textContent ?? null], n).toEqual([null, n[0]!.toUpperCase()]);
    for (const img of pg.root.querySelectorAll("img")) expect(img.getAttribute("src")).toMatch(/^\/ui\/img\//);
  });
  it("a picture that fails to load is replaced by the first character, never a broken image", async () => {
    const pg = await sidebar([base("pic", { display_name: "Pixel", avatar: { kind: "image", src: "/ui/img/bot/discord-2?v=abc" } })]);
    fire(row(pg, "pic").querySelector("img"), "error");
    await settle();
    expect([row(pg, "pic").querySelector("img")?.getAttribute("src") ?? null, row(pg, "pic").querySelector(".av-text")?.textContent ?? null]).toEqual([null, "P"]);
  });
});

describe("the ring", () => {
  it("its bot's colour, through the CSSOM on its picture; nothing for a malformed colour or a non-picture avatar", async () => {
    const pg = await sidebar([
      base("bot", { avatar: { kind: "image", src: "/ui/img/bot/discord-2?v=a" }, accent: "#e91e63" }),
      base("bad", { avatar: { kind: "image", src: "/ui/img/bot/discord-3?v=a" }, accent: "red; background: url(x)" }),
      base("fox", { avatar: { kind: "emoji", text: "🦊" }, accent: "#e91e63" }),
    ]);
    const av = (n: string) => row(pg, n).querySelector(".av");
    expect([av("bot").getAttribute("class"), av("bot").style["--ring"]]).toEqual(["av ring", "#e91e63"]);
    expect([av("bad").getAttribute("class"), av("bad").style["--ring"]]).toEqual(["av", undefined]);
    expect([av("fox").getAttribute("class"), av("fox").style["--ring"]]).toEqual(["av av-emoji", undefined]);
    expect(pg.root.querySelectorAll("[style]").filter((e: any) => typeof e.getAttribute("style") === "string").length, "no style attribute in markup (#1300)").toBe(0);
  });
});

describe("the status dot", () => {
  it("on the avatar: idle, working, looks stuck, paused (hollow), stopped, crashed, needs you — each with its label", async () => {
    const pg = await sidebar([
      base("i"), base("w", { execution_state: "working" }), base("s", { execution_state: "stuck" }), base("p", { status: "paused" }),
      base("o", { status: "stopped" }), base("c", { status: "crashed" }), base("n", { state: "awaiting_input", interaction_summary: "Allow?" }),
    ]);
    const dot = (n: string) => row(pg, n).querySelector(".av .av-dot");
    expect(["i", "w", "s", "p", "o", "c", "n"].map(n => [dot(n).getAttribute("class"), dot(n).getAttribute("role"), dot(n).getAttribute("aria-label"), dot(n).getAttribute("title")]))
      .toEqual([
        ["av-dot dot ok", "img", "idle", "idle"], ["av-dot dot busy", "img", "working", "working"], ["av-dot dot warn", "img", "looks stuck", "looks stuck"],
        ["av-dot dot off hollow", "img", "paused", "paused"], ["av-dot dot off", "img", "stopped", "stopped"], ["av-dot dot bad", "img", "crashed", "crashed"],
        ["av-dot dot warn", "img", "needs you", "needs you"],
      ]);
    expect(row(pg, "i").querySelectorAll(".dot").length, "one dot per row — on the avatar").toBe(1);
  });
});

describe("the chat header", () => {
  let panel: any, appStore: any;
  let current: AppPage | null = null;
  beforeAll(async () => {
    // @ts-expect-error — a JS module of the app, with no types
    await import("../src/ui/chat-render.js");
    // @ts-expect-error — a JS module of the app, with no types
    await import("../src/ui/preview.js");
    const dom = installDom({ storage: { agend_tour_done: "1" } });
    // @ts-expect-error — a JS module of the app, with no types
    panel = await import("../src/ui/panel-chat.js");
    ({ appStore } = await import("/assets/app-store.js"));
    panel.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
    dom.restore();
  });
  afterEach(async () => { await current?.unmount(); current?.restore(); current = null; });
  afterAll(() => appStore.set({ ready: false, instances: [] }));
  it("is the display name, with the instance name on hover; an instance without one keeps its name", async () => {
    appStore.set({ ready: true, instances: [{ name: "w", status: "running", display_name: "Sentinel" }, { name: "x", status: "running" }] });
    current = page({ storage: { agend_tour_done: "1" } });
    await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
    const h1 = () => current!.root.querySelector(".panel-title h1") as any;
    expect([h1().textContent, h1().querySelector("span")?.getAttribute("title")]).toEqual(["Sentinel", "w"]);
    await current.unmount();
    await current.mount(h(panel.ChatPanel, { route: { instance: "x" }, navKey: "two" }));
    expect([h1().textContent, h1().querySelector("span")]).toEqual(["x", null]);
  });
});
