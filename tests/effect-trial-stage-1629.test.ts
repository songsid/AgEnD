import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { page, type AppPage } from "./helpers/app-harness.js";
import { isServedAsset } from "../src/auth-api.js";
const { createEffectTrialStage, effectTrialStage, effectTrialStageIdentity, watchEffectTrialStage, disposeEffectTrialStage, constrainEffectTrialStage } = await import("/assets/effect-trial-stage.js");
const { createEffectTrialShadow } = await import("/assets/effect-trial-shadow.js");
const { allocateEffectFrames } = await import("/assets/effect-policy.js");
const proof = () => ({ ok: true, front: false, agentFront: false, rects: [] });
const own = () => ({ key: "trial:a", id: "a".repeat(32), run: "b".repeat(32), instance: "worker", generation: 1 });
const pages: AppPage[] = [], cleanup: (() => void)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) f(); for (const p of pages.splice(0).reverse()) { await p.unmount(); p.restore(); } });
function fixture(options: any = {}) {
  const p = page(); pages.push(p); const doc: any = p.document, host: any = p.window;
  p.root.className = "main";
  const chat = doc.createElement("section"), split = doc.createElement("div"), panel = doc.createElement("aside"), link = doc.createElement("link");
  chat.className = "panel p-chat"; split.className = "chat-split"; panel.className = "pv-panel effect-trial-panel"; panel.setAttribute("data-trust", "preview");
  p.root.append(chat); chat.append(split); split.append(panel);
  const shadow = createEffectTrialShadow({ window: host, panel, title: "Test", labels: { label: "Trial", close: "Close", stop: "Stop", note: "Note" }, onReady() {}, onError() {} });
  cleanup.push(shadow.dispose);
  const shadowRoot = panel._shadow, stage = shadowRoot.querySelector(".effect-trial-stage"), shadowLink = shadowRoot.querySelector("link");
  link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/app.css"); doc.body.append(link); (link as any).disabled = false;
  const rules: any[] = [], sheet: any = { ownerNode: link, href: host.location.origin + "/assets/app.css", disabled: false, cssRules: rules,
    insertRule(selector: string) { const declarations: any = {}; rules.push({ selectorText: selector.slice(0, -2), declarations, style: { setProperty(k: string, v: string) { declarations[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; } } }); return rules.length - 1; }, deleteRule(i: number) { rules.splice(i, 1); } };
  (link as any).sheet = sheet; shadowLink.disabled = false;
  shadowLink.sheet = { ...sheet, ownerNode: shadowLink, href: host.location.origin + "/assets/effect-trial.css" };
  shadowLink.dispatchEvent({ type: "load" });
  const base = () => ({ position: "static", zIndex: "auto", visibility: "visible", display: "block", opacity: "1", contain: "none", isolation: "auto", mixBlendMode: "normal", willChange: "auto", contentVisibility: "visible", transform: "none", boxShadow: "none", outlineStyle: "none" });
  const stageStyle = { position: "relative", zIndex: "0", contain: "paint", overflowX: "clip", overflowY: "clip", paddingLeft: "0px", paddingRight: "0px", paddingTop: "0px", paddingBottom: "0px", borderLeftWidth: "0px", borderRightWidth: "0px", borderTopWidth: "0px", borderBottomWidth: "0px" };
  let current = () => true, css = () => "off", focused = true, patch: any = {}, framePatch: any = {}, otherPatch = new Map<any, any>(), r = { x: 320, y: 160, width: 399.75, height: 300.5 };
  const bounds = (el: any) => el === stage ? r : el === panel ? { x: 300, y: 100, width: 450, height: 450 } : { x: r.x, y: r.y, width: Number.parseFloat(rules.at(-1)?.declarations.width || "399"), height: Number.parseFloat(rules.at(-1)?.declarations.height || "300") };
  stage.getBoundingClientRect = () => bounds(stage); panel.getBoundingClientRect = () => bounds(panel);
  Object.assign(host, { innerWidth: 800, innerHeight: 600, CSS: { supports: () => options.supports !== false }, getComputedStyle(el: any) { const matching = rules.filter(rule => el.classList.contains(rule.selectorText.slice(1))); return { ...base(), ...(el === stage ? { ...stageStyle, ...patch } : {}), ...Object.assign({}, ...matching.map(rule => rule.declarations)), ...(el.tagName === "IFRAME" ? framePatch : {}), ...otherPatch.get(el) }; } });
  Object.defineProperty(doc, "visibilityState", { configurable: true, value: "visible" }); doc.hasFocus = () => focused;
  for (const el of shadowRoot.querySelectorAll(".effect-trial-head,.effect-trial-controls,button,.effect-trial-note")) el.getBoundingClientRect = () => ({ x: 310, y: 110, width: 80, height: 20 });
  const onStop = vi.fn(), api = createEffectTrialStage({ window: host, panel, stage, binding: options.binding || own(), current: (v: any) => current(), ownerCss: () => css(), onStop });
  if (api) cleanup.push(api.dispose);
  const frame = () => { const f = doc.createElement("iframe"); f.getBoundingClientRect = () => bounds(f); stage.append(f); return f; };
  return { p, host, doc, panel, stage, link, rules, api, onStop, frame, patch, framePatch, otherPatch, rect(v: any) { r = v; }, css(v: string) { css = () => v; }, focus(v: boolean) { focused = v; }, current(fn: () => boolean) { current = fn; } };
}
describe("host-only local trial stage, not product admission or a new frame pool", () => {
  it("one pre-frame host veto cannot replace original permission and is rechecked after layout", () => {
    const f = fixture(); let allowed = true;
    expect(constrainEffectTrialStage({}, () => true)).toBe(false); expect(constrainEffectTrialStage(f.api.receipt, null)).toBe(false);
    expect(constrainEffectTrialStage(f.api.receipt, () => allowed)).toBe(true); expect(constrainEffectTrialStage(f.api.receipt, () => true)).toBe(false);
    const p = effectTrialStage(f.api.receipt, own(), proof()), frame = f.frame(), bound = p.bind(frame, { layer: "front" }, proof()); expect(bound.ok).toBe(true); expect(bound.sync(proof())).toBe(true);
    const rect = f.stage.getBoundingClientRect.bind(f.stage); f.stage.getBoundingClientRect = () => { allowed = false; return rect(); };
    expect(effectTrialStage(f.api.receipt, own(), proof())).toBeNull(); expect(frame.isConnected).toBe(false); expect(f.onStop).toHaveBeenCalledOnce();
    const other = fixture(), before = effectTrialStage(other.api.receipt, own(), proof()), existing = other.frame(); expect(before.bind(existing, { layer: "front" }, proof()).ok).toBe(true); expect(constrainEffectTrialStage(other.api.receipt, () => true)).toBe(false);
  });
  it("issued-owner retirement removes paint before callbacks and refuses unknown/repeated receipts", () => {
    const f = fixture(), p = effectTrialStage(f.api.receipt, own(), proof()), frame = f.frame(), mounted = p.bind(frame, { layer: "front" }, proof());
    expect(mounted.ok).toBe(true); expect(mounted.sync(proof())).toBe(true);
    const seen: string[] = []; watchEffectTrialStage(f.api.receipt, () => { expect(frame.isConnected).toBe(false); expect(effectTrialStageIdentity(f.api.receipt)).toBeNull(); seen.push("ended"); });
    expect(disposeEffectTrialStage({})).toBe(false); expect(disposeEffectTrialStage(f.api.receipt)).toBe(true); expect(seen).toEqual(["ended"]);
    expect(disposeEffectTrialStage(f.api.receipt)).toBe(false); f.api.dispose(); expect(f.onStop).toHaveBeenCalledOnce();
  });
  it("serves only the shared registry dependency; no product TrialPanel import", () => {
    expect(isServedAsset("effect-trial-stage.js")).toBe(true);
    for (const file of ["src/ui/panel-chat.js", "src/ui/shared/app.js", "src/ui/app-effects.js"]) expect(readFileSync(file, "utf8")).not.toContain("effect-trial-panel");
  });
  it("brands an immutable identity and projects only an exact current binding with ordinary foreground still suppressed", () => {
    const h = fixture(), identity = effectTrialStageIdentity(h.api.receipt);
    expect(Object.isFrozen(identity)).toBe(true); expect(identity).toMatchObject({ key: own().key, id: own().id, instance: own().instance, generation: 1 });
  });
  it("does not publish the server trial reference in paint identity", () => {
    const h = fixture(); expect(effectTrialStageIdentity(h.api.receipt)).toEqual({ key: "trial:a", id: "a".repeat(32), instance: "worker", generation: 1, serial: expect.any(Number) });
    expect(effectTrialStage(h.api.receipt, own(), proof())).toMatchObject({ root: h.stage, rect: { x: 320, y: 160, width: 399, height: 300 } });
    expect(h.stage.children).toHaveLength(0); expect(h.rules).toHaveLength(0);
  });
  it.each(["key", "id", "instance", "generation"])("a different %s never resolves the receipt", key => { const h = fixture(); expect(effectTrialStage(h.api.receipt, { ...own(), [key]: "other" }, proof())).toBeNull(); expect(effectTrialStageIdentity({})).toBeNull(); expect(effectTrialStage({}, own(), proof())).toBeNull(); });
  it("hides before bind succeeds, uses inward integer bounds and physically removes only its frame/rule", () => {
    const h = fixture(), projected = effectTrialStage(h.api.receipt, own(), proof()), f = h.frame(), b = projected.bind(f, { layer: "front" }, proof());
    expect(b.ok).toBe(true); expect(h.host.getComputedStyle(f).visibility).toBe("hidden"); expect(b.sync(proof())).toBe(true); expect(h.host.getComputedStyle(f)).toMatchObject({ width: "399px", height: "300px", pointerEvents: "none", opacity: "0.85", visibility: "visible" });
    h.api.hide(); expect(h.host.getComputedStyle(f).visibility).toBe("hidden"); h.api.dispose(); h.api.dispose(); expect(f.isConnected).toBe(false); expect(h.rules).toHaveLength(0); expect(h.panel.isConnected).toBe(true); expect(h.onStop).toHaveBeenCalledExactlyOnceWith("stopped"); expect(effectTrialStageIdentity(h.api.receipt)).toBeNull();
  });
  it.each(["on", "loading", "unknown"])("owner CSS %s does not grant access to the isolated stage", css => { const h = fixture(); h.css(css); expect(effectTrialStage(h.api.receipt, own(), proof())).not.toBeNull(); expect(h.panel.shadowRoot).toBeNull(); expect(h.panel.querySelector(".effect-trial-stage")).toBeNull(); });
  it.each([null, { ...proof(), ok: false }, { ...proof(), front: true, agentFront: true }])("missing or globally unsuppressed proof refuses: %j", p => { const h = fixture(); expect(effectTrialStage(h.api.receipt, own(), p)).toBeNull(); });
  it.each([{ contain: "none" }, { overflowX: "visible" }, { overflowY: "hidden" }, { position: "fixed" }, { zIndex: "20" }, { paddingLeft: "1px" }, { borderRightWidth: "1px" }, { transform: "matrix(1,0,0,1,1,0)" }, { isolation: "isolate" }, { mixBlendMode: "multiply" }, { boxShadow: "0px 0px 2px red" }, { outlineStyle: "solid" }])("clip or paint change %j refuses", patch => { const h = fixture(); Object.assign(h.patch, patch); expect(effectTrialStage(h.api.receipt, own(), proof())).toBeNull(); });
  it.each(["class", "marker", "topology", "extra-child", "focusable", "editable", "offscreen", "out-of-panel", "huge", "missing-sheet", "no-focus"])("stage %s refuses", fault => {
    const h = fixture(); if (fault === "class") h.panel.className += " other"; if (fault === "marker") h.panel.removeAttribute("data-trust"); if (fault === "topology") h.doc.body.append(h.panel); if (fault === "extra-child") h.stage.append(h.doc.createElement("div")); if (fault === "focusable") h.stage.setAttribute("tabindex", "0"); if (fault === "editable") h.stage.setAttribute("contenteditable", "false"); if (fault === "offscreen") h.rect({ x: -1, y: 0, width: 20, height: 20 }); if (fault === "out-of-panel") h.rect({ x: 0, y: 0, width: 20, height: 20 }); if (fault === "huge") h.rect({ x: 320, y: 160, width: 4097, height: 300 }); if (fault === "missing-sheet") (h.link as any).disabled = true; if (fault === "no-focus") h.focus(false);
    expect(effectTrialStage(h.api.receipt, own(), proof())).toBeNull();
  });
  it("another menu/dialog ends a stage even if the supplied stock snapshot still says suppressed", () => { const h = fixture(), menu = h.doc.createElement("div"); menu.setAttribute("role", "dialog"); menu.getBoundingClientRect = () => ({ x: 0, y: 0, width: 10, height: 10 }); h.doc.body.append(menu); expect(effectTrialStage(h.api.receipt, own(), proof())).toBeNull(); });
  it("window blur stops synchronously; element blur does not", () => { const h = fixture(); h.host._fire({ type: "blur", target: h.stage, eventPhase: 2 }, false); expect(effectTrialStageIdentity(h.api.receipt)).not.toBeNull(); h.host._fire({ type: "blur", target: h.host, eventPhase: 2 }, false); expect(effectTrialStageIdentity(h.api.receipt)).toBeNull(); expect(h.onStop).toHaveBeenCalledExactlyOnceWith("blur"); });
  it("current callback reentry cannot revive a disposed receipt or touch a replacement", () => { const h = fixture(); h.current(() => { h.api.dispose(); return true; }); expect(effectTrialStage(h.api.receipt, own(), proof())).toBeNull(); expect(h.onStop).toHaveBeenCalledTimes(1); });
  it("a stronger initial visible cascade is refused and removed before successful bind", () => { const h = fixture(), p = effectTrialStage(h.api.receipt, own(), proof()), f = h.frame(); h.framePatch.visibility = "visible"; expect(p.bind(f, { layer: "front" }, proof()).ok).toBe(false); expect(f.isConnected).toBe(false); expect(h.rules).toHaveLength(0); });
  it("sync paint loss removes the frame; another frame cannot share this stage", () => { const h = fixture(), p = effectTrialStage(h.api.receipt, own(), proof()), f = h.frame(), b = p.bind(f, { layer: "behind" }, proof()); expect(b.sync(proof())).toBe(true); h.framePatch.pointerEvents = "auto"; expect(b.sync(proof())).toBe(false); expect(f.isConnected).toBe(false); });
  it("rechecks an unchanged visible stage without hiding or rewriting its presentation", () => {
    const h = fixture(), p = effectTrialStage(h.api.receipt, own(), proof()), f = h.frame(), b = p.bind(f, { layer: "front" }, proof()); expect(b.sync(proof())).toBe(true);
    const write = vi.spyOn(h.rules[0].style, "setProperty"), current = vi.fn(() => true); h.current(current);
    for (let i = 0; i < 100; i++) expect(b.sync(proof())).toBe(true);
    expect(current).toHaveBeenCalledTimes(200); expect(write).not.toHaveBeenCalled();
    // A new proof still vetoes that exact unchanged presentation immediately.
    expect(b.sync({ ...proof(), front: true })).toBe(false); expect(f.isConnected).toBe(false);
  });
  it("changed bounds and an explicit hide require hidden verification before revealing again", () => {
    const h = fixture(), p = effectTrialStage(h.api.receipt, own(), proof()), f = h.frame(), b = p.bind(f, { layer: "front" }, proof()); expect(b.sync(proof())).toBe(true);
    const write = vi.spyOn(h.rules[0].style, "setProperty"); h.rect({ x: 320, y: 160, width: 200, height: 200 });
    expect(b.sync(proof())).toBe(true); expect(write.mock.calls[0]).toEqual(["visibility", "hidden", "important"]); expect(write.mock.calls.at(-1)).toEqual(["visibility", "visible", "important"]); expect(h.host.getComputedStyle(f).width).toBe("200px");
    b.hide(); write.mockClear(); expect(b.sync(proof())).toBe(true); expect(write.mock.calls[0]).toEqual(["visibility", "hidden", "important"]);
  });
  it.each([{ pointerEvents: "auto" }, { transform: "matrix(1,0,0,1,1,0)" }, { opacity: "1" }, { visibility: "visible", pointerEvents: "auto" }])("a formerly visible frame cannot bypass a lost paint/hiding rule: %j", patch => {
    const h = fixture(), p = effectTrialStage(h.api.receipt, own(), proof()), f = h.frame(), b = p.bind(f, { layer: "front" }, proof()); expect(b.sync(proof())).toBe(true);
    Object.assign(h.framePatch, patch); expect(b.sync(proof())).toBe(false); expect(f.isConnected).toBe(false); expect(effectTrialStageIdentity(h.api.receipt)).toBeNull();
  });
  it("binding rejects getters without calling them", () => { const get = vi.fn(), raw = own(); Object.defineProperty(raw, "id", { get, enumerable: true }); const h = fixture({ binding: raw }); expect(h.api).toBeNull(); expect(get).not.toHaveBeenCalled(); });
  it("expected binding accessors are refused without invocation", () => { const h = fixture(), value = own(), get = vi.fn(); Object.defineProperty(value, "id", { get }); expect(effectTrialStage(h.api.receipt, value, proof())).toBeNull(); expect(get).not.toHaveBeenCalled(); });
  it("one stage holds only one frame, and rejection removes the extra input", () => { const h = fixture(), p = effectTrialStage(h.api.receipt, own(), proof()), first = h.frame(); const one = p.bind(first, { layer: "front" }, proof()); expect(one.ok).toBe(true); const second = h.frame(); expect(p.bind(second, { layer: "front" }, proof()).ok).toBe(false); expect(second.isConnected).toBe(false); expect(first.isConnected).toBe(true); });
  it("layout reentry cannot return a newly stale or detached stage", () => { const h = fixture(), before = h.stage.getBoundingClientRect; h.stage.getBoundingClientRect = () => { h.current(() => false); return before(); }; expect(effectTrialStage(h.api.receipt, own(), proof())).toBeNull(); });

  it("lifetime notifications follow physical removal, are one-shot and survive throws/reentry", () => {
    const h = fixture(), projection = effectTrialStage(h.api.receipt, own(), proof()), frame = h.frame(); projection.bind(frame, { layer: "front" }, proof());
    const observed: any[] = []; const first = vi.fn(() => { observed.push({ connected: frame.isConnected, identity: effectTrialStageIdentity(h.api.receipt) }); h.api.dispose(); throw Error("observer"); }), second = vi.fn();
    expect(watchEffectTrialStage({}, first)).toBeNull(); watchEffectTrialStage(h.api.receipt, first); watchEffectTrialStage(h.api.receipt, second);
    h.api.dispose(); h.api.dispose(); expect(observed).toEqual([{ connected: false, identity: null }]); expect(first).toHaveBeenCalledExactlyOnceWith("stopped"); expect(second).toHaveBeenCalledExactlyOnceWith("stopped"); expect(watchEffectTrialStage(h.api.receipt, second)).toBeNull();
  });
  it("cancelled stage subscribers are not notified", () => { const h = fixture(), fn = vi.fn(), off = watchEffectTrialStage(h.api.receipt, fn); off(); off(); h.api.dispose(); expect(fn).not.toHaveBeenCalled(); });

  it("pure allocation keeps common total/front caps and refuses cloned/disposed receipts", () => {
    const ctx = { safe: false, publicLink: false, reducedMotion: false, saveData: false, hidden: false, enabled: true, show: true, transportReady: true, optIn: true, trialReady: true, constrained: false, modal: true, openInstance: "worker" };
    const items = [0, 1, 2, 3].map(i => {
      const binding = { ...own(), key: "trial:" + i }, h = fixture({ binding });
      return { h, d: { ...binding, trialStage: h.api.receipt, region: "chat", layer: i === 3 ? "behind" : "front", by: "human", order: i, paused: false, visible: true } };
    });
    expect(allocateEffectFrames([items[0].d], { ...ctx, optIn: false, transportReady: true })[0]).toMatchObject({ verdict: "active" });
    expect(allocateEffectFrames([{ ...items[0].d, trialStage: undefined }], { ...ctx, modal: false, optIn: false, transportReady: false })[0]).toMatchObject({ verdict: "off", reason: "transport_unavailable" });
    const ds = items.map(x => x.d), result = allocateEffectFrames(ds, ctx); expect(result.map((r: any) => [r.verdict, r.reason])).toEqual([["active", null], ["active", null], ["queued", "front_limit"], ["active", null]]);
    expect(allocateEffectFrames(ds, { ...ctx, constrained: true }).filter((r: any) => r.verdict === "active")).toHaveLength(1);
    expect(allocateEffectFrames([{ ...ds[0], region: "page" }], ctx)[0]).toMatchObject({ verdict: "off", reason: "trial_unknown" });
    expect(allocateEffectFrames([{ ...ds[0], trialStage: { ...ds[0].trialStage } }], ctx)[0]).toMatchObject({ verdict: "off", reason: "trial_unknown" });
    expect(allocateEffectFrames([{ ...ds[0], trialStage: {} }], { ...ctx, modal: false })[0]).toMatchObject({ verdict: "off", reason: "trial_unknown" });
    items[0].h.api.dispose(); expect(allocateEffectFrames([ds[0]], ctx)[0]).toMatchObject({ verdict: "off", reason: "trial_unknown" });
    for (const patch of [{ safe: true }, { publicLink: true }, { reducedMotion: true }, { enabled: false }, { show: false }, { transportReady: false }, { hidden: true }]) expect(allocateEffectFrames([ds[1]], { ...ctx, ...patch })[0].verdict).toBe("off");
  });
  it("constructor refuses unknown clip support or a duplicate owner of the same stage", () => {
    expect(fixture({ supports: false }).api).toBeNull(); const h = fixture(); expect(createEffectTrialStage({ window: h.host, panel: h.panel, stage: h.stage, binding: own(), current: () => true, ownerCss: () => "off" })).toBeNull();
  });
  it("unknown ancestor containment and another visible preview refuse even with a modeled suppressed proof", () => {
    const h = fixture(); h.otherPatch.set(h.panel, { contain: "paint" }); expect(effectTrialStage(h.api.receipt, own(), proof())).toBeNull();
    const second = fixture(), other = second.doc.createElement("aside"); other.className = "pv-panel"; other.getBoundingClientRect = () => ({ x: 0, y: 0, width: 20, height: 20 }); second.doc.body.append(other); expect(effectTrialStage(second.api.receipt, own(), proof())).toBeNull();
  });
  it("viewport and total pixel bounds are independent of panel containment", () => {
    const h = fixture(); h.panel.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1000, height: 1000 }); h.rect({ x: 790, y: 20, width: 20, height: 20 }); expect(effectTrialStage(h.api.receipt, own(), proof())).toBeNull();
    const second = fixture(); second.host.innerWidth = second.host.innerHeight = 4096; second.panel.getBoundingClientRect = () => ({ x: 0, y: 0, width: 4096, height: 4096 }); second.rect({ x: 0, y: 0, width: 3000, height: 3000 }); expect(effectTrialStage(second.api.receipt, own(), proof())).toBeNull();
  });
  it("only an iframe can bind the local stage", () => { const h = fixture(), p = effectTrialStage(h.api.receipt, own(), proof()), canvas = h.doc.createElement("canvas"); h.stage.append(canvas); expect(p.bind(canvas, { layer: "front" }, proof()).ok).toBe(false); expect(canvas.isConnected).toBe(false); });

  it("sync refuses an in-bounds frame whose actual size disagrees with the host geometry", () => { const h = fixture(), p = effectTrialStage(h.api.receipt, own(), proof()), f = h.frame(), b = p.bind(f, { layer: "front" }, proof()); f.getBoundingClientRect = () => ({ x: 320, y: 160, width: 398, height: 300 }); expect(b.sync(proof())).toBe(false); expect(f.isConnected).toBe(false); });

});
