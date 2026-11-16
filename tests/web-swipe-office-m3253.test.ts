/**
 * M-3253 (Argon's phone review): a sideways drag that pans the Office — on its canvas, its stage (the zone pills on it),
 * its card — or the org chart's stage never opens the phone's drawer (app-swipe.js owns()); plain main content still does.
 */
import { describe, expect, it } from "vitest";
import { installDom, MiniEvent } from "./helpers/mini-dom.js";

describe("M-3253: a sideways drag on the Office never opens the drawer", () => {
  it("not from the canvas, the Office's stage or card, nor the org chart's stage; still from plain main content", async () => {
    const pg = installDom({ matchNarrow: true });
    try {
      const doc = pg.document as any;
      const mk = (tag: string, cls: string, parent: any) => { const e = doc.createElement(tag); if (cls) e.className = cls; parent.appendChild(e); return e; };
      const main = doc.createElement("main"); main.id = "main"; doc.body.appendChild(main);
      const stage = mk("div", "oo-stage", main), canvas = mk("canvas", "oo-canvas", stage), card = mk("div", "oo-card sheet", stage);
      const pill = mk("button", "btn", mk("div", "oo-zone-pills", stage)), oc = mk("div", "oc-stage", main), plain = mk("div", "msg", main);
      (globalThis as any).getComputedStyle = () => ({ overflowX: "visible" });
      let opens = 0;
      const { installSwipe } = await import("/assets/app-swipe.js") as any;
      const off = installSwipe({ doc, win: globalThis, isDrawer: () => true, isOpen: () => false, open: () => { opens++; }, close: () => {} });
      const swipe = (t: any) => {
        t.dispatchEvent(new MiniEvent("touchstart", { bubbles: true, touches: [{ clientX: 60, clientY: 400 }] }));
        t.dispatchEvent(new MiniEvent("touchend", { bubbles: true, touches: [], changedTouches: [{ clientX: 200, clientY: 405 }] }));
      };
      for (const t of [canvas, stage, card, pill, oc]) swipe(t);
      expect(opens).toBe(0);
      swipe(plain);
      expect(opens).toBe(1);
      off();
    } finally { pg.restore(); }
  });
});
