// Built-in colours use the existing root tokens and mode controller; this dialog only edits that browser choice.
import { html, useEffect, useRef, useState } from "./app-html.js";
import { Dialog } from "./ui-dialog.js";
import { t } from "./app-i18n.js";
import { savePref, withoutHold } from "./app-prefs.js";

export const BUILTIN_PALETTES = Object.freeze(["", "sky", "meadow", "violet", "mint"]);
export const paletteName = (id) => t(`app.palette${id ? id[0].toUpperCase() + id.slice(1) : "Default"}`);

export function ThemePicker({ onClose }) {
  const T = globalThis.AgendTheme;
  const [mode, setMode] = useState(T?.get?.() || "system"), [palette, setPalette] = useState(T?.getPalette?.() || "");
  const draft = useRef({ mode, palette });
  const [systemLight, setSystemLight] = useState(() => globalThis.matchMedia?.("(prefers-color-scheme: light)").matches === true);
  const lease = useRef(null);
  const closing = useRef(false);
  if (!lease.current) lease.current = T?.beginPreview?.();
  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: light)");
    const changed = () => setSystemLight(media.matches);
    const unsubscribe = T?.onChange?.(() => {
      if (!closing.current && lease.current?.isCurrent?.() === false) { closing.current = true; onClose(); }
    });
    media?.addEventListener?.("change", changed);
    return () => { unsubscribe?.(); media?.removeEventListener?.("change", changed); lease.current?.cancel(); };
  }, []);
  const update = (nextMode, nextPalette) => { draft.current = { mode: nextMode, palette: nextPalette }; setMode(nextMode); setPalette(nextPalette); lease.current?.update(nextMode, nextPalette); };
  const cancel = () => { closing.current = true; lease.current?.cancel(); onClose(); };
  const apply = () => { closing.current = true; if (lease.current?.commit()) withoutHold(() => savePref("theme", draft.current.mode)); onClose(); };
  const tone = mode === "system" ? systemLight ? "light" : "dark" : mode;
  return html`<${Dialog} title=${t("app.colours")} cls="theme-picker" onClose=${cancel} actions=${html`
    <button type="button" class="btn theme-cancel" onClick=${cancel}>${t("app.cancel")}</button>
    <button type="button" class="btn btn-primary theme-apply" onClick=${apply}>${t("app.apply")}</button>`}>
    <div class="theme-colours" role="radiogroup" aria-label=${t("app.colours")}>
      ${BUILTIN_PALETTES.map(id => html`<label key=${id} class=${`theme-colour${palette === id ? " selected" : ""}`}>
        <input type="radio" name="builtin-palette" value=${id} checked=${palette === id} onChange=${(e) => { if (e.currentTarget.checked) update(draft.current.mode, id); }} />
        <span class="theme-swatch" data-palette=${id} data-tone=${tone} aria-hidden="true"><span class="theme-swatch-side"><i></i><i></i></span><span class="theme-swatch-chat"><i></i><i></i></span></span>
        <span class="theme-colour-name">${paletteName(id)}<span class="theme-tick" aria-hidden="true">${palette === id ? "✓" : ""}</span></span>
      </label>`)}
    </div>
    <fieldset class="theme-appearance"><legend>${t("app.theme")}</legend><div class="theme-mode-options">
      ${["system", "light", "dark"].map(value => html`<label class="check"><input type="radio" name="builtin-appearance" value=${value} checked=${mode === value}
        onChange=${(e) => { if (e.currentTarget.checked) update(value, draft.current.palette); }} /><span>${t(`app.theme${value[0].toUpperCase() + value.slice(1)}`)}</span></label>`)}
    </div></fieldset>
  </${Dialog}>`;
}
