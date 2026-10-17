import { afterEach, expect, it, vi } from "vitest";
import { h, page, type AppPage } from "./helpers/app-harness.js";
const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("/assets/effect-trial-stage.js", () => ({ createEffectTrialStage: mock.create }));
const { EffectTrialPanel } = await import("/ui/js/effect-trial-panel.js");
const { setLang } = await import("/assets/app-i18n.js");
let p: AppPage | null = null;
afterEach(async () => { if (p) { await p.unmount(); p.restore(); p = null; } mock.create.mockReset(); });
const binding = () => Object.freeze({ key: "trial:a", id: "a".repeat(32), run: "b".repeat(32), instance: "worker", generation: 1 });
function shell(ready = true): any {
  const panel: any = p!.document.querySelector(".effect-trial-panel"), root = panel._shadow, link = root.querySelector("link");
  if (ready) { link.disabled = false; link.sheet = { ownerNode: link, disabled: false, href: p!.window.location.origin + "/assets/effect-trial.css", cssRules: [], insertRule() {}, deleteRule() {} }; link.dispatchEvent({ type: "load" }); }
  return root;
}
async function mount(lang = "en", extra: any = {}) {
  p = page(); setLang(lang, { store: false }); let ended = false;
  const onStop = vi.fn(), onClose = vi.fn(), onStage = vi.fn(), current = vi.fn(() => true), css = vi.fn(() => "off");
  const api = { receipt: Object.freeze({}), dispose: vi.fn(() => { if (!ended) { ended = true; mock.create.mock.calls[0][0].onStop("stopped"); } }) };
  mock.create.mockReturnValue(api);
  const props = { window: p.window, binding: binding(), title: '<img src=x onerror="bad()">', current, ownerCss: css, onStop, onClose, onStage, ...extra };
  await p.mount(h(EffectTrialPanel, props)); shell(); return { api, props, onStop, onClose, onStage, current, css };
}
it.each([["en", "Trial", "Stop trial", "Close"], ["zh-TW", "試播", "停止試播", "關閉"]])("%s fixed host label/Stop/Close and empty nonfocusable stage", async (lang, label, stop, close) => {
  const f = await mount(lang), panel: any = p!.document.querySelector(".effect-trial-panel");
  expect(panel.shadowRoot).toBeNull(); expect(panel.querySelector("button")).toBeNull(); expect(p!.document.querySelector(".effect-trial-stage")).toBeNull();
  expect(panel.getAttribute("data-trust")).toBe("preview"); expect(shell(false).querySelector("strong").textContent).toBe(label);
  expect([...shell(false).querySelectorAll("button")].map((e: any) => e.textContent)).toEqual([close, stop]);
  expect(shell(false).querySelector("img,script,iframe,canvas")).toBeNull(); expect(shell(false).textContent).toContain(f.props.title);
  const stage = shell(false).querySelector(".effect-trial-stage"); expect(stage.getAttribute("aria-hidden")).toBe("true"); expect(stage.hasAttribute("tabindex")).toBe(false); expect(stage.children).toHaveLength(0);
  expect(f.onStage).toHaveBeenCalledExactlyOnceWith(f.api); expect(f.current).not.toHaveBeenCalled(); expect(f.css).not.toHaveBeenCalled();
});
it.each([false, true])("%s closes the stage before one host callback, repeated click inert", async close => {
  const f = await mount(); const button: any = shell(false).querySelector(close ? ".effect-trial-head button" : ".effect-trial-controls button");
  button.click(); button.click(); expect(f.api.dispose).toHaveBeenCalledTimes(1); expect(close ? f.onClose : f.onStop).toHaveBeenCalledExactlyOnceWith("stopped"); expect(close ? f.onStop : f.onClose).not.toHaveBeenCalled();
});
it("unmount notifies the captured owner once and cannot call a newer run's callback", async () => {
  const f = await mount(), newer = vi.fn(); await p!.mount(h(EffectTrialPanel, { ...f.props, binding: binding(), onStop: newer }));
  expect(f.onStop).toHaveBeenCalledExactlyOnceWith("stopped"); expect(newer).not.toHaveBeenCalled();
});
it("stage creation failure reports unavailable and never exposes a fake paint receipt", async () => {
  p = page(); const stop = vi.fn(), ready = vi.fn(); mock.create.mockReturnValue(null);
  await p.mount(h(EffectTrialPanel, { window: p.window, binding: binding(), title: "Test", current: () => true, ownerCss: () => "off", onStage: ready, onStop: stop }));
  shell(); expect(stop).toHaveBeenCalledExactlyOnceWith("stage_unavailable"); expect(ready).not.toHaveBeenCalled();
});
it("throwing onStage disposes before the failure can escape rendering", async () => {
  const f = await mount("en", { onStage: () => { throw Error("callback"); } }); expect(f.api.dispose).toHaveBeenCalledTimes(1); expect(f.onStop).toHaveBeenCalledTimes(1);
});

it("Close still dismisses an already stopped or automatically retired panel exactly once", async () => {
  const f = await mount(); shell(false).querySelector(".effect-trial-controls button")!.click(); shell(false).querySelector(".effect-trial-head button")!.click(); shell(false).querySelector(".effect-trial-head button")!.click();
  expect(f.onStop).toHaveBeenCalledExactlyOnceWith("stopped"); expect(f.onClose).toHaveBeenCalledExactlyOnceWith("stopped"); expect(f.api.dispose).toHaveBeenCalledTimes(1);
});

it("non-string titles never render a caller-supplied vnode", async () => { await mount("en", { title: h("input", { value: "not allowed" }) }); expect(p!.document.querySelector("input")).toBeNull(); });

it("unmount before stylesheet readiness ends the captured lease and a late load cannot create a stage", async () => {
  p = page(); const stop = vi.fn(); await p.mount(h(EffectTrialPanel, { window:p.window, binding:binding(), current:()=>true, onStop:stop }));
  const root=shell(false), link=root.querySelector("link"); expect(mock.create).not.toHaveBeenCalled(); await p.unmount(); link.dispatchEvent({type:"load"}); expect(mock.create).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledExactlyOnceWith("stopped"); expect(root.children).toHaveLength(0);
});
