// M-3092 S-145 (docs/design/hub-rooms-ux.md §2: 「釘選、收藏的行為與 Fleet 側欄相同」): the Hub list's favourites — the
// Fleet sidebar's (#1664) rules on the Hub's conversations: star a room or a chat from its row menu, the starred ones sit in
// 「最愛」 above 「房間」 and 「Agent」 in the order they were starred (or moved in Edit), at most MAX_FAVORITES, and one that
// is gone from the list (left, removed) is dropped on the next change, never shown.
//
// Where they are kept: a per-person seam (`favoritesSource`). The Hub has no per-person preference store yet, so today's
// source is this browser's storage, one key per Hub sign-in (the Hub's own origin; `login` keeps two people on one browser
// apart); another tab follows through the storage event. A Hub-side store replaces the source, not this module's rules.
import { useEffect, useState } from "/assets/app-html.js";
import { createStore, useStore } from "/assets/app-store.js";
import { MAX_FAVORITES } from "/assets/instance-nav.js";

export { MAX_FAVORITES };
const KEY_PREFIX = "agend_hub_favorites.";

/** The ids as kept: unique strings, in order, at most MAX_FAVORITES (anything else in storage is ignored). */
export function cleanIds(value) {
  return Array.isArray(value) ? [...new Set(value.filter((x) => typeof x === "string" && x))].slice(0, MAX_FAVORITES) : [];
}

/** This browser's storage, per sign-in. A full or blocked storage keeps the change for this page only. */
export const localFavoritesSource = {
  read(login) {
    try { return cleanIds(JSON.parse(globalThis.localStorage?.getItem(KEY_PREFIX + login) || "[]")); } catch { return []; }
  },
  write(login, ids) {
    try { globalThis.localStorage?.setItem(KEY_PREFIX + login, JSON.stringify(ids)); } catch { /* this page only */ }
  },
  /** Another tab changed this sign-in's favourites: `onChange()`. Returns the unsubscribe. */
  watch(login, onChange) {
    if (typeof addEventListener !== "function") return () => {};
    const on = (e) => { if (e && e.key === KEY_PREFIX + login) onChange(); };
    addEventListener("storage", on);
    return () => removeEventListener("storage", on);
  },
};

let source = localFavoritesSource;
/** Tests (and a later Hub-side store) swap where favourites are kept. */
export function setFavoritesSource(next) { source = next || localFavoritesSource; }

/** { login, ids }: whose favourites are loaded, and their ids in order. */
export const favoritesStore = createStore({ login: null, ids: [] });
let unwatch = () => {};
/** Load `login`'s favourites (a sign-in, or a different person on this page); the same login again is a no-op. */
export function loadFavorites(login) {
  const who = typeof login === "string" && login ? login : null;
  if (favoritesStore.get().login === who) return;
  unwatch();
  unwatch = who ? source.watch(who, () => favoritesStore.set({ ids: source.read(who) })) : () => {};
  favoritesStore.set({ login: who, ids: who ? source.read(who) : [] });
}

/** The favourites that are in the list now (`known`: the ids listed) — what is shown, and the base of every change. */
export function liveFavorites(known, ids = favoritesStore.get().ids) { return ids.filter((id) => known.has(id)); }
function save(ids) {
  const { login } = favoritesStore.get();
  favoritesStore.set({ ids });
  if (login) source.write(login, ids);
}
/** Star or unstar `id`. False: not done (the list is full, or `id` isn't listed). */
export function toggleFavorite(id, known) {
  const cur = liveFavorites(known);
  if (cur.includes(id)) { save(cur.filter((x) => x !== id)); return true; }
  if (cur.length >= MAX_FAVORITES || !known.has(id)) return false;
  save([...cur, id]);
  return true;
}
/** Move a favourite one place up (-1) or down (+1). */
export function moveFavorite(id, delta, known) {
  const cur = liveFavorites(known);
  const from = cur.indexOf(id), to = from + delta;
  if (from < 0 || to < 0 || to >= cur.length) return;
  cur.splice(to, 0, cur.splice(from, 1)[0]);
  save(cur);
}

/**
 * The list's starring, for HubRoomRows: { ids, editing, setEditing, toggle(id), move(id, delta) } for `login` over the
 * `rooms` listed now (null until someone is signed in).
 */
export function useRoomStar(rooms, login) {
  const fav = useStore(favoritesStore);
  const [editing, setEditing] = useState(false);
  useEffect(() => { loadFavorites(login); }, [login]);
  if (!login || fav.login !== login) return null;
  const known = new Set((Array.isArray(rooms) ? rooms : []).map((r) => r && r.id).filter(Boolean));
  return { ids: liveFavorites(known, fav.ids), editing, setEditing,
    toggle: (id) => toggleFavorite(id, known), move: (id, delta) => moveFavorite(id, delta, known) };
}
