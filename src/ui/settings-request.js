// #1523 N2: another page asks Settings to open one instance's dialog ("Edit in Settings" on Details). One request,
// taken once by Settings when its data is in; it opens only what Settings itself knows (its own config, its own
// rules): an agent of fleet.yaml, or a ClassicBot room of classicBot.yaml (#1561 review: the split stays).
let wanted = null;
/** kind: "agent" | "classic". */
export function requestAgentSettings(name, kind = "agent") {
  wanted = typeof name === "string" && name ? { name, kind: kind === "classic" ? "classic" : "agent" } : null;
}
export function takeAgentRequest() { const w = wanted; wanted = null; return w; }
