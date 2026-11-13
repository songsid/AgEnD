import { afterAll, beforeAll, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
let p: AppPage, nav: any, store: any, ctx: any, shell: any, settings: any, forms: any, confirm: any, controller: any;
let width = 1000;
const sessions: Record<string, any> = {}, models: Record<string, any> = {};
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/agent/alpha" });
  (p.window as any).innerWidth = 1400;
  (globalThis as any).ResizeObserver = class {
    constructor(private changed: () => void) {}
    observe(el: any) { el.getBoundingClientRect = () => ({ width, height: 800 }); this.changed(); }
    disconnect() {}
  };
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as any;
  nav = await import("/assets/app-nav.js"); store = await import("/assets/app-store.js"); ctx = await import("/assets/app-ctx.js");
  shell = await import("/assets/app-shell.js"); settings = await import("/ui/js/agent-details-settings.js"); forms = await import("/ui/js/settings-dialogs.js");
  confirm = await import("/assets/ui-confirm.js"); (globalThis as any).confirm = undefined;
  nav.startRouter(p.window);
  controller = (await import("/ui/js/chat-workspace-navigation.js") as any).installWorkspaceNavigation(nav);
  store.applyStatus({ instances: ["alpha", "beta"].map(name => ({ name, backend: "claude-code", status: "running" })) });
});
afterAll(async () => { controller.close(); await p.unmount(); p.restore(); delete (globalThis as any).ResizeObserver; delete (globalThis as any).fetch; });
it("suspends only DOM readers while retaining both Settings drafts and the hidden pane's leave guard", async () => {
  function Form({ name, sess }: any) {
    models[name] = forms.useAgentForm({ name, inst: {}, ctx: { fleet: { defaults: {} }, schema: {}, formMemory: sess.formMemory } });
    return h("input", { value: models[name].f.description });
  }
  function Panel({ route, navKey }: any) {
    const sess = settings.useAgentSettings({ name: route.instance, lease: ctx.useLease(navKey), enabled: false, navKey });
    sessions[route.instance] = sess;
    return h("div", { class: "panel" }, h(shell.PanelHeader, { title: route.instance }), h(Form, { key: sess.epoch, name: route.instance, sess }));
  }
  const panels = new Map(["details", "chat"].map(view => [view, { Component: Panel }]));
  const Workspace = (await import("/ui/js/chat-workspace.js") as any).createWorkspaceHost(controller);
  function Root() { return h(Workspace, { nav: store.useStore(nav.navStore), panels }); }
  controller.open("beta"); controller.pane("b").navigate("/ui/fleet/agent/beta");
  await p.mount(h(Root)); await settle(5);
  models.alpha.set("description")("Keep A"); models.beta.set("description")("Keep B");
  sessions.alpha.stage("agent:alpha", { label: "Keep A" }); sessions.beta.stage("agent:beta", { label: "Keep B" }); await settle();
  width = 650; p.window.dispatchEvent({ type: "resize" } as any); await settle(5);
  expect(p.root.querySelectorAll(".ws-pane")).toHaveLength(1);
  controller.focus("a"); await settle(5);
  expect(models.alpha.pending().description).toBe("Keep A"); expect(sessions.alpha.staged.size).toBe(1);
  // B is not mounted, but replacing B still consults B's draft before changing the address.
  controller.pane("b").navigate("/ui/chat/gamma"); await settle();
  expect(confirm.confirmStore.get().queue).toHaveLength(1);
  confirm.answerConfirm(confirm.confirmStore.get().queue[0].id, false); await settle();
  expect(controller.current().b.route.instance).toBe("beta");
  controller.focus("b"); await settle(5);
  expect(models.beta.pending().description).toBe("Keep B"); expect(sessions.beta.staged.size).toBe(1);
  width = 1000; p.window.dispatchEvent({ type: "resize" } as any); await settle(5);
  expect(p.root.querySelectorAll(".ws-pane")).toHaveLength(2);
  expect(models.alpha.pending().description).toBe("Keep A"); expect(models.beta.pending().description).toBe("Keep B");
  // Accepting a real leave clears the draft even if the other pane then cancels that navigation.
  width = 650; p.window.dispatchEvent({ type: "resize" } as any); await settle(5);
  nav.navigate("/ui/needs"); await settle(); confirm.answerConfirm(confirm.confirmStore.get().queue[0].id, true); await settle();
  expect(confirm.confirmStore.get().queue).toHaveLength(1);
  const discarded = sessions.alpha.staged.size ? "beta" : "alpha";
  confirm.answerConfirm(confirm.confirmStore.get().queue[0].id, false); await settle();
  controller.focus(discarded === "alpha" ? "a" : "b"); await settle(5);
  expect(models[discarded].pending()).toEqual({}); expect(sessions[discarded].staged.size).toBe(0);
  expect(controller.current().b.route.instance).toBe("beta");
});
