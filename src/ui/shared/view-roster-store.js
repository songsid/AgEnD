// View's roster read (/api/profiles), shared by the View panel (its cards) and the anonymous reader's sidebar list
// (instance-nav.js), for as long as the page lives. The View panel fills it while mounted; nothing else reads the server.
import { createStore } from "./app-store.js";

export const viewStore = createStore({ loaded: false, error: null, roster: [], current: null });
