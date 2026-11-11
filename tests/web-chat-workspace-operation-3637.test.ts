import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
const rig = vi.hoisted(() => ({ start: vi.fn(), take: vi.fn(), read: vi.fn(), data: { fleet: { defaults: {}, instances: { alpha: { description: "" }, beta: { description: "" } } } } }));
vi.mock("/ui/js/settings-apply.js", () => ({ operationActive: () => false, startOperation: rig.start, takeLeftover: rig.take }));
vi.mock("/ui/js/panel-settings.js", async original => ({ ...await original<any>(), loadAll: rig.read }));
let p: AppPage, nav: any, app: any, ctx: any, settings: any, forms: any, host: any, controller: any, seq = 0, width = 1000, enabledAlpha = true;
const sessions: Record<string, any> = {}, models: Record<string, any> = {};
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/agent/alpha" }); (p.window as any).innerWidth = 1400;
  (globalThis as any).fetch = async () => ({ ok: false, json: async () => ({}) });
  (globalThis as any).ResizeObserver = class { constructor(private update: () => void) {} observe(el: any) { el.getBoundingClientRect = () => ({ width, height: 800 }); this.update(); } disconnect() {} };
  nav = await import("/assets/app-nav.js"); app = await import("/assets/app-store.js"); ctx = await import("/assets/app-ctx.js");
  settings = await import("/ui/js/agent-details-settings.js"); forms = await import("/ui/js/settings-dialogs.js"); host = await import("/ui/js/chat-workspace.js");
  await import("/ui/js/panel-settings.js");
  nav.startRouter(p.window); app.applyStatus({ instances: ["alpha", "beta"].map(name => ({ name, backend: "claude-code", status: "running" })) });
  rig.read.mockImplementation(async () => ({ ...rig.data, schema: { impacts: {}, order: ["now", "instance", "fleet"] } }));
  rig.start.mockImplementation((changes: any[]) => { app.appStore.set({ settingsOp: { id: ++seq, phase: "writing", steps: changes, leftover: [] } }); return true; });
});
afterEach(async () => { controller?.close(); await p.unmount(); app.appStore.set({ settingsOp: null }); width = 1000; enabledAlpha = true; for (const inst of Object.values(rig.data.fleet.instances)) inst.description = ""; rig.take.mockReset(); rig.read.mockReset(); rig.read.mockImplementation(async () => ({ ...rig.data, schema: { impacts: {}, order: ["now", "instance", "fleet"] } })); });
afterAll(() => { p.restore(); delete (globalThis as any).fetch; delete (globalThis as any).ResizeObserver; });
async function mount(realForms = false) {
  nav.navigate("/ui/fleet/agent/alpha", { force: true, workspace: true });
  controller = (await import("/ui/js/chat-workspace-navigation.js") as any).installWorkspaceNavigation(nav);
  controller.open("beta"); controller.pane("b").navigate("/ui/fleet/agent/beta");
  function Form({ name, sess }: any) { models[name] = forms.useAgentForm({ name, inst: sess.ctx.fleet.instances[name], ctx: sess.ctx }); return h("input", { value: models[name].f.description }); }
  function Panel({ route, navKey }: any) {
    const sess = settings.useAgentSettings({ name: route.instance, lease: ctx.useLease(navKey), enabled: route.instance !== "alpha" || enabledAlpha, navKey }); sessions[route.instance] = sess;
    return sess.ctx ? realForms ? h(settings.AgentSettingsPanels, { name: route.instance, kind: "fleet", cat: "basic", sess, onDirty: () => {} }) : h(Form, { key: sess.epoch, name: route.instance, sess }) : null;
  }
  const Workspace = host.createWorkspaceHost(controller), panels = new Map([["details", { Component: Panel }]]);
  function Root() { return h(Workspace, { nav: app.useStore(nav.navStore), panels }); }
  await p.mount(h(Root)); await settle(7);
  for (const [name, pane] of [["alpha", "a"], ["beta", "b"]]) {
    if (realForms) { const input: any = p.root.querySelector(`#pane-${pane}-ag-desc`); input.value = `Draft ${name}`; fire(input, "input"); }
    else { models[name].set("description")(`Draft ${name}`); sessions[name].stage(`agent:${name}`, { label: name, confirms: [], request: { method: "PUT", url: `/fixture/${name}`, body: { description: `Draft ${name}` } } }); }
  }
  await settle();
}
it("an A-only successful operation resets A while preserving B's staged and typed edits", async () => {
  await mount(); const a = sessions.alpha.epoch, b = sessions.beta.epoch;
  await sessions.alpha.apply(); await settle();
  rig.data = { fleet: { defaults: {}, instances: { alpha: { description: "Draft alpha" }, beta: { description: "" } } } };
  app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, phase: "done" } }); await settle(8);
  expect(sessions.alpha.epoch).toBe(a + 1); expect(models.alpha.pending()).toEqual({});
  expect(sessions.beta.epoch).toBe(b); expect(models.beta.pending()).toEqual({ description: "Draft beta" }); expect(sessions.beta.staged.has("agent:beta")).toBe(true);
});
it.each([false, true])("only the initiating pane consumes its failed leftovers (suspended=%s)", async suspended => {
  await mount(); await sessions.alpha.apply(); await settle();
  if (suspended) { width = 650; p.window.dispatchEvent({ type: "resize" } as any); await settle(5); }
  const leftover = [{ stageKey: "agent:alpha", label: "retry", key: "same-write", request: { method: "PUT", url: "/fixture/alpha", body: { description: "Draft alpha" } } }];
  rig.take.mockImplementation(() => { const result = app.appStore.get().settingsOp.leftover; app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, leftover: [] } }); return result; });
  app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, phase: "failed", leftover } }); await settle(8);
  if (suspended) { expect(rig.take).not.toHaveBeenCalled(); controller.focus("a"); await settle(8); }
  expect(rig.take).toHaveBeenCalledTimes(1); expect(sessions.alpha.staged.get("agent:alpha")).toMatchObject({ key: "same-write", confirms: [] });
  expect(sessions.beta.staged.has("agent:alpha")).toBe(false); expect(sessions.beta.staged.has("agent:beta")).toBe(true); expect(models.beta.pending().description).toBe("Draft beta");
});
it("an owner suspended at completion resets once on return without resetting the other pane", async () => {
  await mount(); const a = sessions.alpha.epoch, b = sessions.beta.epoch;
  await sessions.alpha.apply(); await settle(); width = 650; p.window.dispatchEvent({ type: "resize" } as any); await settle(5); enabledAlpha = false;
  rig.data = { fleet: { defaults: {}, instances: { alpha: { description: "Draft alpha" }, beta: { description: "" } } } };
  app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, phase: "done" } }); await settle(7);
  controller.focus("a"); await settle(9); expect(models.alpha.inst.description).toBe("Draft alpha"); expect(sessions.alpha.epoch).toBe(a + 1); expect(models.alpha.pending()).toEqual({});
  controller.focus("b"); await settle(5); expect(sessions.beta.epoch).toBe(b); expect(models.beta.pending().description).toBe("Draft beta");
  controller.focus("a"); await settle(7); expect(sessions.alpha.epoch).toBe(a + 1);
});

it("a late completion from the previous owned operation cannot reset the next draft", async () => {
  await mount(); const epoch = sessions.alpha.epoch;
  await sessions.alpha.apply(); await settle();
  let release!: (data: any) => void;
  rig.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, phase: "done" } }); await settle(7);
  expect(release).toBeTypeOf("function");
  models.alpha.set("description")("Next draft"); sessions.alpha.stage("agent:alpha", { label: "next", request: { method: "PUT", url: "/fixture/alpha", body: { description: "Next draft" } } }); await settle();
  await sessions.alpha.apply(); await settle();
  release({ fleet: { defaults: {}, instances: { alpha: { description: "Draft alpha" }, beta: { description: "" } } } }); await settle(8);
  expect(sessions.alpha.epoch).toBe(epoch); expect(models.alpha.pending().description).toBe("Next draft");
  rig.data = { fleet: { defaults: {}, instances: { alpha: { description: "Next draft" }, beta: { description: "" } } } };
  app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, phase: "done" } }); await settle(8);
  expect(sessions.alpha.epoch).toBe(epoch + 1); expect(models.alpha.pending()).toEqual({});
});

function failCurrent(ambiguous = true) {
  const op = app.appStore.get().settingsOp;
  const leftover = op.steps.map(({ key: _key, ...c }: any) => ({ ...c, ...(ambiguous ? { key: "original-ambiguous-write" } : {}) }));
  rig.take.mockImplementation(() => { const result = app.appStore.get().settingsOp.leftover; app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, leftover: [] } }); return result; });
  app.appStore.set({ settingsOp: { ...op, phase: "failed", leftover } });
}
async function suspendA() { width = 650; p.window.dispatchEvent({ type: "resize" } as any); await settle(5); }

it.each(["done", "failed"])("a suspended owner recovers %s after another pane's later operation finishes", async phase => {
  await mount(); const epoch = sessions.alpha.epoch;
  await sessions.alpha.apply(); await settle(); await suspendA();
  if (phase === "done") {
    rig.data = { fleet: { defaults: {}, instances: { alpha: { description: "Draft alpha" }, beta: { description: "" } } } };
    app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, phase } });
  } else failCurrent();
  await settle(); await sessions.beta.apply(); await settle();
  rig.data.fleet.instances.beta.description = "Draft beta";
  app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, phase: "done" } }); await settle(7);
  const betaEpoch = sessions.beta.epoch;
  controller.focus("a"); await settle(10);
  if (phase === "done") { expect(models.alpha.inst.description).toBe("Draft alpha"); expect(sessions.alpha.epoch).toBe(epoch + 1); expect(models.alpha.pending()).toEqual({}); }
  else { expect(sessions.alpha.staged.get("agent:alpha")).toMatchObject({ key: "original-ambiguous-write", confirms: [] }); await sessions.alpha.apply(); expect(rig.start.mock.lastCall![0][0].key).toBe("original-ambiguous-write"); }
  controller.focus("b"); await settle(7); expect(sessions.beta.epoch).toBe(betaEpoch);
});

it.each(["none", "writing", "done"])("actual forms retain a suspended owner's retry key when the second operation is %s", async phase => {
  await mount(true); await sessions.alpha.apply(); await settle(); await suspendA();
  failCurrent(); await settle(7);
  if (phase !== "none") { await sessions.beta.apply(); await settle(); if (phase === "done") { rig.data.fleet.instances.beta.description = "Draft beta"; app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, phase } }); await settle(7); } }
  controller.focus("a"); await settle(10);
  expect((p.root.querySelector("#pane-a-ag-desc") as any).value).toBe("Draft alpha");
  expect(sessions.alpha.staged.get("agent:alpha")).toMatchObject({ key: "original-ambiguous-write", request: { method: "PATCH", url: "/api/settings/fleet/instances/alpha", body: { description: "Draft alpha" } } });
  // Automatic restaging on another remount must preserve the same ambiguous write, not mint a new one.
  controller.focus("b"); await settle(5); controller.focus("a"); await settle(8);
  expect(sessions.alpha.staged.get("agent:alpha").key).toBe("original-ambiguous-write");
  if (phase !== "writing") { await sessions.alpha.apply(); expect(rig.start.mock.lastCall![0][0].key).toBe("original-ambiguous-write"); }
});

it("an actual form refreshes its successful baseline after another pane replaces the global outcome", async () => {
  await mount(true); const epoch = sessions.alpha.epoch;
  await sessions.alpha.apply(); await settle(); await suspendA();
  rig.data = { fleet: { defaults: {}, instances: { alpha: { description: "Draft alpha" }, beta: { description: "" } } } };
  app.appStore.set({ settingsOp: { ...app.appStore.get().settingsOp, phase: "done" } }); await settle();
  await sessions.beta.apply(); await settle(); controller.focus("a"); await settle(10);
  expect(sessions.alpha.epoch).toBe(epoch + 1); expect(sessions.alpha.data.fleet.instances.alpha.description).toBe("Draft alpha");
  expect((p.root.querySelector("#pane-a-ag-desc") as any).value).toBe("Draft alpha"); expect(sessions.alpha.staged.size).toBe(0);
});

it.each(["edited", "refused"])("recovered retry metadata is not reused when its request is %s", async reason => {
  await mount(true); await sessions.alpha.apply(); await settle(); await suspendA(); failCurrent(); await settle();
  controller.focus("a"); await settle(10); expect(sessions.alpha.staged.get("agent:alpha").key).toBe("original-ambiguous-write");
  if (reason === "edited") {
    const input: any = p.root.querySelector("#pane-a-ag-desc"); input.value = "Different request"; fire(input, "input"); await settle(5);
  } else { await sessions.alpha.apply(); await settle(); failCurrent(false); await settle(10); }
  expect(sessions.alpha.staged.get("agent:alpha").key).toBeUndefined();
  await sessions.alpha.apply(); expect(rig.start.mock.lastCall![0][0].key).toBeUndefined();
  if (reason === "edited") expect(rig.start.mock.lastCall![0][0].request.body).toEqual({ description: "Different request" });
});

it("retained outcome observers do not accumulate across suspension and are released when the workspace closes", async () => {
  const subscribe = app.appStore.subscribe;
  let active = 0;
  const spy = vi.spyOn(app.appStore, "subscribe").mockImplementation((fn: any) => {
    const off = subscribe(fn); active++;
    let current = true;
    return () => { if (current) { current = false; active--; off(); } };
  });
  try {
    await mount(); const full = active; expect(full).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) { await suspendA(); controller.focus("a"); await settle(5); width = 1000; p.window.dispatchEvent({ type: "resize" } as any); await settle(5); expect(active).toBe(full); }
    controller.close(); await p.unmount(); expect(active).toBe(0);
  } finally { spy.mockRestore(); }
});
