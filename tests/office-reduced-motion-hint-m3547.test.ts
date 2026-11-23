/**
 * M-3547: with reduced motion on, drag, pat and feed are off in the Office (playAllowed) — and the Office now says so
 * without hovering: a line on the person's card where Pat and Feed would be, and a note beside the greyed "Drag and
 * pat" tick box. A hint only: nothing can turn play on while reduced motion is on. Without reduced motion nothing
 * changes; where play is off for another reason (the viewer's own toggle, All offices, a share link or a room) nothing
 * is said.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDisplay } from "./helpers/office-display.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { MiniElement } from "./helpers/mini-dom.js";

const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill"] }], instances: {} };

function fakeCtx() {
  const t: any = { measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }),
    getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(w * hh * 4) }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
}

let p: AppPage, P: any, app: any, nav: any, fleet: any, I: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? { rev: 0, offices: [] } : url === "/ui/office-skins" ? { rev: "", packs: [] } : {}) });
  P = await import("/ui/js/fleet-office-play.js");
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  I = await import("/assets/app-i18n.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
});
afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });

describe("playOffForMotion", () => {
  const ok = { on: true, still: true, zones: true, overview: false, layout: false, shared: false };
  it("true only when reduced motion is the one thing keeping play off", () => {
    expect(P.playOffForMotion(ok)).toBe(true);
    expect(P.playAllowed(ok)).toBe(false);
    for (const [k, v] of [["still", false], ["on", false], ["zones", false], ["overview", true], ["layout", true], ["shared", true]] as const)
      expect(P.playOffForMotion({ ...ok, [k]: v }), k).toBe(false);
  });
});

describe("the hint on the page", () => {
  const proto = MiniElement.prototype as any;
  let realMM: any;
  const motion = (reduce: boolean) => { (globalThis as any).matchMedia = (q: string) => ({ matches: reduce && /reduce/.test(q), addEventListener() {}, removeEventListener() {} }); };
  beforeEach(async () => {
    await p.unmount(); p.storage.clear();
    realMM = (globalThis as any).matchMedia;
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
    localStorage.setItem("agend_org_office_skin", "studio");                 // a zones style: play is offered
    nav.navigate("/ui/fleet/org");
    app.appStore.set({ ready: true, instances: INSTANCES, exec: { quill: "working" }, awaiting: {}, needs: [] });
  });
  afterEach(() => { delete proto.getContext; (globalThis as any).matchMedia = realMM; I.setLang("en", { store: false }); });
  const office = async (lang = "en") => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|${lang}` })); await settle(6);
    p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(6);
    await openDisplay(p.root);                                              // M-3556: Drag and pat is in ⚙ Display options
  };
  const openCard = async (name = "atlas") => { p.root.querySelector(`.oo-desk[data-name="${name}"]`).click(); await settle(4); };
  const cardNote = () => p.root.querySelector(".oo-card .oo-card-play-off");
  const barNote = () => p.root.querySelector(".oo-play-still");
  const box = () => p.root.querySelector(".oo-play input");

  it("reduced motion: the card says why, where Pat and Feed would be; the tick box has a note beside it", async () => {
    motion(true);
    await office();
    expect(box().disabled).toBe(true);
    expect(barNote().textContent.trim()).toBe("Off while reduced motion is on");
    expect(barNote().parentNode.className).toContain("oo-play");                 // inside the box's label: kept beside it
    await openCard();
    expect(cardNote().textContent.trim()).toBe("Drag, pat and feed are off: this device asks for reduced motion.");
    expect(cardNote().parentNode.className).toContain("oo-card-actions");
    expect(p.root.querySelector(".oo-card-pat")).toBeNull();
    expect(p.root.querySelector(".oo-card-feed")).toBeNull();
  });

  it("zh-TW: the same in the page's language", async () => {
    motion(true);
    I.setLang("zh-TW", { store: false });
    await office("zh-TW");
    expect(barNote().textContent.trim()).toBe("開啟「減少動態效果」時關閉");
    await openCard();
    expect(cardNote().textContent.trim()).toBe("拖曳、摸頭與餵點心已關閉：這台裝置開啟了「減少動態效果」。");
    // Never broken inside the term, nor right before it (a line starting with 「): kept with the words before it.
    expect(cardNote().querySelector(".oo-nowrap").textContent).toBe("開啟了「減少動態效果」。");
  });

  it("without reduced motion nothing changes: no note, Pat and Feed on the card", async () => {
    motion(false);
    await office();
    expect(box().disabled).toBe(false);
    expect(barNote()).toBeNull();
    await openCard();
    expect(cardNote()).toBeNull();
    expect(p.root.querySelector(".oo-card-pat")).not.toBeNull();
  });

  it("the viewer turned Drag and pat off themselves: no hint (reduced motion is not why)", async () => {
    motion(true);
    localStorage.setItem("agend_org_office_play", "0");
    await office();
    expect(barNote()).toBeNull();
    await openCard();
    expect(cardNote()).toBeNull();
  });

  it("a style without zones (no play offered): no hint", async () => {
    motion(true);
    localStorage.setItem("agend_org_office_skin", "pixel");
    await office();
    expect(p.root.querySelector(".oo-play")).toBeNull();
    expect(barNote()).toBeNull();
    await openCard();
    expect(cardNote()).toBeNull();
  });
});
