// #3153 P1: an agent's Files / Changes in the side panel (read-only) — the folder it works in, as the server's
// /ui/workspace answers it (src/agent-workspace.ts: confined to that folder, secrets hidden by name, size limits).
// - Changes (the default): git status and the uncommitted diff against HEAD, untracked files included, per file.
// - Files: the folder's tree, one directory at a time (gitignored entries left out), and a read-only viewer — text
//   with line numbers, an image inline, otherwise why not (binary, too large, hidden, a link).
// Refreshed on demand, and when the agent replies (the end of its turn). Nothing here writes to the folder, and
// everything is drawn as text nodes: no HTML from the folder is ever parsed.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";

/** This panel's stylesheet, linked once (a tab opened before an upgrade has an app.css without these rules). */
function linkWorkspaceCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-ws-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/workspace.css"); link.setAttribute("data-ws-css", "1");
    doc.head.appendChild(link);
  } catch { /* the panel still works without it */ }
}
const api = (instance, op, path) => `/ui/workspace?instance=${encodeURIComponent(instance)}&op=${op}${path !== undefined ? `&path=${encodeURIComponent(path)}` : ""}`;
async function read(instance, op, path) {
  let r;
  try { r = await fetch(api(instance, op, path), { credentials: "same-origin", cache: "no-store" }); }
  catch { return { ok: false, error: "network" }; }
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok) return { ok: false, status: r.status, error: (body && typeof body.error === "string" && body.error) || "failed" };
  return { ok: true, body };
}
const ERRORS = { workspace_not_offered: "chat.wsNotOffered", not_found: "chat.wsNotFound", not_a_directory: "chat.wsNotFound", hidden: "chat.wsHidden",
  symlink: "chat.wsSymlink", outside: "chat.wsOutside", not_a_file: "chat.wsNotAFile", network: "chat.wsFailed", failed: "chat.wsFailed" };
const errText = (e) => t(ERRORS[e] || "chat.wsFailed");
const size = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** The patch split into one section per file: { path, lines: [{ t: "+" | "-" | " " | "@" | "h", text }] }. */
export function sectionsOf(patch) {
  const out = new Map();
  for (const sec of String(patch || "").split(/(?=^diff --git )/m)) {
    const m = /^diff --git a\/(.*?) b\//.exec(sec);
    if (!m) continue;
    const lines = [];
    for (const l of sec.split("\n")) {
      if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index)/.test(l)) continue;
      if (l.startsWith("@@")) lines.push({ t: "@", text: l });
      else if (l.startsWith("+")) lines.push({ t: "+", text: l.slice(1) });
      else if (l.startsWith("-")) lines.push({ t: "-", text: l.slice(1) });
      else if (l.startsWith(" ")) lines.push({ t: " ", text: l.slice(1) });
      else if (l.startsWith("\\")) lines.push({ t: "h", text: l });
    }
    out.set(m[1], lines);
  }
  return out;
}

export function WorkspacePanel({ open, name, panel, fs, enterFs, leaveFs, onKey, subscribe, close }) {
  const [tab, setTab] = useState("changes");
  const [changes, setChanges] = useState(null);       // { state: "loading" | "ready" | "failed", body?, error? }
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState(null);
  const [file, setFile] = useState(null);             // { path, state, body?, error? }
  const [openFiles, setOpenFiles] = useState(() => new Set());
  const gen = useRef(0);
  const instance = open.instance;
  const loadChanges = async () => {
    const mine = ++gen.current;
    setChanges((c) => (c && c.state === "ready" ? { ...c, refreshing: true } : { state: "loading" }));
    const r = await read(instance, "changes");
    if (mine !== gen.current) return;
    setChanges(r.ok ? { state: "ready", body: r.body } : { state: "failed", error: r.error });
  };
  const loadDir = async (path) => {
    const mine = ++gen.current;
    setListing({ state: "loading", path }); setFile(null);
    const r = await read(instance, "list", path);
    if (mine !== gen.current) return;
    setDir(path);
    setListing(r.ok ? { state: "ready", body: r.body, path } : { state: "failed", error: r.error, path });
  };
  const loadFile = async (path) => {
    const mine = ++gen.current;
    setFile({ path, state: "loading" });
    const r = await read(instance, "file", path);
    if (mine !== gen.current) return;
    setFile(r.ok ? { path, state: "ready", body: r.body } : { path, state: "failed", error: r.error });
  };
  const refresh = () => { if (tab === "changes") loadChanges(); else if (file) loadFile(file.path); else loadDir(dir); };
  useEffect(() => { linkWorkspaceCss(); }, []);
  useEffect(() => { loadChanges(); }, [instance]);
  useEffect(() => { if (tab === "files" && !listing) loadDir(""); }, [tab]);
  // The end of the agent's turn: its reply arrives — read Changes again (once, shortly after), never while hidden.
  useEffect(() => {
    if (typeof subscribe !== "function") return undefined;
    let timer = 0;
    const off = subscribe((inst, kind) => {
      if (inst !== instance || kind !== "msgs") return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!(typeof document !== "undefined" && document.hidden) && tab === "changes") loadChanges(); }, 1500);
    });
    return () => { clearTimeout(timer); if (typeof off === "function") off(); };
  }, [instance, tab]);

  const crumbs = dir ? dir.split("/") : [];
  return html`<aside data-trust="preview" class=${`pv-panel ws-panel${fs ? ` pv-fs pv-fs-${fs}` : ""}`} ref=${panel} aria-label=${t("chat.wsTitle")} onKeyDown=${onKey}>
    <div class="pv-panel-head">
      <button type="button" class="icon-btn only-narrow pv-panel-close" title=${t("chat.pvBack")} aria-label=${t("chat.pvBack")} onClick=${close}><${Icon} name="back" size=${18} /></button>
      <div class="pv-panel-title"><strong>${t("chat.wsTitle")}</strong><span class="pv-source ws-agent">${name}</span></div>
      <button type="button" class="icon-btn only-wide pv-panel-close" title=${t("chat.pvClose")} aria-label=${t("chat.pvClose")} onClick=${close}><${Icon} name="close" size=${18} /></button>
    </div>
    <div class="pv-panel-bar">
      <div class="seg-inline" role="tablist" aria-label=${t("chat.wsTitle")}>
        <button type="button" role="tab" class=${`btn btn-sm${tab === "changes" ? " on" : ""}`} aria-selected=${tab === "changes" ? "true" : "false"} onClick=${() => setTab("changes")}><${Icon} name="diff" size=${14} /><span class="lbl">${t("chat.wsChanges")}</span></button>
        <button type="button" role="tab" class=${`btn btn-sm${tab === "files" ? " on" : ""}`} aria-selected=${tab === "files" ? "true" : "false"} onClick=${() => setTab("files")}><${Icon} name="file" size=${14} /><span class="lbl">${t("chat.wsFiles")}</span></button>
      </div>
      <span class="grow"></span>
      <button type="button" class="btn btn-sm ws-refresh" title=${t("chat.wsRefresh")} onClick=${refresh}><${Icon} name="restart" size=${14} /><span class="lbl">${t("chat.wsRefresh")}</span></button>
      <button type="button" class=${`btn btn-sm only-wide pv-panel-fs${fs ? " on" : ""}`} aria-pressed=${fs ? "true" : "false"} title=${t(fs ? "chat.pvFsExit" : "chat.pvFs")} aria-label=${t(fs ? "chat.pvFsExit" : "chat.pvFs")}
        onClick=${() => (fs ? leaveFs() : enterFs())}><${Icon} name=${fs ? "fullscreenexit" : "fullscreen"} size=${14} /></button>
    </div>
    <div class="pv-note ws-readonly" role="note">${t("chat.wsReadOnly")}</div>
    <div class="pv-panel-body show-code ws-body">
      ${tab === "changes" ? html`<${Changes} state=${changes} openFiles=${openFiles} toggle=${(p) => setOpenFiles((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; })} />`
        : html`<div class="ws-files">
          <nav class="ws-crumbs" aria-label=${t("chat.wsFiles")}>
            <button type="button" class="btn btn-sm btn-ghost" onClick=${() => loadDir("")}>${name}</button>
            ${crumbs.map((c, i) => html`<span aria-hidden="true">/</span><button type="button" class="btn btn-sm btn-ghost" onClick=${() => loadDir(crumbs.slice(0, i + 1).join("/"))}>${c}</button>`)}
          </nav>
          ${file ? html`<${Viewer} file=${file} instance=${instance} back=${() => setFile(null)} />` : html`<${Listing} listing=${listing} dir=${dir} openDir=${loadDir} openFile=${loadFile} />`}
        </div>`}
    </div>
  </aside>`;
}

function Changes({ state, openFiles, toggle }) {
  if (!state || state.state === "loading") return html`<div class="pv-note">${t("chat.pvLoading")}</div>`;
  if (state.state === "failed") return html`<div class="pv-note" role="alert">${errText(state.error)}</div>`;
  const c = state.body;
  if (!c.repo) return html`<div class="pv-note">${t("chat.wsNoRepo")}</div>`;
  if (!c.files.length) return html`<div class="pv-note">${t("chat.wsClean", c.branch || "HEAD")}</div>`;
  const secs = sectionsOf(c.patch);
  return html`<div class="ws-changes">
    <div class="ws-summary">${t("chat.wsSummary", c.files.length, c.branch || "HEAD")}${c.hiddenCount ? ` · ${t("chat.wsHiddenCount", c.hiddenCount)}` : ""}</div>
    ${c.cut && (c.cut.files || c.cut.bytes) ? html`<div class="pv-note" role="status">${t("chat.wsCut")}</div>` : null}
    <ul class="ws-change-list">${c.files.map((f) => {
      const lines = secs.get(f.path), why = f.hidden ? t("chat.wsHiddenFile") : f.binary ? t("chat.wsBinary") : f.tooLarge ? t("chat.wsTooLarge") : null;
      const shown = openFiles.has(f.path);
      return html`<li key=${f.path} class=${`ws-change st-${f.status}`}>
        <button type="button" class="ws-change-head" aria-expanded=${lines ? (shown ? "true" : "false") : undefined} disabled=${!lines} onClick=${() => toggle(f.path)}>
          <span class=${`ws-st st-${f.status}`}>${t(`chat.wsSt_${f.status}`)}</span>
          <span class="ws-path">${f.path}</span>
          ${f.adds != null || f.dels != null ? html`<span class="ws-count"><span class="d-add">+${f.adds ?? 0}</span> <span class="d-del">−${f.dels ?? 0}</span></span>` : null}
          ${why ? html`<span class="ws-why">${why}</span>` : null}
        </button>
        ${lines && shown ? html`<pre class="pv-code pv-diff ws-diff"><code>${lines.map((l) => html`<span class=${l.t === "+" ? "d-add" : l.t === "-" ? "d-del" : l.t === "@" ? "d-hunk" : "d-ctx"}>${l.t === "@" || l.t === "h" ? `${l.text}\n` : `${l.t} ${l.text}\n`}</span>`)}</code></pre>` : null}
      </li>`;
    })}</ul>
  </div>`;
}

function Listing({ listing, openDir, openFile }) {
  if (!listing || listing.state === "loading") return html`<div class="pv-note">${t("chat.pvLoading")}</div>`;
  if (listing.state === "failed") return html`<div class="pv-note" role="alert">${errText(listing.error)}</div>`;
  const l = listing.body;
  return html`<div>
    ${l.cut ? html`<div class="pv-note" role="status">${t("chat.wsDirCut")}</div>` : null}
    ${!l.entries.length ? html`<div class="pv-note">${t("chat.wsEmptyDir")}</div>` : null}
    <ul class="ws-entries">${l.entries.map((e) => {
      const rel = l.path ? `${l.path}/${e.name}` : e.name;
      const usable = !e.hidden && (e.type === "dir" || e.type === "file");
      return html`<li key=${e.name} class=${`ws-entry t-${e.type}${e.hidden ? " is-hidden" : ""}`}>
        <button type="button" class="ws-entry-btn" disabled=${!usable} onClick=${() => (e.type === "dir" ? openDir(rel) : openFile(rel))}>
          <${Icon} name=${e.type === "dir" ? "inbox" : e.type === "symlink" ? "external" : "file"} size=${14} />
          <span class="ws-name">${e.name}${e.type === "dir" ? "/" : ""}</span>
          <span class="ws-meta">${e.hidden ? t("chat.wsHiddenFile") : e.type === "symlink" ? t("chat.wsLink") : e.type === "file" ? size(e.size) : ""}</span>
        </button></li>`;
    })}</ul></div>`;
}

function Viewer({ file, instance, back }) {
  const head = html`<div class="ws-viewer-head"><button type="button" class="btn btn-sm" onClick=${back}><${Icon} name="back" size=${14} />${t("chat.pvBack")}</button><code class="ws-path">${file.path}</code></div>`;
  if (file.state === "loading") return html`<div>${head}<div class="pv-note">${t("chat.pvLoading")}</div></div>`;
  if (file.state === "failed") return html`<div>${head}<div class="pv-note" role="alert">${errText(file.error)}</div></div>`;
  const f = file.body;
  if (f.kind === "image") return html`<div>${head}<img class="ws-image" alt=${f.path} src=${api(instance, "image", f.path)} /></div>`;
  if (f.kind !== "text") return html`<div>${head}<div class="pv-note">${t(f.kind === "binary" ? "chat.wsBinaryFile" : "chat.wsTooLargeFile", size(f.size))}</div></div>`;
  const lines = f.text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return html`<div>${head}<pre class="pv-code ws-text"><code>${lines.map((l, i) => html`<span class="ws-ln" aria-hidden="true">${String(i + 1).padStart(String(lines.length).length, " ")}</span>${`${l}\n`}`)}</code></pre></div>`;
}
