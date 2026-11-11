// #3679: Settings → Web dashboard → Level titles for every office — the fleet's own Office level titles (`{ titles,
// fixed }`, the shape and rules of a skin pack's `levels`: fleet-office-pack.js checkLevels), kept on the host beside
// the offices (web-offices.json; GET /ui/offices's `levels`, PUT /ui/office-level-titles — an admin session only).
// Every office uses them; a pack's own `levels` still win for the offices drawn in it (fleet-office-levels.js
// mergeLevels). Saved at once, as Office shares are — not one of the page's staged fleet.yaml changes.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { recordEdit } from "/assets/text-undo.js";
import { toast } from "/assets/ui-toast.js";
import { checkLevels } from "./fleet-office-pack.js";
import "./settings-strings.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const JSON_HEADERS = { "Content-Type": "application/json" };
const EXAMPLE = { titles: [{ from: 0, name: "Novice" }, { from: 10, name: "Adept" }, { from: 50, name: "Master" }], fixed: { atlas: { title: "Founder", hideLevel: false } } };
const pretty = (v) => (v ? JSON.stringify(v, null, 2) : "");

/** The text's problem (not JSON, or where a rule broke), or "" — empty text is none (the page's own titles). */
export function levelTitlesProblem(text) {
  if (!text.trim()) return "";
  let v;
  try { v = JSON.parse(text); } catch { return tn("levelTitlesNotJson"); }
  const r = checkLevels(v);
  return r.ok ? "" : r.error;
}

export function LevelTitlesCard({ get = globalThis.fetch }) {
  const [saved, setSaved] = useState(undefined);                     // undefined: reading; false: not offered here
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef(null);
  useEffect(() => {
    let live = true;
    get("/ui/offices", { method: "GET", headers: JSON_HEADERS }).then((r) => (r && r.ok ? r.json() : null)).then((d) => {
      if (!live) return;
      if (!d || typeof d !== "object") { setSaved(false); return; }
      const lv = d.levels !== undefined ? checkLevels(d.levels) : null, v = lv && lv.ok ? lv.levels : null;
      setSaved(v); setText(pretty(v));
    }, () => { if (live) setSaved(false); });
    return () => { live = false; };
  }, []);
  if (saved === undefined || saved === false) return null;
  const problem = levelTitlesProblem(text);
  const put = async (levels) => {
    setBusy(true); setError("");
    try {
      const r = await get("/ui/office-level-titles", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ levels }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(r.status === 403 ? tn("levelTitlesAdminOnly") : d.detail || d.error || tn("levelTitlesFailed")); return; }
      setSaved(d.levels || null); setText(pretty(d.levels || null));
      toast(tn(levels ? "levelTitlesSaved" : "levelTitlesCleared"));
    } catch { setError(tn("levelTitlesFailed")); } finally { setBusy(false); }
  };
  const save = () => { if (problem) { setError(problem); return; } void put(text.trim() ? JSON.parse(text) : null); };
  return html`<section class="card s-level-titles"><h3>${tn("levelTitlesTitle")}</h3>
    <p class="note">${tn("levelTitlesHint")}</p>
    <label class="field"><span class="sr-only">${tn("levelTitlesTitle")}</span>
      <textarea id="officeLevelTitles" ref=${area} class="s-level-titles-text" rows="8" spellcheck=${false} autocapitalize="off" autocomplete="off" value=${text} disabled=${busy}
        onInput=${(e) => { setText(e.target.value); setError(""); }}></textarea></label>
    ${error || problem ? html`<p class="err" role="alert">${error || problem}</p>` : null}
    <div class="s-widget-actions">
      <button type="button" class="btn btn-primary" disabled=${busy || !!problem || text === pretty(saved)} onClick=${save}>${tn("levelTitlesSave")}</button>
      ${!text.trim() ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => { recordEdit(area.current); setText(pretty(EXAMPLE)); }}>${tn("levelTitlesExample")}</button>` : null}
      ${saved ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => void put(null)}>${tn("levelTitlesClear")}</button>` : null}
    </div>
  </section>`;
}
