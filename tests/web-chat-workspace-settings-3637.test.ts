import { afterAll, beforeAll, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
let p: AppPage, nav: any, shell: any, store: any, ctx: any, settings: any, confirm: any, entry: any;
const sessions: Record<string, any> = {};
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/agent/alpha" }); (p.window as any).innerWidth = 1400;
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as any;
  nav = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js"); store = await import("/assets/app-store.js");
  ctx = await import("/assets/app-ctx.js"); settings = await import("/ui/js/agent-details-settings.js"); confirm = await import("/assets/ui-confirm.js");
  (globalThis as any).confirm = undefined; nav.startRouter(p.window);
  store.applyStatus({ instances: ["alpha", "beta"].map(name => ({ name, backend: "claude-code", status: "running" })) });
});
afterAll(async () => { store.appStore.get().chatWorkspaceSessionEnd?.(); await p.unmount(); shell.shellStore.set({ workspaceHost: null }); p.restore(); delete (globalThis as any).fetch; });
it("first split and closing to one pane cannot silently discard a retained Settings form", async () => {
  function Panel({ route, navKey }: any) {
    sessions[route.instance] = settings.useAgentSettings({ name: route.instance, lease: ctx.useLease(navKey), enabled: false, navKey });
    return h("div", { class: "panel" }, h(shell.PanelHeader, { title: route.instance }));
  }
  const panels = new Map(["chat", "details"].map(view => [view, { Component: Panel }]));
  function Root() {
    const n = store.useStore(nav.navStore), s = store.useStore(shell.shellStore);
    return s.workspaceHost ? h(s.workspaceHost, { nav: n, panels }) : h(shell.Outlet, { route: n.route, seq: n.seq, panels });
  }
  await p.mount(h(Root)); sessions.alpha.stage("name", { label: "Unsaved" }); await settle();
  entry = (await import("/ui/js/chat-workspace.js") as any).installWorkspaceEntry({ nav, ready: async () => ({}), chat: {} });
  await entry.open("beta"); await settle(5);
  expect(confirm.confirmStore.get().queue).toHaveLength(1);
  expect(nav.navStore.get().workspace).toBeFalsy(); expect(sessions.alpha.staged.size).toBe(1);
  confirm.answerConfirm(confirm.confirmStore.get().queue[0].id, false); await settle();
  expect(sessions.alpha.staged.size).toBe(1);
  await entry.open("beta"); await settle(); confirm.answerConfirm(confirm.confirmStore.get().queue[0].id, true); await settle(5);
  expect(nav.navStore.get().workspace.b.route.instance).toBe("beta");
  nav.navigate("/ui/fleet/agent/beta"); await settle(); sessions.beta.stage("name", { label: "Keep beta" }); await settle();
  // Close A, keeping B as the full-width pane. B's component will remount, so its unsaved form still needs its guard.
  const w = nav.navStore.get().workspace;
  nav.navigate("/ui/fleet/agent/beta", { workspace: true }); await settle();
  expect(confirm.confirmStore.get().queue).toHaveLength(1); expect(nav.navStore.get().workspace).toBe(w);
  confirm.answerConfirm(confirm.confirmStore.get().queue[0].id, false); await settle(); expect(sessions.beta.staged.size).toBe(1);
});
