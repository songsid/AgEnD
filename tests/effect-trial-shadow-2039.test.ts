/** Modeled lifetime/style-source checks; native CSS isolation is covered by the product recipe. */
import { afterEach, expect, it, vi } from "vitest";
import { page } from "./helpers/app-harness.js";
import { isServedAsset } from "../src/auth-api.js";
const { createEffectTrialShadow, effectTrialShadow } = await import("/assets/effect-trial-shadow.js");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function rig() {
  const p = page(), host: any = p.window, panel: any = p.document.createElement("aside"); p.root.append(panel); cleanup.push(p.restore);
  let now = 0; const timer = vi.fn(), stop = vi.fn(), close = vi.fn(), ready = vi.fn(), error = vi.fn();
  host.performance = { now: () => now }; host.setTimeout = vi.fn(fn => { timer.mockImplementation(fn); return 1; }); host.clearTimeout = vi.fn();
  const spec = { window: host, panel, title: '<img src=x>', labels: { label: "Trial", stop: "Stop trial", close: "Close", note: "Sample" }, onReady: ready, onError: error, onStop: stop, onClose: close };
  const api = createEffectTrialShadow(spec); cleanup.push(() => api?.dispose());
  const root: any = panel._shadow, link = root.querySelector("link");
  link.disabled = false; link.sheet = { disabled: false, ownerNode: link, href: host.location.origin + "/assets/effect-trial.css", cssRules: [], insertRule() {}, deleteRule() {} };
  return { p, host, panel, root, link, api, spec, ready, error, stop, close, timer, at: (n: number) => now = n, load: () => link.dispatchEvent({ type: "load" }) };
}
it("closed empty host, fixed stylesheet and no parts/slots; nothing exposed before load", () => {
  const h = rig(); expect(h.api).not.toBeNull(); expect(h.panel.shadowRoot).toBeNull(); expect(h.panel.children).toHaveLength(0);
  expect(h.p.document.querySelector("button")).toBeNull(); expect(h.root.querySelector("[part],[exportparts],slot")).toBeNull();
  expect(h.link.getAttribute("href")).toBe("/assets/effect-trial.css"); expect(h.root.querySelectorAll("[hidden]")).toHaveLength(4); expect(effectTrialShadow(h.host, h.panel)).toBeNull();
  expect(h.host.setTimeout).toHaveBeenCalledWith(expect.any(Function), 10000); h.load(); h.load();
  expect(h.ready).toHaveBeenCalledOnce(); expect(h.root.querySelectorAll("[hidden]")).toHaveLength(0); expect(Object.isFrozen(effectTrialShadow(h.host, h.panel))).toBe(true);
  expect(h.root.querySelector(".effect-trial-title").textContent).toBe('<img src=x>'); expect(h.root.querySelector("img")).toBeNull();
  h.root.querySelector(".effect-trial-stop").click(); h.root.querySelector(".effect-trial-close").click(); expect(h.stop).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce();
});
it.each([10000,10001,Infinity,-1])("late/nonmonotonic load at %s cannot expose chrome even if the timer is delayed", at => {
  const h = rig(); h.at(at); h.load(); expect(h.ready).not.toHaveBeenCalled(); expect(h.error).toHaveBeenCalledExactlyOnceWith("stage_unavailable"); expect(h.root.children).toHaveLength(0);
});
it("predeadline positive and timed-out/errored/disposed shells never revive on a late load", () => {
  const h = rig(); h.at(9999); h.load(); expect(h.ready).toHaveBeenCalledOnce(); h.api.dispose(); h.load(); expect(effectTrialShadow(h.host,h.panel)).toBeNull();
  const b = rig(); b.timer(); b.load(); expect(b.ready).not.toHaveBeenCalled(); expect(b.error).toHaveBeenCalledOnce();
  const c = rig(); c.link.dispatchEvent({ type: "error" }); c.load(); expect(c.ready).not.toHaveBeenCalled(); expect(c.error).toHaveBeenCalledOnce();
});
it.each(["href","owner","disabled","getter"])("replaced/unknown sheet %s never issues a shell", fault => {
  const h = rig(); if(fault==="href") h.link.sheet.href = "https://evil.invalid/effect-trial.css"; if(fault==="owner") h.link.sheet.ownerNode = h.panel; if(fault==="disabled") h.link.sheet.disabled = true; if(fault==="getter") Object.defineProperty(h.link.sheet,"cssRules",{get(){throw Error("sheet");}});
  expect(() => h.load()).not.toThrow(); expect(h.ready).not.toHaveBeenCalled(); expect(h.error).toHaveBeenCalledOnce(); expect(effectTrialShadow(h.host,h.panel)).toBeNull();
});
it("same closed root can be reused only after disposal; stale callbacks cannot clear the replacement", () => {
  const h = rig(); expect(createEffectTrialShadow(h.spec)).toBeNull(); h.api.dispose(); const next = createEffectTrialShadow(h.spec); cleanup.push(() => next.dispose());
  expect(next).not.toBeNull(); expect(h.panel._shadow).toBe(h.root); h.api.dispose(); h.load(); expect(h.root.children).toHaveLength(5); expect(h.ready).not.toHaveBeenCalled();
});
it("fixed CSS and JS are served through existing self-only asset routes", () => { expect(isServedAsset("effect-trial-shadow.js")).toBe(true); expect(isServedAsset("effect-trial.css")).toBe(true); });
