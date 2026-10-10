// #1523 N2: another page asks Settings to open one agent's dialog ("Edit in Settings" on Details). One request, taken
// once by Settings when its data is in; the agent is opened only if Settings knows it (its own config, its own rules).
let wanted = null;
export function requestAgentSettings(name) { wanted = typeof name === "string" && name ? name : null; }
export function takeAgentRequest() { const n = wanted; wanted = null; return n; }
