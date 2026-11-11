// #3637: an optional adapter to app-nav, never a second router, popstate listener or history owner.
import { parseRoute, routePath } from "/assets/app-route.js";
import { agentRoute, navigatePane, openBeside, readWorkspace, workspacePath } from "/assets/chat-workspace-model.js";

export function installWorkspaceNavigation(nav, { beforeLayout = () => {}, onWorkspace = () => {} } = {}) {
  const guards = new Map(), panes = new Map(), retained = new Map();
  const dispose = record => {
    record.alive = false;
    for (const off of record.offs) off();
    const forms = record.state.get("forms");
    forms?.state.clear(); forms?.listeners.clear();
    record.offs.clear(); record.state.clear(); record.listeners.clear();
  };
  const page = window, doc = document, pending = new Set();
  let alive = true;
  const schedule = fn => {
    let cancel;
    const run = () => { pending.delete(cancel); if (alive) fn(); };
    if (typeof page.requestAnimationFrame === "function") { const id = page.requestAnimationFrame(run); cancel = () => page.cancelAnimationFrame(id); }
    else { const id = setTimeout(run, 0); cancel = () => clearTimeout(id); }
    pending.add(cancel);
  };
  const current = () => alive ? nav.navStore.get().workspace : null;
  const address = () => new URL(nav.navStore.get().path || location.href, location.href);
  const target = w => ({ route: w[w.focus].route, workspace: w, path: workspacePath(w) });
  const go = (w, opts = {}) => nav.navigate(workspacePath(w), { ...opts, workspace: true });
  const off = nav.installNavigation({
    beforePublish(next, before) {
      const a = before.workspace, b = next.workspace;
      for (const [key, record] of retained) {
        const route = b?.[record.id]?.route;
        if (!route || route.panel !== record.route.panel || route.instance !== record.route.instance) { dispose(record); retained.delete(key); }
      }
      if (b) onWorkspace();
      if (a && b && (a.layout !== b.layout || a.flipped !== b.flipped)) beforeLayout();
    },
    resolve(url, before, { mode, opts }) {
      let w = null;
      if (mode === "navigate" && !opts.workspace && before.workspace && agentRoute(parseRoute(url.pathname)) && !url.searchParams.has("compare")) {
        w = navigatePane(before.workspace, before.workspace.focus, url);
      } else w = readWorkspace(url, before.workspace);
      return w ? target(w) : { route: parseRoute(url.pathname), workspace: null, path: url.pathname + url.search + url.hash };
    },
    refresh(s) {
      if (!s.workspace) return { ...s, seq: s.seq + 1 };
      const w = s.workspace, id = w.focus;
      return { ...s, ...target({ ...w, [id]: { ...w[id], seq: w[id].seq + 1 } }), seq: s.seq + 1 };
    },
  });
  function pane(id) {
    if (panes.has(id)) return panes.get(id);
    const value = {
      // Only page-local draft state survives a compact-layout suspension. No DOM, readers or credentials are persisted.
      retain(key) {
        const route = current()?.[id]?.route;
        if (!route) return null;
        const name = `${id}:${key}`;
        if (retained.has(name)) return retained.get(name);
        const record = { id, route, alive: true, state: new Map(), listeners: new Map(), offs: new Set(),
          current: () => alive && record.alive && retained.get(name) === record,
          hold(off) { record.offs.add(off); },
          set(key, next) {
            if (!record.current()) return;
            const value = typeof next === "function" ? next(record.state.get(key)) : next;
            record.state.set(key, value); record.listeners.get(key)?.(value);
          },
        };
        retained.set(name, record); return record;
      },
      navigate(path, opts = {}) {
        // A guard's yes resumes the exact full URL it was asked about, including a close/swap/global navigation.
        if (opts.skipGuard) { nav.navigate(path, { ...opts, skipGuard: guards.get(opts.skipGuard), workspace: true }); return; }
        const w = current(), url = new URL(path, location.href);
        const next = w && navigatePane(w, id, url);
        if (next) go(next, opts); else nav.navigate(path, { ...opts, workspace: true });
      },
      addLeaveGuard(fn) {
        const wrapped = (route, path, next) => fn(next?.workspace?.[id]?.route || route, path, next);
        guards.set(fn, wrapped);
        const remove = nav.addLeaveGuard(wrapped);
        return () => { remove(); guards.delete(fn); };
      },
    };
    panes.set(id, value); return value;
  }
  return {
    current, pane,
    focusedName: () => nav.navStore.get().route?.instance,
    open(name, layout = "right") {
      const before = current(), w = openBeside(before, nav.navStore.get().route, name, layout);
      if (w) {
        // First split retains the original local category and message anchor.
        if (!before) { const url = address(); w.a = { ...w.a, search: url.search, hash: url.hash }; }
        go(w);
      }
    },
    focus(id, { moveFocus = false } = {}) {
      const w = current(); if (!w || !["a", "b"].includes(id)) return;
      if (w.focus !== id) go({ ...w, focus: id }, { replace: true });
      if (moveFocus) {
        schedule(() => {
          const now = current(); if (!now || now.focus !== id || now[id] !== w[id]) return;
          const region = doc.querySelector(`.ws-pane[data-pane="${id}"]`);
          (region?.querySelector(".composer-box textarea:not([disabled])") || region?.querySelector("h1"))?.focus();
        });
      }
    },
    layout(layout) {
      const w = current(); if (!w || !["right", "stack"].includes(layout) || w.layout === layout) return;
      go({ ...w, layout });
    },
    swap() { const w = current(); if (w) go({ ...w, flipped: !w.flipped }); },
    closePane(id) {
      const w = current(); if (!w) return;
      const kept = w[id === "a" ? "b" : "a"];
      nav.navigate(routePath(kept.route) + kept.search + kept.hash, { workspace: true });
      const next = nav.navStore.get();
      if (next.workspace || next.route?.instance !== kept.route.instance) return;
      schedule(() => { if (nav.navStore.get() === next) doc.querySelector("#main .panel-head h1")?.focus(); });
    },
    restore(w) { if (w) go(w, { replace: true }); },
    restoreAddress() { const w = readWorkspace(address()); if (w) go(w, { replace: true }); },
    close() { if (!alive) return; alive = false; for (const cancel of pending) cancel(); pending.clear(); for (const record of retained.values()) dispose(record); retained.clear(); off(); },
  };
}
