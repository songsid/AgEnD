// #1408 §5: the app-wide state every panel and the sidebar read — the instances and what the stream says about them.
// It lives as long as the page; panels come and go. A tiny observable: subscribe(fn) → unsubscribe; a change notifies
// once per update. Chat's own state (messages, drafts, files…) is the chat store (chat-store.js), page-lived as well.
import { useEffect, useState } from "./app-html.js";

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : { ...state, ...patch };
      if (next === state) return;
      state = next;
      for (const fn of [...subs]) fn(state);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/** The app's store. `ready`: a status frame has arrived (before it, an unknown instance may just not be listed yet).
 *  `exec`: each instance's raw execution state (working / idle / stuck / null); `awaiting`: what it
 *  waits on at its terminal (text, "" when unknown), absent when it waits on nothing. `hydration`: a late catch-up
 *  (app-stream.js catchUp) — "catching" / "retrying" / "failed" / "ok"; `retryHydration` asks for it again.
 *  `connections`: how many chat connections the fleet has (#1519 P7: 0 is web-only — the first-run card); null until known. */
export const appStore = createStore({ ready: false, instances: [], uptime: 0, exec: {}, awaiting: {}, connection: "connecting", needs: [], connections: null,
  hydration: "none", retryHydration: null, canvasWorker: typeof document !== "undefined" && document.body?.dataset.canvasWorker === "1" });

/**
 * #1920 phase 3: this page is a guest's — the server says so on <body> (data-tier="guest"). A guest sees only its own
 * agents' chats: no fleet, Needs you, View, Settings, filters, commands or new agent, and nothing it may not read is asked
 * for (each would be refused). The server checks every request regardless; this only keeps the page to what works.
 */
export function guestPage() {
  return typeof document !== "undefined" && !!document.body && document.body.dataset.tier === "guest";
}
/** Who a guest's page is signed in as: its web name and its platform (the server's, on <body>). */
export function guestBadge() {
  const d = typeof document !== "undefined" && document.body ? document.body.dataset : {};
  return { name: d.guestName || "", platform: d.guestPlatform || "" };
}

/** Fold one status frame (stream or poll) into the store. */
export function applyStatus(d) {
  if (!d || !Array.isArray(d.instances)) return;
  const exec = {}, awaiting = {};
  for (const i of d.instances) {
    // The raw execution state, as the "activity" events carry it; `state` may be the presentation "awaiting_input".
    exec[i.name] = (i.execution_state !== undefined ? i.execution_state : i.state) ?? null;
    if (i.state === "awaiting_input") awaiting[i.name] = typeof i.interaction_summary === "string" ? i.interaction_summary : "";
  }
  appStore.set({ canvasWorker: d.canvas_worker === true, ready: true, instances: d.instances, uptime: d.uptime ?? 0, exec, awaiting,
    startup: d.startup?.phase === "starting" ? d.startup : null,
    connections: typeof d.connections === "number" ? d.connections : null,
    // #1665: the host preferences' revision (app-prefs.js re-reads them when it moves).
    prefsRev: typeof d.prefs_rev === "number" ? d.prefs_rev : null,
    // #1629: the agents' themes' revision (app-themes.js re-reads them when it moves).
    themesRev: typeof d.themes_rev === "number" ? d.themes_rev : null,
    // #1685: host memory pressure slowing or holding new agents ("elevated" | "critical"), else null.
    hostMemory: d.host_memory === "elevated" || d.host_memory === "critical" ? d.host_memory : null,
    // #2015: while it lasts, the largest processes in the fleet and whose they are (at most 3; anything else dropped).
    hostMemoryTop: hostMemoryTop(d.host_memory_top) });
}

/** #2015: the status frame's host_memory_top, as the dashboard keeps it: well-formed entries only, at most 3. */
export function hostMemoryTop(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).flatMap(p => p && typeof p.name === "string" && Number.isSafeInteger(p.pid) && Number.isSafeInteger(p.rssBytes) && p.rssBytes >= 0
    && ["fleet", "tmux", "instance", "other"].includes(p.owner)
    ? [{ name: p.name.slice(0, 64), pid: p.pid, rssBytes: p.rssBytes, owner: p.owner, ...(p.owner === "instance" && typeof p.instance === "string" ? { instance: p.instance.slice(0, 128) } : {}) }]
    : []);
}

/** One "activity" event: an instance started or stopped working. */
export function applyActivity(d) {
  if (!d || typeof d.instance !== "string") return;
  appStore.set(s => ({ ...s, exec: { ...s.exec, [d.instance]: d.state ?? null } }));
}

/** Re-render on every store change; returns the current state. */
export function useStore(store = appStore) {
  const [state, setState] = useState(store.get());
  useEffect(() => { setState(store.get()); return store.subscribe(setState); }, [store]);
  return state;
}
