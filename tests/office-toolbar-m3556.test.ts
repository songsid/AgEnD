/**
 * M-3556: the Fleet office's toolbar, laid out like other products' (user 2026-11-23/24).
 * - Desk: one row — scope on the left (Office, Show, People), the actions on the right (Edit offices, Share…) and
 *   ⚙ Display options last. Nothing else is in the row: style, the toggles and the key are in the dropdown.
 * - Display options is a dropdown, not a modal: the office stays in view, a tick applies at once and keeps it open; a
 *   press elsewhere or Escape closes it. The key is a tick there.
 * - Phone: the ⋯ sheet lists the same groups in the same order — scope, a "Display options" heading over the options, a
 *   rule, then the actions.
 * - (The Hub room office's gear opening this same dropdown: tests/hub-room-office-page-m3533.test.ts.)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";

const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill"] }], instances: {} };
const OFFICES = { rev: 1, offices: [{ id: "front", name: "Front desk", skin: "studio", members: ["atlas"] }] };

function fakeCtx() {
  const t: any = { measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }),
    getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(w * hh * 4) }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
}

for (const narrow of [false, true]) describe(narrow ? "phone" : "desk", () => {
  let p: AppPage, app: any, nav: any, fleet: any, I: any;
  const proto = MiniElement.prototype as any;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/fleet/org", ...(narrow ? { matchNarrow: true } : {}) });
    (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? OFFICES : url === "/ui/office-skins" ? { rev: "", packs: [] } : {}) });
    app = await import("/assets/app-store.js");
    nav = await import("/assets/app-nav.js");
    I = await import("/assets/app-i18n.js");
    nav.startRouter(p.window);
    fleet = await import("/ui/js/panel-fleet.js");
  });
  afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });
  beforeEach(async () => {
    await p.unmount(); p.storage.clear();
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
    (globalThis as any).AgendAuth = (p.window as any).AgendAuth = { canWrite: async () => true };   // an admin: the actions show
    localStorage.setItem("agend_org_office_skin", "studio");
    nav.navigate("/ui/fleet/org");
    app.appStore.set({ ready: true, instances: INSTANCES, exec: { quill: "working" }, awaiting: {}, needs: [] });
  });
  afterEach(() => { delete proto.getContext; delete (globalThis as any).AgendAuth; delete (p.window as any).AgendAuth; I.setLang("en", { store: false }); });
  const office = async (lang = "en") => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|${lang}` })); await settle(6);
    p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(8);
  };
  const q = (s: string) => p.root.querySelector(s);
  const btn = () => q(".oo-display-btn");
  const cls = (c: any) => String(c.className || "").split(/\s+/).filter(Boolean);
  const own = (c: any) => cls(c).find((x) => x.startsWith("oo-"));
  // Each element child of `el`, by what it is (the text between them is the template's whitespace).
  const kinds = (el: any) => (el.childNodes as any[]).filter((c) => c && c.tagName).map((c: any) => c.tagName === "H3" ? "heading" : c.tagName === "HR" ? "rule"
    : cls(c).includes("oo-pick") ? (c.querySelector(".oo-office") ? "office" : c.querySelector(".oo-team") ? "team" : c.querySelector(".oo-style") ? "style" : c.querySelector(".oo-talk-mode") ? "talk" : "pick")
    : cls(c).includes("oo-people") ? "people" : own(c) ?? c.tagName.toLowerCase());

  if (!narrow) {
    it("one row: scope on the left, the actions and ⚙ Display options on the right; no option in the row itself", async () => {
      await office();
      const row = q(".oo > .oo-bar.oo-bar-row");
      expect(row).not.toBeNull();
      expect(kinds(q(".oo-bar-scope"))).toEqual(["office", "team", "people"]);
      expect([!!q(".oo-bar-actions .oo-edit"), !!q(".oo-bar-actions .oo-share"), !!q(".oo-bar-actions .oo-display .oo-display-btn")]).toEqual([true, true, true]);
      expect(btn().textContent.trim()).toBe("Display options");
      expect(btn().getAttribute("aria-expanded")).toBe("false");
      // Closed: none of the options anywhere on the page.
      for (const s of [".oo-style", ".oo-hide-asleep", ".oo-play", ".oo-night", ".oo-dialogue", ".oo-key-tick", ".oo-display-pop"]) expect(q(s), s).toBeNull();
      expect(q(".oo-zoom .oo-options")).toBeNull();                            // the room's gear: not in the Fleet office
    });

    it("Display options: a dropdown with style, the toggles and the key; a tick applies and keeps it open; elsewhere or Escape closes it", async () => {
      await office();
      btn().click(); await settle(2);
      expect(btn().getAttribute("aria-expanded")).toBe("true");
      expect(q(".oo-display-pop .oo-display-h").textContent.trim()).toBe("Display options");   // the same heading as a room's
      const list = q(".oo-display-pop .oo-display-list");
      expect(kinds(list)).toEqual(["style", "oo-hide-asleep", "oo-hide-names", "oo-hide-mini", "oo-play", "oo-night", "oo-dialogue", "talk", "oo-key-tick"]);
      expect(q(".oo-sheet")).toBeNull();                                       // not a modal sheet
      // A tick: saved and applied at once, the dropdown still open.
      fire(q(".oo-hide-asleep input"), "change"); await settle(3);
      expect([localStorage.getItem("agend_org_office_hide_asleep") ?? localStorage.getItem("agend_org_office_hideasleep"), !!q(".oo-display-pop")]).toEqual(["1", true]);
      // Hide the minimap: gone at once and kept; ticked again, back.
      expect(!!q(".oo-mini")).toBe(true);
      fire(q(".oo-hide-mini input"), "change"); await settle(3);
      expect([q(".oo-mini"), localStorage.getItem("agend_org_office_hide_minimap")]).toEqual([null, "1"]);
      fire(q(".oo-hide-mini input"), "change"); await settle(3);
      expect([!!q(".oo-mini"), localStorage.getItem("agend_org_office_hide_minimap")]).toEqual([true, "0"]);
      // A press inside does not close it; one elsewhere does.
      fire(q(".oo-display-pop"), "pointerdown", {}); await settle(2);
      expect(!!q(".oo-display-pop")).toBe(true);
      fire(q(".oo-bar-scope"), "pointerdown", {}); await settle(2);
      expect([q(".oo-display-pop"), btn().getAttribute("aria-expanded")]).toEqual([null, "false"]);
      btn().click(); await settle(2);
      // Esc from a focused tick: closed, and the keyboard is back on ⚙ (Prism #3556 P3).
      q(".oo-display-pop .oo-night input").focus();
      fire(p.document as any, "keydown", { key: "Escape" }); await settle(2);
      expect(q(".oo-display-pop")).toBeNull();
      expect(p.document.activeElement).toBe(btn());
      btn().click(); await settle(2); btn().click(); await settle(2);           // the button toggles it too
      expect(q(".oo-display-pop")).toBeNull();
    });

    it("the key is a tick in the dropdown (Live on: the default), kept per browser", async () => {
      await office();
      btn().click(); await settle(2);
      const key = q(".oo-display-pop .oo-key-tick");
      expect(key.textContent.trim()).toBe("Key");
      fire(key.querySelector("input"), "change"); await settle(3);
      expect(localStorage.getItem("agend_org_office_key")).toBe("1");
      expect(!!q(".oo-key")).toBe(true);
    });

    it("popMaxHeight: a dropdown ends a margin above its bound, never under the minimum (a room's, in a short stage)", async () => {
      const F = await import("/ui/js/fleet-office.js");
      expect(F.popMaxHeight(352, 12)).toBe(332);                               // a 340 px stage: room for the four options (158)
      expect(F.popMaxHeight(352, 12, 8, 96)).toBeGreaterThan(158);
      expect(F.popMaxHeight(120, 60)).toBe(96);                                // tiny: the minimum, the list scrolls
    });

    it("zh-TW: 顯示選項", async () => {
      I.setLang("zh-TW", { store: false });
      await office("zh-TW");
      expect(btn().textContent.trim()).toBe("顯示選項");
      btn().click(); await settle(2);
      expect(q(".oo-display-pop").getAttribute("aria-label")).toBe("顯示選項");
    });
  } else {
    it("the ⋯ sheet: scope, a Display options heading over the options, a rule, then the actions; no desk row", async () => {
      await office();
      expect([q(".oo-bar-row"), q(".oo-display-btn")]).toEqual([null, null]);
      q(".oo-more-btn").click(); await settle(4);
      const bar = q(".oo-sheet .oo-sheet-bar");
      const got = kinds(bar);
      expect(got.slice(0, 4)).toEqual(["office", "team", "people", "heading"]);
      expect(q(".oo-sheet .oo-sheet-h").textContent.trim()).toBe("Display options");
      const rule = got.indexOf("rule"), heading = got.indexOf("heading");
      expect(got.slice(heading + 1, rule)).toEqual(["style", "oo-hide-asleep", "oo-hide-names", "oo-hide-mini", "oo-play", "oo-night", "oo-dialogue", "talk", "oo-key-tick"]);
      expect(got.slice(rule + 1)).toEqual(expect.arrayContaining(["oo-edit"]));
      expect(q(".oo-display-pop")).toBeNull();                                  // the phone keeps its sheet
    });
  }
});
