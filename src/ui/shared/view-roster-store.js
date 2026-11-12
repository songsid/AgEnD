// View's roster read (/api/profiles), shared by the View panel (its cards) and the anonymous reader's sidebar list
// (instance-nav.js), for as long as the page lives. The View panel fills it while mounted; nothing else reads the server.
import { createStore } from "./app-store.js";

export const viewStore = createStore({ loaded: false, error: null, roster: [], current: null });

// Two View panes share this passive roster reader; terminal/history readers still belong to each pane's lease.
let readers = 0, stopReader = null;
export function followRoster(start) {
  if (readers++ === 0) stopReader = start();
  let alive = true;
  return () => { if (!alive) return; alive = false; if (--readers === 0) { const stop = stopReader; stopReader = null; stop?.(); } };
}
