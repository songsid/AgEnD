/**
 * Hub UX U2 (spec 1.2, server item S2): find an AD group by the start of its name, then hand the chosen hit to the caller.
 * Input feedback only, never authority: the caller resolves the hit's DN with the existing resolve (the server's GUID), and
 * preview and save re-resolve as before. Shared with B2's join-code scope (Ridge). Its own words, so a page whose other
 * Hub dictionaries are cached from an older build still has every word here (upgrade skew).
 *
 *   searchGroups(client, q) → { ok: true, groups: [{ objectId, cn, dn }], truncated }
 *                           | { ok: false, reason: "invalid" | "unsupported" | "unknown" | "limited", failure?, retryAfter? }
 *   <GroupSearch client disabled exclude=[objectId…] label onPick={hit => …} onUnsupported={() => …} />
 */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
export const groupSearchV1 = true;
/** `id` is a prop (default "hubGroupSearch"; its note is `${id}Note`), so two pickers on one page never share an element id. */
export const groupSearchIdV1 = true;
register("hubGroupSearch", {
  en: {
    label: "Find a group", placeholder: "Start of the group's name, e.g. eng", hint: "Type at least 2 characters.",
    searching: "Searching…", none: "No group starts with “{0}”.", more: "More groups match. Type more of the name.",
    limited: "Too many searches. Try again in {0} seconds.", unknown: "The directory could not be searched just now. Try again, or add the group by its distinguished name.",
    invalid: "Use 2 to 64 characters.", add: "Add {0}", addShort: "Add", added: "Added",
  },
  "zh-TW": {
    label: "尋找群組", placeholder: "群組名稱的開頭，例如 eng", hint: "請至少輸入 2 個字。",
    searching: "搜尋中…", none: "沒有以「{0}」開頭的群組。", more: "還有更多群組符合。請多輸入幾個字。",
    limited: "搜尋太多次了。請 {0} 秒後再試。", unknown: "目前無法搜尋目錄。請再試一次，或用辨別名稱新增群組。",
    invalid: "請輸入 2 到 64 個字。", add: "新增 {0}", addShort: "新增", added: "已新增",
  },
});
const g = (key, ...args) => t(`hubGroupSearch.${key}`, ...args);
const CONTROL = /[\u0000-\u001f\u007f]/;
const row = (x) => x && typeof x.objectId === "string" && typeof x.cn === "string" && typeof x.dn === "string" ? { objectId: x.objectId, cn: x.cn, dn: x.dn } : null;

/** One search, normalized for the page. Never throws. */
export async function searchGroups(client, q) {
  const text = String(q ?? "").trim();
  if (CONTROL.test(String(q ?? "")) || text.length < 2 || text.length > 64) return { ok: false, reason: "invalid" };
  if (!client || typeof client.searchGroups !== "function") return { ok: false, reason: "unsupported" };
  let r;
  try { r = await client.searchGroups(text); } catch { return { ok: false, reason: "unknown" }; }
  if (r && r.ok === true && Array.isArray(r.groups)) return { ok: true, groups: r.groups.map(row).filter(Boolean).slice(0, 20), truncated: r.truncated === true };
  if (r && r.status === 429) return { ok: false, reason: "limited", retryAfter: Number(r.retryAfter) > 0 ? Number(r.retryAfter) : 60 };
  if (r && r.status === 400) return { ok: false, reason: "invalid" };
  if (r && (r.reason === "unsupported" || r.reason === "unknown" || r.reason === "limited"))
    return { ok: false, reason: r.reason, ...(r.reason === "unknown" && r.failure ? { failure: String(r.failure) } : {}), ...(r.reason === "limited" ? { retryAfter: 60 } : {}) };
  return { ok: false, reason: "unknown" };
}

/** The search box: 300 ms after typing stops, the newest answer for the text in the box only. */
export function GroupSearch({ client, disabled = false, exclude = [], label, onPick, onUnsupported, id = "hubGroupSearch" } = {}) {
  const noteId = `${id}Note`;
  const [q, setQ] = useState(""), [answer, setAnswer] = useState(null), [busy, setBusy] = useState(false);
  const seq = useRef(0), told = useRef(false), live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    const text = q.trim(); const mine = ++seq.current;
    if (text.length < 2) { setAnswer(null); setBusy(false); return; }
    setBusy(true);
    const timer = setTimeout(async () => {
      const r = await searchGroups(client, q);
      if (!live.current || mine !== seq.current) return;
      setBusy(false); setAnswer({ ...r, q: text });
      if (!r.ok && r.reason === "unsupported" && !told.current) { told.current = true; onUnsupported?.(); }
    }, 300);
    return () => clearTimeout(timer);
  }, [q, client]);
  if (answer && !answer.ok && answer.reason === "unsupported") return null;   // the caller's DN input takes over
  const hits = answer?.ok ? answer.groups : [];
  const message = busy ? g("searching")
    : !answer ? (q.trim() && q.trim().length < 2 ? g("hint") : null)
    : answer.ok ? (hits.length ? (answer.truncated ? g("more") : null) : g("none", answer.q))
    : answer.reason === "limited" ? g("limited", answer.retryAfter ?? 60) : answer.reason === "invalid" ? g("invalid") : g("unknown");
  return html`<div class="hub-group-search">
    <label class="field" for=${id}><span>${label || g("label")}</span>
      <input id=${id} type="search" value=${q} disabled=${disabled} autocomplete="off" spellcheck=${false} placeholder=${g("placeholder")}
        aria-describedby=${noteId} onInput=${(e) => setQ(e.target.value)} /></label>
    ${message ? html`<p class="note" id=${noteId} role="status">${message}</p>` : null}
    ${hits.length ? html`<ul class="hub-group-hits" role="list">${hits.map((h) => { const has = exclude.includes(h.objectId);
      return html`<li class="s-row" key=${h.objectId}><span class="hub-row-text"><strong>${h.cn}</strong><small class="note"><code>${h.dn}</code></small></span>
        <button type="button" class="btn btn-sm" disabled=${disabled || has} aria-label=${g("add", h.cn)} onClick=${() => onPick?.(h)}>${has ? g("added") : g("addShort")}</button></li>`; })}</ul>` : null}
  </div>`;
}
