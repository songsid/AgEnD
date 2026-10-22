/** Modeled geometry over real selector-capable DOM. Actual producer/paint controls live in the native recipe. */
import { afterEach, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { readFileSync } from "node:fs";
const { stockEffectTrust } = await import("/assets/effect-stock-trust.js");
const pages: AppPage[] = [];
afterEach(() => { for (const p of pages.splice(0).reverse()) p.restore(); });
const kinds = ["fleet", "needs", "settings", "view", "log", "details"];
function fixture(kind = "fleet", ready = true) {
  const p = page(); pages.push(p); const d = p.document, styles = new Map<any, any>();
  const neutral = () => ({ opacity: "1", isolation: "auto", mixBlendMode: "normal", contain: "none", willChange: "auto", zIndex: "auto", position: "static", display: "block", visibility: "visible", transform: "none", filter: "none", backdropFilter: "none", clipPath: "none", maskImage: "none", boxShadow: "none", textShadow: "none", outlineStyle: "none" });
  const set = (el: any, patch = {}) => {
    styles.set(el, { ...neutral(), ...patch }); el.getBoundingClientRect = () => ({ x: 10, y: 20, width: 100, height: 50 });
    el.getClientRects = () => styles.get(el).display === "none" ? [] : [el.getBoundingClientRect()]; return el;
  };
  for (const el of [d.documentElement, d.body, p.root]) set(el);
  const add = (parent: any, cls: string, trust?: string, extra = {}) => {
    const el = d.createElement("div"); el.className = cls; if (trust) el.setAttribute("data-trust", trust); parent.append(el); return set(el, extra);
  };
  const shell = add(p.root, "shell"), main = add(shell, "main"), panel = add(main, `panel p-${kind}`); panel.setAttribute("data-effect-panel", kind);
  const header = add(panel, "panel-head", "header", { position: "relative", zIndex: "2" });
  const child = (cls: string, trust = "panel-content", position = "relative") => add(panel, cls, trust, { position, zIndex: "1" });
  if (["fleet", "settings"].includes(kind)) child("seg", "panel-navigation");
  if (kind === "view" && ready) { child("v-term"); child("v-id"); } else child("panel-body");
  const host = { document: d, innerWidth: 1366, getComputedStyle: (el: any) => styles.get(el) || neutral() };
  return { p, d, shell, main, panel, header, child, styles, add, snapshot: (css = "off") => stockEffectTrust(host, { ownerCss: css }) };
}
describe("#1629 closed full-app stock producer topology", () => {
  it.each(kinds)("%s bounded content is protected with neutral structural ancestors", kind => {
    const f = fixture(kind); expect(f.snapshot()).toMatchObject({ ok: true, front: true, agentFront: true });
    expect(f.snapshot().rects.length).toBeGreaterThanOrEqual(2);
    for (const css of ["on", "loading", "unknown"]) expect(f.snapshot(css)).toMatchObject({ ok: true, front: true, agentFront: false, agentReason: "owner_css" });
  });
  it.each([false, true])("View has a closed loading/ready topology (%s)", ready => {
    const f = fixture("view", ready); expect(f.snapshot().ok).toBe(true);
    f.child(ready ? "panel-body" : "v-term"); expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_route_unknown" });
  });
  it.each(kinds)("%s missing/wrong producer marker refuses; generic Outlet fallback never grants a route", kind => {
    const f = fixture(kind); for (const marker of [null, "chat", "future", "__proto__"]) {
      if (marker === null) f.panel.removeAttribute("data-effect-panel"); else f.panel.setAttribute("data-effect-panel", marker);
      expect(f.snapshot().ok).toBe(false);
    }
    f.panel.setAttribute("data-effect-panel", kind); f.panel.className = "panel"; expect(f.snapshot().ok).toBe(false);
  });
  it.each(kinds)("%s refuses a removed required parent", kind => {
    for (const selector of [".panel-head", ...(kind === "view" ? [".v-term", ".v-id"] : [".panel-body"]), ...(["fleet", "settings"].includes(kind) ? [".seg"] : [])]) {
      const f = fixture(kind); f.panel.querySelector(selector).remove(); expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_route_unknown" });
    }
  });
  it.each(kinds)("%s rejects unknown direct children and duplicate content roots", kind => {
    const f = fixture(kind), unknown = f.child("unknown-control"); unknown.removeAttribute("data-trust"); expect(f.snapshot().ok).toBe(false); unknown.remove();
    f.child("panel-head", "header"); expect(f.snapshot().ok).toBe(false);
  });
  it.each(kinds)("%s requires every expected bounded marker even when unmarked/hidden", kind => {
    const f = fixture(kind), content = f.panel.querySelector(kind === "view" ? ".v-term" : ".panel-body");
    content.removeAttribute("data-trust"); expect(f.snapshot().ok).toBe(false);
    f.styles.get(content).display = "none"; expect(f.snapshot().ok).toBe(false);
    content.setAttribute("data-trust", "wrong"); expect(f.snapshot().ok).toBe(false);
  });
  it.each(kinds)("%s refuses content paint below behind effects or under an unknown context", kind => {
    for (const patch of [{ zIndex: "-1" }, { zIndex: "auto" }, { position: "static" }, { transform: "matrix(1,0,0,1,0,0)" }, { opacity: ".9" }]) {
      const f = fixture(kind), content = f.panel.querySelector(kind === "view" ? ".v-term" : ".panel-body"); Object.assign(f.styles.get(content), patch);
      expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_order_unknown" });
    }
  });
  it("Settings pending Apply stays sticky in its explicit level1; inline confirmations stay protected", () => {
    const f = fixture("settings"), apply = f.child("s-pending", "panel-controls", "sticky");
    const body = f.panel.querySelector(".panel-body"), col = f.add(body, "col"), pending = f.add(col, "pending-stack inline", "confirmation");
    expect(f.snapshot()).toMatchObject({ ok: true, front: true });
    pending.removeAttribute("data-trust"); expect(f.snapshot().ok).toBe(false); pending.setAttribute("data-trust", "confirmation");
    f.styles.get(apply).position = "relative"; expect(f.snapshot().ok).toBe(false);
  });
  it("Log optional tools must own their protected paint band", () => {
    const f = fixture("log"), tools = f.child("log-bar", "panel-controls"); expect(f.snapshot().ok).toBe(true);
    f.styles.get(tools).zIndex = "-1"; expect(f.snapshot().ok).toBe(false);
  });
  it("unknown direct text cannot paint outside a protected stock parent", () => {
    const f = fixture(); f.panel.append(f.d.createTextNode("unprotected control label")); expect(f.snapshot().ok).toBe(false);
  });
  it("unknown extra panels and roots with additional classes refuse", () => {
    const f = fixture(); const other = f.add(f.main, "panel p-details"); expect(f.snapshot().ok).toBe(false); other.remove();
    f.panel.className += " unexpected"; expect(f.snapshot().ok).toBe(false);
  });
  it("all six real producers stamp roots and bounded parents; loading branches are included", () => {
    for (const kind of kinds) {
      const file = kind === "view" ? "src/ui/shared/panel-view.js" : `src/ui/panel-${kind}.js`, source = readFileSync(file, "utf8");
      expect(source).toContain(`data-effect-panel="${kind}" class="panel p-${kind}"`);
      expect(source).not.toMatch(/<div class="panel-body/);
      // The navigation is `.seg` (the stock route's own selector, `.p-<kind> > .seg`); #2347: Settings' carries a class of its own too.
      if (["fleet", "settings"].includes(kind)) expect(source).toMatch(/data-trust="panel-navigation" class="seg[ "]/);
    }
  });
});
