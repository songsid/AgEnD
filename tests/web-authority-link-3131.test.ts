/**
 * M-3131: the chat's "Not verified · Settings" link (web-authorize.js) lands on the Web authority card itself. Since
 * Access & security has tabs, /settings/access opened its Overview, where the card (on the Sign-in tab) is hidden; the
 * link names the card (#webAuthority), and Settings' hash reveal opens the tab that owns it. The card carries the id
 * from its first paint (its loading state too), so the reveal finds it at once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const src = (p: string) => readFileSync(join(process.cwd(), "src/ui", p), "utf8");

describe("M-3131: the chat's Settings link lands on the Web authority card", () => {
  it("every Settings link of the authorization line names the card", () => {
    const links = src("shared/web-authorize.js").match(/href="\/settings\/access[^"]*"/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    expect(new Set(links)).toEqual(new Set(['href="/settings/access#webAuthority"']));
  });
  it("the card's one wrapper (loading, failed, loaded) carries the id", () => {
    expect(src("settings-web-authority.js")).toContain('const card = (body) => html`<section class="card s-web-authority" id="webAuthority">');
  });
});

describe("M-3131: an app link into Settings keeps its place (the router)", () => {
  const mounted: AppPage[] = [];
  afterEach(() => { for (const p of mounted.splice(0)) p.restore(); });
  async function click(href: string) {
    const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    const { startRouter } = await import("/assets/app-nav.js");
    startRouter(pg.window);
    const a = pg.document.createElement("a"); a.setAttribute("href", href); pg.document.body.appendChild(a);
    const e = fire(a, "click", { button: 0 });
    return { prevented: e.defaultPrevented, at: pg.window.location.pathname + pg.window.location.hash };
  }
  it("/settings/access#webAuthority: in-app, with its hash (Settings reveals the tab that owns it)", async () => {
    expect(await click("/settings/access#webAuthority")).toEqual({ prevented: true, at: "/settings/access#webAuthority" });
  });
  it("elsewhere the hash stays the browser's business, as before (/ui/fleet#x → /ui/fleet)", async () => {
    expect(await click("/ui/fleet#x")).toEqual({ prevented: true, at: "/ui/fleet" });
  });
});
