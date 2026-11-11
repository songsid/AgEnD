// #2072 part 3: what a backend or model field in Settings offers — the host's published availability (installed,
// signed in, new enough: /ui/backends) and the model catalog of that backend for that instance's account (/ui/models).
// Both answers are the server's cached ones; nothing here makes the server probe. A page asks once and reuses the answer
// for a short while, so opening several dialogs costs one request each.
import { useEffect, useRef, useState } from "/assets/app-html.js";

const TTL_MS = 30_000;
const cache = new Map();   // url → { at, value, pending }

async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
/** The answer for `url`, shared by every field on the page while it is fresh; null when it cannot be read. */
function cached(url, force = false) {
  const hit = cache.get(url), now = performance.now();
  if (hit && (hit.pending || !force && now - hit.at < TTL_MS)) return hit.pending ?? Promise.resolve(hit.value);
  const entry = { at: now, value: null, pending: null };
  const pending = getJson(force ? `${url}&refresh=1` : url).then((value) => {
    // Explicit rediscovery/reset may have replaced this request while it waited.
    if (cache.get(url) === entry) cache.set(url, { at: performance.now(), value, pending: null });
    return value;
  }).catch(() => { if (cache.get(url) === entry) cache.delete(url); return null; });
  entry.pending = pending;
  cache.set(url, entry);
  return pending;
}
/**
 * Drop every remembered answer. Only tests call it today: a page keeps an answer TTL_MS, so a sign-in or a newly
 * cached catalog shows within that time, or at once on the next page load.
 */
export function forgetCatalogs() { cache.clear(); }

function useAnswer(url) {
  const [value, setValue] = useState(undefined);   // undefined: loading; null: unavailable
  useEffect(() => {
    if (!url) { setValue(null); return undefined; }
    let live = true;
    setValue(undefined);
    cached(url).then((v) => { if (live) setValue(v); });
    return () => { live = false; };
  }, [url]);
  return value;
}

/** The host's backends with their state ({ name, state, minVersion, … }), or null while loading or unavailable. */
export function useBackendRows() {
  const answer = useAnswer("/ui/backends");
  return answer && Array.isArray(answer.backends) ? answer.backends : answer === undefined ? undefined : null;
}

/** Runtime and account are part of the key: Windows never borrows a WSL catalog. */
export function useModelCatalogState(backend, instance, runtime, machineId) {
  const url = backend ? `/ui/models?backend=${encodeURIComponent(backend)}${instance ? `&instance=${encodeURIComponent(instance)}` : ""}${runtime === "windows" ? "&runtime=windows" : ""}${machineId ? `&machineId=${encodeURIComponent(machineId)}` : ""}` : null;
  const [state, setState] = useState({ url:null, answer:null, loading:false });
  const generation = useRef(0), active = useRef(url);
  active.current = url;
  const load = (force = false) => {
    if (!url) return;
    const mine = ++generation.current;
    setState(old => ({ url, answer:old.url === url ? old.answer : null, loading:true }));
    cached(url, force).then(answer => {
      if (active.current === url && generation.current === mine) setState({ url, answer, loading:false });
    });
  };
  useEffect(() => {
    if (url) load();
    return () => { generation.current++; };
  }, [url]);
  const current = state.url === url ? state : { answer:null, loading:!!url };
  const valid = current.answer && Array.isArray(current.answer.models);
  return {
    models: valid ? current.answer.models : [],
    loading: !!url && current.loading,
    error: !!url && !current.loading && !valid,
    source: valid ? current.answer.source : null,
    refresh: () => load(true),
  };
}

/** Compatibility for callers that only need the model list. */
export function useModelCatalog(backend, instance, runtime) {
  const state = useModelCatalogState(backend, instance, runtime);
  return state.loading && !state.models.length ? undefined : state.models;
}

/** Shared snapshot cache for upgraded fields; accessed through a namespace so old held modules still load. */
export function readModelCatalog(target) { return readModelCatalogSnapshot(target).then(answer => answer.models); }
/** Keep source provenance with the shared snapshot; the array-only API remains compatible with older pickers. */
export function readModelCatalogSnapshot(target) {
  const url = `/ui/models?${new URLSearchParams(target)}`;
  return cached(url).then(answer => { if (!answer || !Array.isArray(answer.models)) throw Error("Model catalog unavailable"); return answer; });
}
export function rememberModelCatalog(target, answer) {
  cache.set(`/ui/models?${new URLSearchParams(target)}`, { at: performance.now(), value: answer, pending: null });
}

/** A state that keeps a backend from being chosen (shown, disabled, with why); "unknown" never does. */
export const BLOCKING_STATES = ["not_installed", "not_signed_in", "too_old"];

/**
 * The backend select's options: every backend the page knows, in its order, each with what the host said about it.
 * The current value is always selectable — a probe never disables what an agent already runs — and one the page does
 * not know (a removed backend) stays first, as before.
 */
export function backendChoices(known, rows, value, words) {
  const byName = new Map((rows || []).map((r) => [r.name, r]));
  const choice = (name) => {
    const row = byName.get(name), state = row ? row.state ?? (row.installed ? "usable" : row.unknown ? "unknown" : "not_installed") : null;
    const blocked = !!state && BLOCKING_STATES.includes(state) && name !== value;
    const note = state === "not_installed" ? words.notInstalled : state === "not_signed_in" ? words.notSignedIn
      : state === "too_old" ? words.tooOld(row.minVersion ?? "?") : state === "unknown" && name !== value ? words.unchecked : "";
    const shown = words.name ? words.name(name) : name;   // M-2733: its product name ("Claude Code"); the value stays the id
    return { value: name, label: note ? `${shown} — ${note}` : shown, disabled: blocked };
  };
  const list = known.map(choice);
  return known.includes(value) || !value ? list : [{ value, label: words.removed(value), disabled: false }, ...list];
}

/** The id of the "type another model" choice (never a model name: it has a space). */
export const OTHER_MODEL = "\u0000other";

/**
 * The model select's options: the inherited choice (empty value), the current model first when the catalog does not
 * list it (marked), the catalog, and "Other…" for a name the CLI does not list. An entry that stands for several
 * catalog names (`aliases`: antigravity's effort levels of one model) is selected by any of them, so a saved value is
 * shown as that entry and is only rewritten when another entry is chosen. An entry's `group` (a newer daemon's, e.g.
 * "common" / "more") is carried on its option; a catalog without any is the flat list it always was.
 */
export function modelChoices(catalog, value, words, inherit) {
  const list = [];
  if (inherit) list.push({ value: "", label: inherit });
  const entries = catalog || [];
  const stands = (m) => m.id === value || (Array.isArray(m.aliases) && m.aliases.includes(value));
  if (value && !entries.some(stands)) list.push({ value, label: `${value} — ${words.notListed}` });
  for (const m of entries) {
    list.push({ value: value && stands(m) ? value : m.id, label: m.description ? `${m.label || m.id} — ${m.description}` : (m.label || m.id), ...(m.group ? { group: m.group } : {}) });
  }
  list.push({ value: OTHER_MODEL, label: words.other });
  return list;
}

/**
 * The options as `<optgroup>`s: `[{ group, options }]` in order, `group` null for the ones outside any (inherit, the
 * current-but-unlisted value, the models a catalog leaves ungrouped, "Other…"). Groups are headings that tell two sets
 * apart, so with fewer than two groups there is one ungrouped run — the flat list — except for a lone "unverified" or
 * "oneMillion" one: that heading is itself the information (ids not seen in this account / plan-dependent), so it stays.
 */
export function groupModelOptions(options) {
  const groups = new Set(options.map((o) => o.group).filter(Boolean));
  if (groups.size < 2 && !groups.has("unverified") && !groups.has("oneMillion")) return [{ group: null, options }];
  const runs = [];
  for (const o of options) {
    const g = o.group || null, last = runs[runs.length - 1];
    if (last && last.group === g) last.options.push(o); else runs.push({ group: g, options: [o] });
  }
  return runs;
}
