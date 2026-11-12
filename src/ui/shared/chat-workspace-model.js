// #3637: topology only. The existing router owns history and guards; the chat store owns drafts and messages.
import { isSafeInstanceName, parseRoute, routePath } from "./app-route.js";

export const PANE_VIEWS = Object.freeze(["chat", "view", "log", "details"]);
const categories = new Set(["overview", "basic", "runtime", "work", "channel", "adv"]);
const keys = ["compare", "paneA", "paneB", "layout", "focus", "ratio", "swap", "catA", "catB", "messageA", "messageB", "floatPane", "floatX", "floatY", "floatW", "floatH"];
export const agentRoute = route => !!route && PANE_VIEWS.includes(route.panel) && isSafeInstanceName(route.instance);
const category = (route, search) => route.panel === "details" && categories.has(new URLSearchParams(search).get("cat"))
  ? new URLSearchParams(search).get("cat") : "";
const cleanSearch = (route, search) => { const cat = category(route, search); return cat ? `?cat=${cat}` : ""; };
const cleanHash = hash => /^#m=[0-9a-f]{1,32}-\d{1,15}$/.test(hash || "") ? hash : "";
// Physical pane minimums live in pane-geometry; a second percentage minimum breaks ultra-wide displays.
const boundedRatio = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : .5;
const layouts = ["right", "stack", "float"];
const cleanRect = value => value && ["x", "y", "width", "height"].every(key => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100000)
  && value.width >= 420 && value.height >= 360 ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
function pane(route, search = "", hash = "", prior) {
  search = cleanSearch(route, search); hash = cleanHash(hash);
  if (prior && prior.route.panel === route.panel && prior.route.instance === route.instance && prior.search === search && prior.hash === hash) return prior;
  return { route: { panel: route.panel, instance: route.instance }, search, hash, seq: (prior?.seq || 0) + 1 };
}

/** An explicit compare link is the only URL that restores two panes. An ordinary deep link stays single. */
export function readWorkspace(url, previous = null, allowFloat = false) {
  const route = parseRoute(url.pathname), q = url.searchParams;
  if (!agentRoute(route) || !q.has("compare") || keys.some(key => q.getAll(key).length > 1)) return null;
  const second = q.get("compare"), aView = q.get("paneA") || route.panel, bView = q.get("paneB") || "chat";
  if (!isSafeInstanceName(second) || second === route.instance || !PANE_VIEWS.includes(aView) || !PANE_VIEWS.includes(bView)) return null;
  if (q.has("layout") && !layouts.includes(q.get("layout"))) return null;
  if (q.get("layout") === "float" && !allowFloat) return null; // retained adapters/hosts have no floating geometry
  if (q.has("focus") && !["a", "b"].includes(q.get("focus"))) return null;
  if (q.has("floatPane") && !["a", "b"].includes(q.get("floatPane"))) return null;
  const boxKeys = ["floatX", "floatY", "floatW", "floatH"];
  const rect = boxKeys.some(key => q.has(key)) ? cleanRect(Object.fromEntries(["x", "y", "width", "height"].map((key, i) => [key, q.has(boxKeys[i]) ? Number(q.get(boxKeys[i])) : NaN]))) : null;
  if (boxKeys.some(key => q.has(key)) && !rect) return null;
  const a = { panel: aView, instance: route.instance }, b = { panel: bView, instance: second };
  return { a: pane(a, q.has("catA") ? `?cat=${q.get("catA")}` : url.search, q.get("messageA") ? `#m=${q.get("messageA")}` : url.hash, previous?.a),
    b: pane(b, q.has("catB") ? `?cat=${q.get("catB")}` : "", q.get("messageB") ? `#m=${q.get("messageB")}` : "", previous?.b),
    focus: q.get("focus") || "b", layout: q.get("layout") || "right", ratio: q.has("ratio") ? boundedRatio(q.get("ratio")) : .5,
    flipped: q.get("swap") === "1", ...(q.get("layout") === "float" ? { floating: q.get("floatPane") || "b", rect } : {}) };
}
export function workspacePath(w) {
  const q = new URLSearchParams({ compare: w.b.route.instance, paneB: w.b.route.panel, layout: w.layout, focus: w.focus });
  if (w.ratio !== .5) q.set("ratio", String(w.ratio));
  if (w.flipped) q.set("swap", "1");
  if (w.layout === "float") {
    q.set("floatPane", w.floating === "a" ? "a" : "b");
    const rect = cleanRect(w.rect);
    if (rect) for (const [key, value] of Object.entries(rect)) q.set({ x: "floatX", y: "floatY", width: "floatW", height: "floatH" }[key], String(value));
  }
  for (const id of ["a", "b"]) {
    const suffix = id.toUpperCase(), p = w[id], cat = category(p.route, p.search);
    if (cat) q.set(`cat${suffix}`, cat);
    if (p.hash) q.set(`message${suffix}`, p.hash.slice(3));
  }
  return `${routePath(w.a.route)}?${q}`;
}
export function openBeside(w, current, name, layout = "right") {
  if (!isSafeInstanceName(name) || !["right", "stack"].includes(layout)) return w;
  if (w) {
    const existing = ["a", "b"].find(id => w[id].route.instance === name);
    if (existing) return { ...w, focus: existing };
    const id = w.focus === "a" ? "b" : "a";
    return { ...w, [id]: pane({ panel: "chat", instance: name }, "", "", w[id]), focus: id, layout };
  }
  if (!agentRoute(current) || current.instance === name) return null;
  return { a: pane(current), b: pane({ panel: "chat", instance: name }), focus: "b", layout, ratio: .5, flipped: false };
}
export function navigatePane(w, id, url) {
  const route = parseRoute(url.pathname);
  if (!w || !["a", "b"].includes(id) || !agentRoute(route)) return null;
  const existing = ["a", "b"].find(key => w[key].route.instance === route.instance);
  if (existing) id = existing;
  return { ...w, [id]: pane(route, url.search, url.hash, w[id]), focus: id };
}
export function twoPaneFits(viewport, width, height, layout) {
  return viewport >= 1200 && width >= 760 && (layout !== "stack" || height >= 648) && (layout !== "float" || height >= 368);
}
/** This schema intentionally cannot carry credentials, request bodies, drafts, anchors or arbitrary query strings. */
export function saveWorkspace(w) {
  const saved = id => ({ instance: w[id].route.instance, panel: w[id].route.panel, category: category(w[id].route, w[id].search) });
  return { v: 1, a: saved("a"), b: saved("b"), focus: w.focus, layout: w.layout, ratio: w.ratio, flipped: w.flipped,
    ...(w.layout === "float" ? { floating: w.floating === "a" ? "a" : "b", rect: cleanRect(w.rect) } : {}) };
}
export function restoreWorkspace(saved) {
  if (!saved || saved.v !== 1 || !agentRoute(saved.a) || !agentRoute(saved.b) || saved.a.instance === saved.b.instance
    || !["a", "b"].includes(saved.focus) || !layouts.includes(saved.layout)) return null;
  const from = p => pane(p, categories.has(p.category) ? `?cat=${p.category}` : "");
  return { a: from(saved.a), b: from(saved.b), focus: saved.focus, layout: saved.layout,
    ratio: boundedRatio(saved.ratio), flipped: saved.flipped === true,
    ...(saved.layout === "float" ? { floating: saved.floating === "a" ? "a" : "b", rect: cleanRect(saved.rect) } : {}) };
}

/** A drop changes topology through the same router/guards; never duplicates an existing agent or changes its pane lease. */
export function dockWorkspace(w, target, zone, name) {
  if (!w || !["a", "b"].includes(target) || !["left", "right", "top", "bottom", "center"].includes(zone) || !isSafeInstanceName(name)) return w;
  const source = ["a", "b"].find(id => w[id].route.instance === name);
  if (zone === "center" && source) return source === target ? w : { ...w, focus: source,
    ...(w.layout === "float" ? { floating: w.floating === "a" ? "b" : "a" } : { flipped: !w.flipped }) };
  const id = source || target;
  const next = source ? w : { ...w, [id]: pane({ panel: "chat", instance: name }, "", "", w[id]) };
  if (zone === "center") return { ...next, focus: id };
  const { floating, rect, ...docked } = next;
  return { ...docked, focus: id, layout: ["left", "right"].includes(zone) ? "right" : "stack", ratio: .5,
    flipped: ["left", "top"].includes(zone) ? id === "b" : id === "a" };
}
