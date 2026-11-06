/**
 * #3226 E: an answer's HTML page in the Hub's side panel.
 * - the fleet's panel (preview-panel, its actions, versions, pages) is served from /assets/ to both listeners; its old
 *   /ui/js/ paths are the same module. What only the fleet shows — Files & changes (workspace-panel.js) and a page's Share
 *   (page-share-dialog.js) — is registered by the fleet's /ui/js/preview-panel.js, never imported by the core;
 * - the Hub page reaches only Hub modules and /assets/ (a static walk of every import from the Hub's list);
 * - a Hub room: the card's Open in panel opens the room's panel where the info rail was, without Share; the panel's
 *   "Reply about this page" puts its line in the room's composer (once); the info button closes the page and brings the
 *   rail back; leaving the room closes it; the page's previews follow the Hub shell's data (here: not offered, in the
 *   Hub's words); this browser's opt-in asks in the Hub's words and lives in the Hub origin's storage.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { isServedAsset } from "../src/auth-api.js";
import { HUB_UI_MODULES } from "../src/hub/http/compose.js";

const SHARED = ["preview-panel.js", "preview-panel-actions.js", "preview-versions.js", "preview-pages.js"];
const ui = (...p: string[]) => join(process.cwd(), "src", "ui", ...p);
const codeLines = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));

describe("the side panel is shared (#3226 E)", () => {
  it("each module is under shared/ and in the /assets map; the old paths re-export it; the fleet's registers its two pieces", () => {
    for (const f of SHARED) expect([f, existsSync(ui("shared", f)), isServedAsset(f)]).toEqual([f, true, true]);
    for (const f of SHARED.slice(1)) expect(codeLines(ui(f)), f).toEqual([`export * from "/assets/${f}";`]);
    expect(codeLines(ui("preview-panel.js"))).toEqual([
      'import { setWorkspaceView } from "/assets/preview-panel.js";',
      'import { setShareButton } from "/assets/preview-panel-actions.js";',
      'import { WorkspacePanel } from "./workspace-panel.js";',
      'import { PageShareButton } from "./page-share-dialog.js";',
      "setWorkspaceView(WorkspacePanel);",
      "setShareButton(PageShareButton);",
      'export * from "/assets/preview-panel.js";',
    ]);
  });
  it("the core imports nothing of the fleet's", () => {
    for (const f of SHARED) {
      const imports = codeLines(ui("shared", f)).filter((l) => /^\s*import\b/.test(l)).join("\n");
      expect(imports, f).not.toMatch(/workspace-panel|page-share|\/ui\/js\//);
    }
  });
  it("the old path and /assets are one module (one instance)", async () => {
    const pairs = [["preview-panel.js", "openPanel"], ["preview-panel-actions.js", "setPanelFeedback"], ["preview-versions.js", "versionsOf"], ["preview-pages.js", "pagesOf"]] as const;
    for (const [f, name] of pairs) {
      const old = await import(/* @vite-ignore */ `/ui/js/${f}`), shared = await import(/* @vite-ignore */ `/assets/${f}`);
      expect(old[name], f).toBe(shared[name]);
    }
  });
});

describe("what the Hub page reaches", () => {
  /** Every module the Hub's own list imports statically, followed to the end: url → file. (hub-client.js's import() of
   *  settings-confirm.js is the member fleet's card only, never the Hub's page.) */
  function closure() {
    const seen = new Map<string, string>(), todo = HUB_UI_MODULES.map((f) => `/ui/js/${f}`);
    const fileOf = (url: string) => (url.startsWith("/assets/") ? ui("shared", url.slice(8)) : url.startsWith("/ui/js/") ? ui(url.slice(7)) : null);
    while (todo.length) {
      const url = todo.pop()!;
      if (seen.has(url)) continue;
      const file = fileOf(url);
      seen.set(url, file ?? "");
      if (!file || !existsSync(file)) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:\bfrom\s*|^import\s*)["']([^"']+\.js)["']/gm)) {
        const spec = m[1]!;
        todo.push(spec.startsWith("/") ? spec : posix.join(posix.dirname(url), spec));
      }
    }
    return seen;
  }
  it("only Hub modules and /assets/: the panel's core, never Files & changes or Share", () => {
    const urls = [...closure().keys()];
    for (const u of urls) {
      if (u.startsWith("/assets/")) expect([u, isServedAsset(u.slice(8))]).toEqual([u, true]);
      else expect([u, HUB_UI_MODULES.includes(u.replace(/^\/ui\/js\//, ""))]).toEqual([u, true]);
    }
    expect(urls).toEqual(expect.arrayContaining(["/ui/js/hub-preview.js", "/assets/preview-panel.js", "/assets/preview-panel-actions.js"]));
    expect(urls.filter((u) => /workspace-panel|page-share/.test(u))).toEqual([]);
  });
});

let client: any, router: any, i18n: any, hubPanel: any, pp: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); expect(fn(), "waited for").toBeTruthy(); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  router = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  client = await import("/ui/js/hub-client.js");
  hubPanel = await import("/ui/js/panel-hub.js");
  pp = await import("/assets/preview-panel.js");
  pg.restore();
});
afterEach(async () => {
  g.confirm = undefined;
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  client.setHubClient(null); pp.closePanel(); i18n.setLang("en", { store: false });
});

describe("a Hub room's HTML page in the side panel", () => {
  const R1 = "11111111-2222-4333-8444-555555555555";
  const SIGNED = { signedIn: true, displayName: "Alex", login: "alex", admin: false, csrf: "c".repeat(64), hub: { name: "Team Hub" } };
  const PAGE = "<!doctype html><title>Q3 report</title><h1>Q3</h1>";
  const room = { id: R1, exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", exposureState: "published",
    grantExpiresAt: 2_000_000_000_000, lastAt: 1, waiting: false, features: [] };
  function hubApi() {
    const fetchImpl = async (path: string, init: any = {}) => {
      const key = `${init.method || "GET"} ${path.split("?")[0]}`;
      const routes: Record<string, [number, unknown]> = {
        "GET /hub/v1/session": [200, SIGNED],
        "GET /hub/v1/exposures": [200, { mine: [], askable: [] }],
        "GET /hub/v1/rooms": [200, { rooms: [room] }],
        [`GET /hub/v1/rooms/${R1}/messages`]: [200, { room, entries: [{ messageId: "m1", sequence: 1, askedAt: 1, receipt: { stage: "answered", at: 2 },
          question: "The Q3 page?", answer: `Here it is.\n\n\`\`\`html\n${PAGE}\n\`\`\`` }] }],
      };
      const [status, json] = routes[key] ?? [404, { code: "not-found" }];
      return { ok: status < 300, status, json: async () => json, headers: { get: () => null } };
    };
    client.setHubClient(client.createHubWebClient({ fetchImpl }));
    hubPanel.resetHubSession();
  }
  async function openRoom(dataset: Record<string, string> = { "data-preview-reason-code": "notOffered", "data-preview-reason": "" }, storage: Record<string, string> = {}) {
    hubApi();
    const pg = page({ url: `http://127.0.0.1:19280/ui/hub?room=${R1}`, storage: { agend_tour_done: "1", ...storage } });
    pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub");
    for (const [k, v] of Object.entries(dataset)) pg.document.body.setAttribute(k, v);
    mounted.push(pg);
    // A desktop (≥ 1100 px): the room shows its info rail.
    g.matchMedia = (q: string) => ({ matches: /min-width/.test(q), addEventListener() {}, removeEventListener() {} });
    router.startRouter(pg.window);
    await pg.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab: "ask" }, navKey: "hub:ask|1|en" }));
    await until(() => pg.root.querySelector(".msg.agent .pv-open"));
    return pg;
  }
  const $ = (pg: AppPage, sel: string) => pg.root.querySelector(sel) as any;
  /** A card's button: chat-thread sets its onclick (the mini DOM's click() runs listeners only). */
  const press = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(10); };

  it("Open in panel: the room's panel where the rail was, without Share; Reply about this page fills the composer once; info brings the rail back", async () => {
    const pg = await openRoom();
    expect($(pg, ".hub-chat > .u-rail")).toBeTruthy();
    await press($(pg, ".msg.agent .pv-open"));
    await until(() => $(pg, ".hub-chat > .pv-panel"));
    expect([$(pg, ".hub-chat > .u-rail"), $(pg, ".hub-chat").classList.contains("with-rail")]).toEqual([null, false]);
    expect(pp.panelStore.get().open.instance).toBe(`hub-room:${R1}`);
    expect(pg.root.querySelectorAll(".pv-fb-share, .pv-fb-shared")).toHaveLength(0);
    // Previews are not offered by this Hub's shell: said in the Hub's words, nothing runs.
    expect($(pg, ".pv-panel").textContent).toContain("Previews are not offered on this Hub.");
    expect(pg.root.querySelectorAll("iframe")).toHaveLength(0);
    $(pg, ".pv-fb-reply").click(); await settle(10);
    $(pg, ".pv-fb-reply").click(); await settle(10);
    expect($(pg, "#msgIn").value).toBe(i18n.t("chat.pvFbAboutNamed", "Q3 report"));
    const info = pg.root.querySelector('.hub-chat-head button[aria-pressed]') as any;
    expect(info.getAttribute("aria-pressed")).toBe("false");
    info.click();
    await until(() => $(pg, ".hub-chat > .u-rail"));
    expect([$(pg, ".pv-panel"), pp.shownKey(), info.getAttribute("aria-pressed")]).toEqual([null, null, "true"]);
  });

  it("leaving the room closes its page and lets go of the composer", async () => {
    const pg = await openRoom();
    await press($(pg, ".msg.agent .pv-open"));
    await until(() => $(pg, ".pv-panel"));
    await pg.unmount();
    expect(pp.shownKey()).toBe(null);
    const actions = await import("/assets/preview-panel-actions.js");
    expect(actions.replyAboutPage({ key: "k", instance: "x", msgKey: "hub-2", code: PAGE })).toBe(false);
  });

  it("this browser's opt-in asks in the Hub's words and is kept in this origin's storage; Cancel keeps it off", async () => {
    const pg = await openRoom({ "data-preview-origin": "https://127.0.0.1:19281", "data-preview-boot": "a".repeat(32), "data-dashboard-origin": "http://127.0.0.1:19280" });
    const P = g.AgendPreview;
    expect([P.availability().ok, P.availability().why]).toEqual([false, "optin"]);
    expect(P.availability().reason).toBe("Previews are off in this browser. Allow them from the card's menu.");
    // The harness answers the app's confirm dialog with globalThis.confirm (tests/helpers/app-harness.ts).
    const asked: string[] = []; let yes = false;
    g.confirm = (m: string) => { asked.push(m); return yes; };
    await press($(pg, ".msg.agent .pv-opt")); await settle(10);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("This applies to this Hub in this browser only.");
    expect(asked[0]).not.toContain("every device");
    expect([P.optedIn(), g.localStorage.getItem("agend_html_preview")]).toEqual([false, null]);
    yes = true;
    await press($(pg, ".msg.agent .pv-opt")); await settle(10);
    expect([P.optedIn(), g.localStorage.getItem("agend_html_preview"), P.availability().ok]).toEqual([true, "on", true]);
  });

  it("zh-TW: not offered, in the Hub's words", async () => {
    i18n.setLang("zh-TW", { store: false });
    const pg = await openRoom();
    await press($(pg, ".msg.agent .pv-open"));
    await until(() => $(pg, ".pv-panel"));
    expect($(pg, ".pv-panel").textContent).toContain("這個 Hub 不提供預覽。");
  });
});
