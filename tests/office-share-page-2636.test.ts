/**
 * #2636 part 2: an Office share link's page — the static files it may load (exactly the page module's import closure),
 * the fixed page and its policy, and the page module: the Office's reads sent to the share's addresses (any other
 * refused), the share's state into the app store's shape, and the page itself (the office, then "ended" on a 404).
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OFFICE_SHARE_PAGE, OFFICE_SHARE_PAGE_CSP, SHARE_ASSETS, SHARE_MODULES, officeShareStatic } from "../src/office-share-page.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const UI = join(__dirname, "..", "src", "ui");

/** The static import closure of a module under src/ui, as the browser resolves it (/assets → shared, /ui/js → ui). */
function closure(entry: string): Set<string> {
  const seen = new Set<string>(), stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|(?:^|\n)\s*import\s+"([^"]+)"/g)) {
      const spec = (m[1] ?? m[2])!;
      const to = spec.startsWith("/assets/") ? join(UI, "shared", spec.slice(8)) : spec.startsWith("/ui/js/") ? join(UI, spec.slice(7))
        : spec.startsWith(".") ? normalize(join(dirname(file), spec)) : null;
      if (to) stack.push(to);
    }
  }
  return seen;
}

describe("the share page's static files (#2636)", () => {
  it("are exactly the page module's import closure, and its stylesheets and font", () => {
    const files = [...closure(join(UI, "office-share-page.js"))];
    const shared = files.filter(f => dirname(f) === join(UI, "shared")).map(f => f.slice(join(UI, "shared").length + 1)).sort();
    const own = files.filter(f => dirname(f) === UI).map(f => f.slice(UI.length + 1)).sort();
    expect(files.length).toBe(shared.length + own.length);
    expect(Object.keys(SHARE_ASSETS).filter(n => n.endsWith(".js")).sort()).toEqual(shared);
    expect([...SHARE_MODULES].sort()).toEqual(own);
    expect(Object.keys(SHARE_ASSETS).filter(n => !n.endsWith(".js")).sort()).toEqual(["app.css", "inter.woff2", "tokens.css"]);
  });

  it("are served by name (the bytes on disk), and nothing else", () => {
    expect(officeShareStatic("/assets/app-html.js")?.body.equals(readFileSync(join(UI, "shared", "app-html.js")))).toBe(true);
    expect(officeShareStatic("/ui/js/fleet-office.js")?.type).toBe("text/javascript; charset=utf-8");
    expect(officeShareStatic("/assets/inter.woff2")?.type).toBe("font/woff2");
    expect(officeShareStatic("/assets/app.css")?.type).toBe("text/css; charset=utf-8");
    for (const no of ["/assets/app.js", "/assets/agend-auth.js", "/ui/js/panel-settings.js", "/ui/js/panel-fleet.js", "/assets/../web-api.js", "/ui/js/../shared/app.js", "/ui/js/office-share-page.js.map"]) {
      expect(officeShareStatic(no), no).toBeNull();
    }
    for (const name of Object.keys(SHARE_ASSETS)) expect(existsSync(join(UI, "shared", name === "inter.woff2" ? join("fonts", name) : name)), name).toBe(true);
    for (const name of SHARE_MODULES) expect(existsSync(join(UI, name)), name).toBe(true);
  });

  it("the page: no inline script, no data; its policy allows only its own files and reads", () => {
    expect(OFFICE_SHARE_PAGE).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(OFFICE_SHARE_PAGE).toContain('<script type="module" src="/ui/js/office-share-page.js"></script>');
    expect(OFFICE_SHARE_PAGE).toContain('data-share="1"');
    expect(OFFICE_SHARE_PAGE_CSP).toContain("script-src 'self';");
    expect(OFFICE_SHARE_PAGE_CSP).toContain("connect-src 'self';");
    expect(OFFICE_SHARE_PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(OFFICE_SHARE_PAGE_CSP).not.toContain("unsafe");
  });
});

describe("the share page module (#2636)", () => {
  const TOKEN = "A".repeat(43), BASE = `/o/${TOKEN}`;
  let p: AppPage, S: any, app: any;
  beforeAll(async () => {
    p = page({ url: `https://abc.trycloudflare.com${BASE}` });
    app = await import("/assets/app-store.js");
    S = await import("/ui/js/office-share-page.js");
  });
  afterAll(() => p.restore());

  it("finds its share in the address", () => {
    expect(S.shareBase(BASE)).toBe(BASE);
    expect(S.shareBase(`${BASE}/`)).toBe(BASE);
    expect(S.shareBase(`${BASE}/state`)).toBeNull();
    expect(S.shareBase("/o/short")).toBeNull();
  });

  it("sends the Office's reads to the share's addresses, and refuses every other", async () => {
    expect(S.shareUrl(BASE, "/ui/offices")).toBe(`${BASE}/offices`);
    expect(S.shareUrl(BASE, "/ui/office-acts")).toBe(`${BASE}/office-acts`);
    expect(S.shareUrl(BASE, "/ui/office-skins")).toBe(`${BASE}/office-skins`);
    expect(S.shareUrl(BASE, "/ui/office-skins/p1?v=abc")).toBe(`${BASE}/office-skins/p1?v=abc`);
    expect(S.shareUrl(BASE, "/ui/office-skins/p1/img/" + "0".repeat(32) + ".png")).toBe(`${BASE}/office-skins/p1/img/${"0".repeat(32)}.png`);
    for (const no of ["/ui/org", "/ui/poll", "/ui/office-skinsX", "/api/fleet", "/ui/offices/x"]) expect(S.shareUrl(BASE, no), no).toBeNull();
    const asked: string[] = [];
    const timers = { ...globalThis, fetch: async (u: string) => { asked.push(u); return { ok: true, status: 200, json: async () => ({}) }; } };
    const lease = S.shareLease(BASE, timers);
    await lease.fetch("/ui/offices");
    const refused = await lease.fetch("/ui/org");
    expect(asked).toEqual([`${BASE}/offices`]);
    expect(refused.status).toBe(404);
    lease.dispose();
  });

  it("takes the share's state as the app store does (only that someone waits, not on what)", () => {
    const a = S.appFromState({ instances: [{ name: "x", execution_state: "working" }, { name: "y", state: "awaiting_input", interaction_summary: "Allow?" }], needs: [{ instance: "x" }] });
    expect(a).toEqual({ ready: true, instances: [{ name: "x", execution_state: "working" }, { name: "y", state: "awaiting_input", interaction_summary: "Allow?" }],
      exec: { x: "working", y: "awaiting_input" }, awaiting: { y: "" }, needs: [{ instance: "x" }], connection: "polling" });
  });

  it("shows the office from the share's reads, read-only, then says the link ended on a 404 (and stops asking)", async () => {
    const state = { instances: [{ name: "dev-a", display_name: "Ada", status: "running", execution_state: "working" }],
      org: { general: [], teams: [{ name: "dev", members: ["dev-a"] }], instances: {} }, needs: [], traffic: { now: "t", items: [] }, office: "hq", ends: Date.now() + 3_600_000 };
    let alive = true;
    const asked: string[] = [];
    const reply = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body });
    const timers = { ...globalThis, fetch: async (u: string) => {
      asked.push(u);
      if (!alive) return reply(404, {});
      if (u === `${BASE}/state`) return reply(200, state);
      if (u === `${BASE}/offices`) return reply(200, { rev: 1, offices: [{ id: "hq", name: "HQ", skin: "pixel", members: [] }], readable: true });
      if (u === `${BASE}/office-acts`) return reply(200, { acts: [], now: Date.now() });
      if (u === `${BASE}/office-skins`) return reply(200, { packs: [] });
      return reply(404, {});
    } };
    await p.mount(h(S.SharePage, { base: BASE, timers, pollMs: 40 }));
    await settle(); await settle();
    const text = p.root.textContent;
    expect(text).toContain("Office");
    expect(text).toContain("Read-only");
    expect(app.appStore.get().instances.map((i: { name: string }) => i.name)).toEqual(["dev-a"]);
    expect(p.root.querySelector(".oo-stage, canvas")).not.toBeNull();
    expect(p.root.querySelector(".oo-edit")).toBeNull();                 // nothing to edit
    expect(p.root.querySelector("select.oo-office").value).toBe("hq");    // it opens on the shared office
    const desk = p.root.querySelectorAll(".oo-desk").find((b: any) => b.getAttribute("data-name") === "dev-a");
    expect(desk.getAttribute("aria-label")).toContain("Ada");
    expect(desk.getAttribute("aria-label")).not.toMatch(/open ?chat/i);  // a desk opens nothing here
    desk.click(); await settle(2);
    expect(location.pathname).toBe(BASE);
    expect(asked.every(u => u.startsWith(`${BASE}/`))).toBe(true);       // nothing but the share's own reads
    alive = false;
    await new Promise(r => setTimeout(r, 120));
    await settle();
    expect(p.root.textContent).toContain("This Office link has ended.");
    const after = asked.length;
    await new Promise(r => setTimeout(r, 200));
    expect(asked.filter(u => u === `${BASE}/state`).length).toBe(asked.slice(0, after).filter(u => u === `${BASE}/state`).length);
    await p.unmount();
  });
});
