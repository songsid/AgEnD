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
 *  (app-stream.js catchUp) — "catching" / "retrying" / "failed" / "ok"; `retryHydration` asks for it again. */
export const appStore = createStore({ ready: false, instances: [], uptime: 0, exec: {}, awaiting: {}, connection: "connecting", needs: [],
  hydration: "none", retryHydration: null });

/** Fold one status frame (stream or poll) into the store. */
export function applyStatus(d) {
  if (!d || !Array.isArray(d.instances)) return;
  const exec = {}, awaiting = {};
  for (const i of d.instances) {
    // The raw execution state, as the "activity" events carry it; `state` may be the presentation "awaiting_input".
    exec[i.name] = (i.execution_state !== undefined ? i.execution_state : i.state) ?? null;
    if (i.state === "awaiting_input") awaiting[i.name] = typeof i.interaction_summary === "string" ? i.interaction_summary : "";
  }
  appStore.set({ ready: true, instances: d.instances, uptime: d.uptime ?? 0, exec, awaiting });
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
