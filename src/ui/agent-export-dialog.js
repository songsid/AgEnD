// AGEND-163: "Export" and "Load template" beside an agent's Agent instructions (its systemPrompt). The file (<role>.agend-agent.yaml, agend_export: 1)
// is built and read by the server (agent-export.ts: the project's own `yaml` package and one allow-list for both directions);
// this file is only the two dialogs. Loading changes nothing by itself — it fills the same form the person edits by hand, so
// the Save bar and its confirmations (tool sets, access…) apply exactly as they always did.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import "./agent-export-strings.js";
import { xt } from "./agent-export-strings.js";

const GROUPS = ["identity", "systemPrompt", "runtime", "behavior"];
const DEFAULT_GROUPS = ["identity", "systemPrompt", "runtime", "behavior"];
/** The largest file the loader reads (agent-export.ts AGENT_EXPORT_MAX_CHARS). */
const MAX_FILE_CHARS = 200000;
/** The server reads a request body of at most 512 KiB (web-api.ts parseBody): a bigger file is refused here, with the same words. */
const MAX_FILE_BYTES = 480 * 1024;

async function post(path, body) {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** The form's fields a file's values land in (names as agent-export.ts's FillValues; `inherit` = the key of "use the default"). */
const FILL = {
  description: { to: "description" }, tags: { to: "tags" }, systemPrompt: { to: "systemPrompt" }, model: { to: "model" },
  model_failover: { to: "model_failover", inherit: "model_failover" }, tool_set: { to: "tool_set", inherit: "tool_set" }, lightweight: { to: "lightweight", inherit: "lightweight" },
  hang_detector: { to: "hang", inherit: "hang", text: true }, tool_progress: { to: "tool_progress", inherit: "tool_progress" }, reply_completion_guard: { to: "reply_completion_guard", inherit: "reply_completion_guard" },
  log_level: { to: "log_level", inherit: "log_level" }, auto_pause_after: { to: "auto_pause_after", inherit: "auto_pause_after", text: true }, agent_mode: { to: "agent_mode", inherit: "agent_mode" },
  cross_instance_visibility: { to: "cross_instance_visibility", inherit: "cross_instance_visibility" }, board_cards_at_once: { to: "board_cards_at_once", text: true }, resume_interrupted_work: { to: "resume_interrupted_work" },
};
export const FILL_KEYS = Object.keys(FILL);

/** Put the values of a checked file into the agent form (useAgentForm's setF). A setting a file names stops following the default. */
export function applyFill(setF, fill) {
  setF((form) => {
    const next = { ...form, inherit: { ...form.inherit } };
    for (const [key, value] of Object.entries(fill)) {
      const spec = Object.prototype.hasOwnProperty.call(FILL, key) ? FILL[key] : null;
      if (!spec) continue;
      next[spec.to] = spec.text ? String(value) : Array.isArray(value) ? [...value] : value;
      if (spec.inherit) next.inherit[spec.inherit] = false;
    }
    return next;
  });
}

const shortValue = (v) => {
  const s = Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "on" : "off") : String(v);
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
};

/** Export: what to include (left), the file as it would be written (below), secrets stopping the download. */
export function ExportDialog({ name, pending, onClose }) {
  const [groups, setGroups] = useState(() => new Set(DEFAULT_GROUPS));
  const [result, setResult] = useState(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    const mine = ++seq.current;
    setFailed(false);
    setResult(null);          // the old preview is gone the moment the choice changes: nothing stale can be copied
    post("/ui/agent-export/build", { instance: name, include: GROUPS.filter((g) => groups.has(g)) })
      .then((r) => { if (alive.current && mine === seq.current) setResult(r); })
      .catch(() => { if (alive.current && mine === seq.current) { setResult(null); setFailed(true); } });
  }, [[...groups].sort().join(",")]);
  const toggle = (g) => setGroups((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const text = result && typeof result.text === "string" ? result.text : null;
  const findings = (result && result.findings) || [];
  const fields = [...new Set(findings.map((f) => f.field))];
  const usable = !!text && !result.empty;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast(xt("copied")); } catch { toast(xt("copyFailed"), false); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/yaml;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${name}.agend-agent.yaml`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return html`<${Dialog} title=${xt("exportTitle")} onClose=${onClose} wide=${true}
    actions=${html`<button type="button" class="btn" onClick=${copy} disabled=${!usable} data-export-copy><${Icon} name="copy" size=${15} /> ${xt("copy")}</button>
      <button type="button" class="btn btn-primary" onClick=${download} disabled=${!usable} data-export-download><${Icon} name="download" size=${15} /> ${xt("download")}</button>`}>
    <div class="form">
      <p class="note">${xt("exportLead")}</p>
      ${pending ? html`<p class="feedback warning" role="status">${xt("pending")}</p>` : null}
      <fieldset class="field"><legend>${xt("pick")}</legend>
        ${GROUPS.map((g) => html`<label class="check" key=${g}><input type="checkbox" checked=${groups.has(g)} data-export-group=${g} onChange=${() => toggle(g)} /><span>${xt(`g_${g}`)}</span></label>`)}</fieldset>
      ${findings.length ? html`<div class="feedback error" role="alert" data-export-secret><strong>${xt("secretTitle")}</strong>
        <p>${xt("secretBody", fields.join(", "))}</p>
        <ul>${findings.map((f, i) => html`<li key=${i}>${xt("secretAt", f.field, f.line)} — ${xt(`kind_${f.kind}`)}</li>`)}</ul></div>` : null}
      ${failed ? html`<p class="feedback error" role="alert">${xt("exportFailed")}</p>` : null}
      ${(result && result.omitted || []).map((o) => html`<p class="feedback warning" role="status" key=${o.field + o.reason} data-export-omitted=${o.reason}>${xt(`o_${o.reason}`)}</p>`)}
      ${result && result.empty && !findings.length ? html`<p class="note">${xt("nothing")}</p>` : null}
      <div class="field"><label for="ag-export-preview">${xt("previewLabel")}</label>
        <textarea id="ag-export-preview" rows="14" readonly spellcheck=${false} value=${text === null ? (result ? "" : xt("building")) : text} data-export-preview /></div>
      <details class="field"><summary>${xt("notExported")}</summary><p class="note">${xt("notExportedBody")}</p></details>
    </div></${Dialog}>`;
}

/** Load template: choose or paste, see what would be filled and what skipped (with why), then fill the form. */
export function LoadDialog({ current, onFill, onClose }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);       // the server's reading of `text`, or { error }
  const [note, setNote] = useState("");
  const alive = useRef(true);
  const seq = useRef(0);
  useEffect(() => () => { alive.current = false; }, []);
  const edit = (value) => { seq.current++; setText(value); setRes(null); setNote(""); setBusy(false); };
  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setRes({ error: "too_large" }); setNote(xt("fileTooLarge")); return; }
    try { edit(await file.text()); } catch { setRes({ error: "read" }); setNote(xt("readFailed")); }
  };
  const check = async () => {
    const mine = ++seq.current;
    setBusy(true);
    try {
      const r = await post("/ui/agent-export/parse", { text });
      if (alive.current && mine === seq.current) setRes(r.ok ? r : { error: r.error });
    } catch { if (alive.current && mine === seq.current) setRes({ error: "failed" }); }
    finally { if (alive.current && mine === seq.current) setBusy(false); }
  };
  const ok = res && res.ok;
  const fillKeys = ok ? FILL_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(res.fill, k)) : [];
  const replaces = (k) => (k === "description" || k === "systemPrompt") && current && String(current[k] || "").trim() !== "" && current[k] !== res.fill[k];
  const doFill = () => { onFill(res.fill); toast(xt("filled", fillKeys.length)); onClose(); };
  return html`<${Dialog} title=${xt("loadTitle")} onClose=${onClose} wide=${true} busy=${busy}
    actions=${html`<button type="button" class="btn" onClick=${check} disabled=${busy || !text.trim()} data-load-check>${busy ? xt("checking") : xt("check")}</button>
      <button type="button" class="btn btn-primary" onClick=${doFill} disabled=${!ok || !fillKeys.length} data-load-fill>${xt("fill")}</button>`}>
    <div class="form">
      <p class="note">${xt("loadLead")}</p>
      <div class="field"><label class="btn btn-sm"><${Icon} name="file" size=${15} /> ${xt("chooseFile")}<input type="file" accept=".yaml,.yml,.txt,text/yaml,text/plain" hidden data-load-file onChange=${onFile} /></label></div>
      <div class="field"><label for="ag-load-text">${xt("pasteLabel")}</label>
        <textarea id="ag-load-text" rows="10" spellcheck=${false} placeholder=${xt("pastePlaceholder")} value=${text} data-load-text onInput=${(e) => edit(e.target.value)} /></div>
      ${note ? html`<p class="feedback error" role="alert">${note}</p>` : null}
      ${res && res.error && !note ? html`<p class="feedback error" role="alert" data-load-error>${xt(`e_${res.error}`)}</p>` : null}
      ${ok ? html`<div data-load-preview>
        <p><strong>${xt("willFill", fillKeys.length)}</strong></p>
        ${fillKeys.length ? html`<ul>${fillKeys.map((k) => html`<li key=${k} data-fill=${k}><strong>${xt(`f_${k}`)}</strong>: ${k === "systemPrompt" ? xt("nChars", String(res.fill[k]).length.toLocaleString("en-US")) : shortValue(res.fill[k])}${replaces(k) ? ` — ${xt("replaces")}` : ""}</li>`)}</ul>` : html`<p class="note">${xt("fillNone")}</p>`}
        <p><strong>${xt("willSkip", res.skipped.length)}</strong></p>
        ${res.skipped.length ? html`<ul>${res.skipped.map((s, i) => html`<li key=${i} data-skip=${s.path}><code>${s.path}</code> — ${xt(`r_${s.reason}`)}</li>`)}</ul>` : html`<p class="note">${xt("skipNone")}</p>`}
        ${res.role ? html`<p class="note">${xt("roleHint", res.role)}</p>` : null}
        ${res.libraryUsed ? html`<p class="note" data-load-library>${xt("libraryNote")}</p>` : null}
        ${res.extraFailover ? html`<p class="note">${xt("failoverNote")}</p>` : null}
        ${Object.prototype.hasOwnProperty.call(res.fill, "model") ? html`<p class="note">${xt("modelNote")}</p>` : null}
      </div>` : null}
    </div></${Dialog}>`;
}

/** The two buttons under the Instructions field, and the dialogs they open. `m`: useAgentForm's result. */
export function AgentTemplateTools({ name, m }) {
  const [open, setOpen] = useState(null);
  const pending = Object.keys(m.pending()).length > 0;
  return html`<div class="field template-tools"><p class="note">${xt("fieldsHint")}</p>
    <div class="seg-inline" role="group" aria-label=${xt("loadTemplate")}>
      <button type="button" class="btn btn-sm" data-template-load onClick=${() => setOpen("load")}><${Icon} name="file" size=${15} /> ${xt("loadTemplate")}</button>
      <button type="button" class="btn btn-sm" data-template-export onClick=${() => setOpen("export")}><${Icon} name="download" size=${15} /> ${xt("exportBtn")}</button></div>
    ${open === "export" ? html`<${ExportDialog} name=${name} pending=${pending} onClose=${() => setOpen(null)} />` : null}
    ${open === "load" ? html`<${LoadDialog} current=${m.f} onFill=${(fill) => applyFill(m.setF, fill)} onClose=${() => setOpen(null)} />` : null}</div>`;
}
