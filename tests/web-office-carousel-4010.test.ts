/**
 * #4010: the Office view's carousel — chosen offices, one full-size office in turn.
 * - The switcher offers Carousel… with two or more offices (kept as the office pick).
 * - Tick offices and pick an interval; each office is the ordinary full-size view (no All offices tiles).
 * - Pause / Next on the bar; Space / arrows / N at document level (a remote without canvas focus).
 * - Offices and interval kept per browser; playing starts on enter.
 * - Edit offices waits; EN and zh-TW.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";

const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
  { name: "sage", status: "paused", backend: "grok" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill", "sage"] }], instances: {} };
const STORE = { ready: true, instances: INSTANCES, exec: { quill: "working" }, awaiting: {}, needs: [] };
const TWO = [
  { id: "front", name: "Front desk", skin: "pixel", members: ["atlas"] },
  { id: "lab", name: "Lab", skin: "pixel", members: ["quill"] },
];
const THREE = [...TWO, { id: "ward", name: "Ward", skin: "pixel", members: ["sage"] }];

let p: AppPage;
let F: any, S: any, app: any, nav: any, fleet: any;
let offices: any = { rev: 0, offices: [] };
const fetched: string[] = [];
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string, o: any = {}) => {
    fetched.push(url);
    if (url === "/ui/offices" && o.method === "PUT") return { ok: true, status: 200, json: async () => offices };
    return { ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? offices : url === "/ui/office-skins" ? { rev: "", packs: [] } : {}) };
  };
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  await import("/ui/js/fleet-org.js");
  F = await import("/ui/js/fleet-office.js");
  S = await import("/ui/js/fleet-office-store.js");
});
afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  p.storage.clear();
  offices = { rev: 0, offices: [] }; fetched.length = 0;
  nav.navigate("/ui/fleet/org");
  app.appStore.set(STORE);
});

function fakeCtx() {
  const calls: Array<[string, any[], any?]> = [];
  const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }),
    getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(w * hh * 4) }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a, k === "fillRect" ? o.fillStyle : undefined]); }; }, set(o, k, v) { o[k] = v; return true; } });
}

describe("Carousel on the page", () => {
  const proto = MiniElement.prototype as any;
  beforeEach(() => { proto.getContext = function () { return (this._ctx ??= fakeCtx()); }; });
  afterEach(() => { delete proto.getContext; delete (globalThis as any).AgendAuth; delete (p.window as any).AgendAuth; });
  const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6); };
  const office = async () => { await mount(); p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(6); };
  const sw = () => p.root.querySelector(".oo-office");
  const options = () => sw().querySelectorAll("option").map((o: any) => [o.getAttribute("value") ?? o.value, o.textContent.trim()]);
  const choose = async (v: string) => { const s = sw(); s.value = v; fire(s, "change"); await settle(6); };
  const who = () => p.root.querySelectorAll(".oo-desk").map((d: any) => d.getAttribute("data-name"));
  const now = () => p.root.querySelector(".oo-car-now")?.textContent?.trim() ?? "";
  const pickBtn = () => p.root.querySelector(".oo-car-offices");
  const openPick = async () => { pickBtn().click(); await settle(4); };
  const ticks = () => p.root.querySelectorAll(".oo-carousel-offices input").map((el: any) => [el.parentNode.textContent.trim(), el.checked]);

  it("the switcher: Carousel only with two or more offices; picked, it is kept per device; with one it is gone", async () => {
    offices = { rev: 1, offices: [TWO[0]] };
    await office();
    expect(options().map(([, t]: any) => t)).toEqual(["Whole fleet", "Front desk"]);
    await p.unmount();
    offices = { rev: 2, offices: TWO };
    await office();
    expect(options()).toEqual([["auto", "Whole fleet"], ["*all", "All offices"], ["*carousel", "Carousel…"], ["front", "Front desk"], ["lab", "Lab"]]);
    await choose("*carousel");
    expect([sw().value, localStorage.getItem("agend_org_office")]).toEqual(["*carousel", "*carousel"]);
    expect(p.root.querySelector(".oo-canvas").getAttribute("aria-label")).toContain("Carousel");
    expect(p.root.querySelectorAll(".oo-tile-label")).toHaveLength(0);   // the full office, not All offices' tiles
    expect(who()).toEqual(["atlas"]);                                    // Front desk first (stored order)
    expect(now()).toContain("Front desk");
    expect(now()).toContain("Playing");
    expect(pickBtn().textContent.trim()).toBe("Carousel 2/2 offices ▾");
    expect(p.root.querySelector(".oo-carousel-offices")).toBeNull();
    await openPick();
    expect(ticks()).toEqual([["Front desk", true], ["Lab", true]]);
    const kept = JSON.parse(localStorage.getItem("agend_org_office_carousel")!);
    expect(kept).toEqual({ ids: ["front", "lab"], interval: 30 });
    await p.unmount(); await office();
    expect([sw().value, who()]).toEqual(["*carousel", ["atlas"]]);
    await p.unmount();
    offices = { rev: 3, offices: [TWO[1]] };
    await office();
    expect([sw().value, options().map(([, t]: any) => t), p.root.querySelector(".oo-carousel")]).toEqual(["auto", ["Whole fleet", "Lab"], null]);
  });

  it("Next and Pause on the bar; Space and arrows from the document (a remote, no canvas focus)", async () => {
    offices = { rev: 2, offices: TWO };
    await office();
    await choose("*carousel");
    expect(who()).toEqual(["atlas"]);
    p.root.querySelector(".oo-car-next").click(); await settle(6);
    expect(who()).toEqual(["quill"]);
    expect(now()).toContain("Lab");
    p.root.querySelector(".oo-car-next").click(); await settle(6);
    expect(who()).toEqual(["atlas"]);                                    // wraps
    p.root.querySelector(".oo-car-pause").click(); await settle(4);
    expect(now()).toContain("Paused");
    expect(p.root.querySelector(".oo-car-pause").textContent.trim()).toBe("Play");
    fire(p.window.document.body, "keydown", { key: " " }); await settle(4);
    expect(now()).toContain("Playing");
    fire(p.window.document.body, "keydown", { key: "ArrowRight" }); await settle(6);
    expect(who()).toEqual(["quill"]);
    fire(p.window.document.body, "keydown", { key: "ArrowLeft" }); await settle(6);
    expect(who()).toEqual(["atlas"]);
    fire(p.window.document.body, "keydown", { key: "n" }); await settle(6);
    expect(who()).toEqual(["quill"]);
  });

  it("unticking an office drops it; the interval is kept; Edit offices waits", async () => {
    const auth = { canWrite: async () => true };
    (globalThis as any).AgendAuth = auth; (p.window as any).AgendAuth = auth;
    offices = { rev: 2, offices: THREE };
    await office();
    await choose("*carousel");
    expect(who()).toEqual(["atlas"]);
    await openPick();
    const boxes = p.root.querySelectorAll(".oo-carousel-offices input");
    fire(boxes[0], "change"); await settle(6);                           // drop Front desk: Lab is now first
    expect(who()).toEqual(["quill"]);
    expect(JSON.parse(localStorage.getItem("agend_org_office_carousel")!).ids).toEqual(["lab", "ward"]);
    const iv = p.root.querySelector(".oo-car-interval");
    iv.value = "120"; fire(iv, "change"); await settle(4);
    expect(JSON.parse(localStorage.getItem("agend_org_office_carousel")!)).toEqual({ ids: ["lab", "ward"], interval: 120 });
    const edit = p.root.querySelector(".oo-edit");
    expect(edit.disabled).toBe(true);
    expect(edit.getAttribute("title")).toContain("carousel");
  });

  function spyInterval() {
    const real = globalThis.setTimeout.bind(globalThis);
    const realClear = globalThis.clearTimeout.bind(globalThis);
    const live = new Map<any, { fn: () => void; ms: number }>();
    let seq = 0;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms?: number, ...a: any[]) => {
      if (typeof ms === "number" && ms >= 15_000 && ms <= 600_000) {
        const id = { fake: ++seq };
        live.set(id, { fn, ms });
        return id as any;
      }
      return real(fn, ms as number, ...a);
    });
    const cspy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((id: any) => {
      if (id && typeof id === "object" && "fake" in id) { live.delete(id); return; }
      return realClear(id);
    });
    return {
      live,
      restore: () => { spy.mockRestore(); cspy.mockRestore(); },
      last: () => [...live.values()].at(-1),
    };
  }

  it("advances after the interval while playing, and not while paused", async () => {
    offices = { rev: 2, offices: TWO };
    await office();
    await choose("*carousel");
    const t = spyInterval();
    try {
      const iv = p.root.querySelector(".oo-car-interval");
      iv.value = "15"; fire(iv, "change"); await settle(4);
      expect(t.last()?.ms).toBe(15_000);
      t.last()!.fn(); await settle(6);
      expect(who()).toEqual(["quill"]);
      p.root.querySelector(".oo-car-pause").click(); await settle(4);
      expect(t.live.size).toBe(0);
      expect(now()).toContain("Paused");
      expect(who()).toEqual(["quill"]);
      p.root.querySelector(".oo-car-pause").click(); await settle(4);    // resume: a new timeout
      expect(t.live.size).toBe(1);
      expect(t.last()?.ms).toBe(15_000);
    } finally { t.restore(); }
  });

  it("Next resets the interval timer (the old timeout is cleared)", async () => {
    offices = { rev: 2, offices: TWO };
    await office();
    await choose("*carousel");
    const t = spyInterval();
    try {
      const iv = p.root.querySelector(".oo-car-interval");
      iv.value = "15"; fire(iv, "change"); await settle(4);
      expect(t.live.size).toBe(1);
      const first = [...t.live.keys()][0];
      p.root.querySelector(".oo-car-next").click(); await settle(6);
      expect(who()).toEqual(["quill"]);
      expect(t.live.has(first)).toBe(false);
      expect(t.live.size).toBe(1);
      expect(t.last()?.ms).toBe(15_000);
      t.last()!.fn(); await settle(6);
      expect(who()).toEqual(["atlas"]);
    } finally { t.restore(); }
  });

  it("Space on a ticked office or a button does not drive the carousel", async () => {
    offices = { rev: 2, offices: TWO };
    await office();
    await choose("*carousel");
    expect(now()).toContain("Playing");
    expect(who()).toEqual(["atlas"]);
    await openPick();
    const box = p.root.querySelector(".oo-carousel-offices input");
    fire(box, "keydown", { key: " " }); await settle(4);
    expect(now()).toContain("Playing");
    expect(who()).toEqual(["atlas"]);
    fire(p.root.querySelector(".oo-car-next"), "keydown", { key: "ArrowRight" }); await settle(6);
    expect(who()).toEqual(["atlas"]);                                    // the button keeps the arrow
    fire(p.window.document.body, "keydown", { key: "ArrowRight" }); await settle(6);
    expect(who()).toEqual(["quill"]);                                    // nothing focused: the remote still steps
  });

  it("a share (opening set) never offers Carousel, even if the pick is forced", async () => {
    offices = { rev: 2, offices: TWO };
    const org = await import("/ui/js/fleet-org.js");
    const ctx = await import("/assets/app-ctx.js");
    const view = org.buildOrgView(ORG, app.appStore.get());
    const lease = ctx.createLease();
    try {
      await p.mount(h(F.Office, { view, opening: "front", lease })); await settle(6);
      expect(options().map(([v]: any) => v)).toEqual(["auto", "*all", "front", "lab"]);
      expect(p.root.querySelector(".oo-carousel")).toBeNull();
      const s = sw();
      s.value = "*carousel"; fire(s, "change"); await settle(6);
      expect(p.root.querySelector(".oo-carousel")).toBeNull();
      expect(p.root.querySelector(".oo-car-pause")).toBeNull();
    } finally { lease.dispose(); }
  });

  it("the store: nothing saved yet is null; a pick is kept per device", () => {
    const s = S.createOfficeStore({});
    expect(s.carousel()).toBeNull();
    s.saveCarousel({ ids: ["front", "lab"], interval: 60 });
    expect([s.carousel(), JSON.parse(localStorage.getItem("agend_org_office_carousel")!)]).toEqual([
      { ids: ["front", "lab"], interval: 60 }, { ids: ["front", "lab"], interval: 60 },
    ]);
  });

  it("its words in both languages", async () => {
    const I = await import("/assets/app-i18n.js");
    I.setLang("zh-TW", { store: false });
    try { expect([I.t("orgo.carousel"), I.t("orgo.pause"), I.t("orgo.next"), I.t("orgo.intervalSec", 15), I.t("orgo.officesCount", 3, 15), I.t("orgo.selectAll")]).toEqual(["輪播…", "暫停", "下一間", "15 秒", "輪播 3/15 間 ▾", "全選"]); }
    finally { I.setLang("en", { store: false }); }
    expect([I.t("orgo.carousel"), I.t("orgo.pause"), I.t("orgo.next"), I.t("orgo.playing"), I.t("orgo.officesCount", 2, 2), I.t("orgo.selectNone")]).toEqual(["Carousel…", "Pause", "Next", "Playing", "Carousel 2/2 offices ▾", "Select none"]);
  });

  it("the n/m button opens a checklist; Select all / none, Esc and a click outside close it; 15 offices stay off the bar", async () => {
    const MANY = Array.from({ length: 15 }, (_, i) => ({ id: `o${i}`, name: `Office ${i}`, skin: "pixel", members: ["atlas"] }));
    offices = { rev: 4, offices: MANY };
    await office();
    await choose("*carousel");
    expect(pickBtn().textContent.trim()).toBe("Carousel 15/15 offices ▾");
    expect(p.root.querySelector(".oo-carousel-offices")).toBeNull();     // closed: no ticks in the bar
    expect(p.root.querySelector(".oo-car-pause")).not.toBeNull();
    await openPick();
    expect(p.root.querySelectorAll(".oo-carousel-offices input")).toHaveLength(15);
    p.root.querySelector(".oo-car-none").click(); await settle(4);
    expect(pickBtn().textContent.trim()).toBe("Carousel 0/15 offices ▾");
    expect(p.root.querySelector(".oo-car-pause")).toBeNull();            // fewer than two: timer off, panel stays
    expect(p.root.querySelector(".oo-car-menu")).not.toBeNull();         // still open
    p.root.querySelector(".oo-car-all").click(); await settle(4);
    expect(pickBtn().textContent.trim()).toBe("Carousel 15/15 offices ▾");
    expect(p.root.querySelector(".oo-car-pause")).not.toBeNull();
    fire(p.window.document.body, "keydown", { key: "Escape" }); await settle(4);
    expect(p.root.querySelector(".oo-car-menu")).toBeNull();
    await openPick();
    fire(p.window.document.body, "pointerdown"); await settle(4);
    expect(p.root.querySelector(".oo-car-menu")).toBeNull();
  });
});
