// #2072 part 3: what a backend or model field in Settings offers — the host's published availability (installed,
// signed in, new enough: /ui/backends) and the model catalog of that backend for that instance's account (/ui/models).
// Both answers are the server's cached ones; nothing here makes the server probe. A page asks once and reuses the answer
// for a short while, so opening several dialogs costs one request each.
import { useEffect, useState } from "/assets/app-html.js";

const TTL_MS = 30_000;
const cache = new Map();   // url → { at, value, pending }

async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
/** The answer for `url`, shared by every field on the page while it is fresh; null when it cannot be read. */
function cached(url) {
  const hit = cache.get(url), now = performance.now();
  if (hit && (hit.pending || now - hit.at < TTL_MS)) return hit.pending ?? Promise.resolve(hit.value);
  const pending = getJson(url).then((value) => { cache.set(url, { at: performance.now(), value, pending: null }); return value; })
    .catch(() => { cache.delete(url); return null; });
  cache.set(url, { at: now, value: null, pending });
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

/** The model catalog of `backend` for `instance` (its account) — [] when none is cached; undefined while loading. */
export function useModelCatalog(backend, instance) {
  const url = backend ? `/ui/models?backend=${encodeURIComponent(backend)}${instance ? `&instance=${encodeURIComponent(instance)}` : ""}` : null;
  const answer = useAnswer(url);
  if (answer === undefined) return undefined;
  return answer && Array.isArray(answer.models) ? answer.models : [];
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
    return { value: name, label: note ? `${name} — ${note}` : name, disabled: blocked };
  };
  const list = known.map(choice);
  return known.includes(value) || !value ? list : [{ value, label: words.removed(value), disabled: false }, ...list];
}

/** The id of the "type another model" choice (never a model name: it has a space). */
export const OTHER_MODEL = "\u0000other";

/**
 * The model select's options: the inherited choice (empty value), the current model first when the catalog does not
 * list it (marked), the catalog, and "Other…" for a name the CLI does not list.
 */
export function modelChoices(catalog, value, words, inherit) {
  const list = [];
  if (inherit) list.push({ value: "", label: inherit });
  const ids = new Set((catalog || []).map((m) => m.id));
  if (value && !ids.has(value)) list.push({ value, label: `${value} — ${words.notListed}` });
  for (const m of catalog || []) list.push({ value: m.id, label: m.description ? `${m.label || m.id} — ${m.description}` : (m.label || m.id) });
  list.push({ value: OTHER_MODEL, label: words.other });
  return list;
}
