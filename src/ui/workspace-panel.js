// #3153 P1: an agent's Files / Changes in the side panel (read-only) — the folder it works in, as the server's
// /ui/workspace answers it (src/agent-workspace.ts: confined to that folder, secrets hidden by name, size limits).
// - Changes (the default): git status and the uncommitted diff against HEAD, untracked files included, per file.
// - Files: the folder's tree, one directory at a time (gitignored entries left out), and a read-only viewer — text
//   with line numbers, an image inline, otherwise why not (binary, too large, hidden, a link).
// Refreshed on demand, and when the agent replies (the end of its turn). Nothing here writes to the folder, and
// everything is drawn as text nodes: no HTML from the folder is ever parsed.
// #3160 (P2): **Follow agent** (off by default) shows the file the agent is reading, editing or searching, from the
// CLI's own record (src/workspace-follow.ts), with the lines it read or changed highlighted and this turn's steps in a
// strip. It is polled only while this panel is open, Follow is on and the page is visible; what you do yourself
// (another tab, file or folder, scrolling the file) pauses it until you resume.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import "./workspace-strings.js";          // this panel's own words (an older cached chat-strings.js lacks them)
import "./workspace-follow-strings.js";   // #3160's words, a module of their own (an older workspace-strings.js lacks them)

/** This panel's stylesheets, linked once (a tab opened before an upgrade has an app.css without these rules). */
function linkCss(href, mark, doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector(`link[data-ws-css="${mark}"]`)) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", href); link.setAttribute("data-ws-css", mark);
    doc.head.appendChild(link);
  } catch { /* the panel still works without it */ }
}
const linkWorkspaceCss = (doc) => { linkCss("/assets/workspace.css", "1", doc); linkCss("/assets/workspace-follow.css", "follow", doc); };
const api = (instance, op, path, extra = "") => `/ui/workspace?instance=${encodeURIComponent(instance)}&op=${op}${path !== undefined ? `&path=${encodeURIComponent(path)}` : ""}${extra}`;
async function read(instance, op, path, extra) {
  let r;
  try { r = await fetch(api(instance, op, path, extra), { credentials: "same-origin", cache: "no-store" }); }
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
/** #3160: the new file's line numbers an edit added or changed (from one file's patch); a pure removal marks where it was. */
export function changedLines(patch) {
  const lines = new Set();
  let at = 0, inHunk = false;
  for (const l of String(patch || "").split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { at = Number(h[1]); inHunk = true; continue; }
    if (!inHunk || l.startsWith("\\")) continue;
    if (l.startsWith("+")) { lines.add(at); at++; }
    else if (l.startsWith("-")) lines.add(Math.max(1, at));
    else if (l.startsWith(" ")) at++;
    else if (l.startsWith("diff --git")) inHunk = false;
  }
  return lines;
}
const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p) => (p ? p.slice(p.lastIndexOf("/") + 1) : ".");
/** #3160: how often an open panel with Follow on asks, and how often it may move. */
export const FOLLOW_TIMING = { pollMs: 1000, applyMs: 600, changesMs: 2500, historyMax: 40 };
// The strip keeps call order; concurrent completions can update an earlier call with the newest sequence.
const newestStep = (steps) => steps.reduce((latest, step) => !latest || step.seq > latest.seq ? step : latest, null);

export function WorkspacePanel({ open, name, panel, fs, enterFs, leaveFs, onKey, subscribe, close }) {
  const [tab, setTab] = useState("changes");
  const [changes, setChanges] = useState(null);       // { state: "loading" | "ready" | "failed", body?, error? }
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState(null);
  const [file, setFile] = useState(null);             // { path, state, body?, error?, hl? }
  const [openFiles, setOpenFiles] = useState(() => new Set());
  // #3160: "off" | "on" | "paused"; this turn's steps; the step shown; the tree entry highlighted; what the server says.
  const [follow, setFollow] = useState("off");
  const [history, setHistory] = useState([]);
  const [current, setCurrent] = useState(null);
  const [hlEntry, setHlEntry] = useState(null);
  const [followInfo, setFollowInfo] = useState(null);  // { supported, running }
  const gen = useRef(0);
  const changesGen = useRef(0), dirGen = useRef(0), alive = useRef(true);
  const actions = useRef(null), autoScroll = useRef(null);
  const followRef = useRef("off");
  const pos = useRef({ scope: null, turn: null, last: 0 });
  const pending = useRef(null);
  const lastApply = useRef(0);
  const changesTimer = useRef(0);
  const instance = open.instance;
  followRef.current = follow;
  const visible = () => !(typeof document !== "undefined" && document.hidden);
  const valid = (mine, automatic) => alive.current && mine === gen.current && (!automatic || followRef.current === "on" && visible());
  const loadChanges = async () => {
    const mine = ++changesGen.current;
    setChanges((c) => (c && c.state === "ready" ? { ...c, refreshing: true } : { state: "loading" }));
    const r = await read(instance, "changes");
    if (!alive.current || mine !== changesGen.current) return;
    setChanges(r.ok ? { state: "ready", body: r.body } : { state: "failed", error: r.error });
  };
  const loadDir = async (path, automatic = false) => {
    const mine = ++gen.current;
    if (!automatic) { setListing({ state: "loading", path }); setFile(null); }
    const r = await read(instance, "list", path);
    if (!valid(mine, automatic)) return;
    if (automatic) setTab("files");
    setFile(null);
    setDir(path);
    setListing(r.ok ? { state: "ready", body: r.body, path } : { state: "failed", error: r.error, path });
  };
  /** `step` (#3160): the agent's step that opened it: a read's range, or an edit's changed lines (from that file's diff). */
  const loadFile = async (path, step, automatic = false) => {
    const mine = ++gen.current;
    if (!automatic) setFile({ path, state: "loading" });
    if (step) loadDirQuiet(parentOf(path), mine, automatic);
    const [r, d] = await Promise.all([read(instance, "file", path), step && step.kind === "edit" && !step.editLines ? read(instance, "diff", path) : null]);
    if (!valid(mine, automatic)) return;
    if (automatic) setTab("files");
    const hl = !step ? null : step.kind === "edit" ? { kind: "edit", exact: !!step.editLines, lines: step.editLines ? new Set(step.editLines) : d && d.ok ? changedLines(d.body.patch) : new Set() }
      : step.range ? { kind: "read", from: step.range.from, to: step.range.to } : null;
    setFile(r.ok ? { path, state: "ready", body: r.body, hl } : { path, state: "failed", error: r.error });
  };
  const refresh = () => { pause(); if (tab === "changes") loadChanges(); else if (file) loadFile(file.path); else loadDir(dir); };
  // Anything you do yourself pauses Follow (until you resume): it never pulls the view from under you.
  const pause = () => {
    if (followRef.current !== "on") return;
    followRef.current = "paused"; setFollow("paused");
    gen.current++; dirGen.current++; pending.current = null;
    clearTimeout(changesTimer.current);
  };
  const userTab = (t2) => { pause(); setTab(t2); };
  const userDir = (p) => { pause(); setHlEntry(null); loadDir(p); };
  const userFile = (p) => { pause(); loadFile(p); };

  /** #3160: show one of the agent's steps (Follow on, or a click in the strip). */
  const show = (step, automatic = true) => {
    const p = step.paths[0];
    setCurrent(step.id || step.seq);
    if (!p || p.hidden) return;                                                     // listed, never opened
    if (step.phase === "failed") return;
    if (!automatic) setTab("files");
    if (!p.dir && (step.kind === "read" || step.kind === "edit")) {
      setHlEntry(p.path);
      loadFile(p.path, step, automatic);
    } else if (p.dir) { setHlEntry(null); loadDir(p.path, automatic); }
    else { setHlEntry(p.path); loadDir(parentOf(p.path), automatic); }
    if (step.kind === "edit") {                                                     // Changes is current when you look
      clearTimeout(changesTimer.current);
      changesTimer.current = setTimeout(() => { if (alive.current && followRef.current === "on" && visible()) loadChanges(); }, FOLLOW_TIMING.changesMs);
    }
  };
  // The crumbs follow the file without dropping the viewer (loadDir would close it).
  const loadDirQuiet = async (path, token = gen.current, automatic = false) => {
    const mine = ++dirGen.current;
    const r = await read(instance, "list", path);
    if (r.ok && mine === dirGen.current && valid(token, automatic)) { setDir(path); setListing({ state: "ready", body: r.body, path }); }
  };
  actions.current = { show };

  useEffect(() => { linkWorkspaceCss(); }, []);
  useEffect(() => {
    alive.current = true; gen.current++; dirGen.current++; changesGen.current++;
    followRef.current = "off"; setFollow("off"); setHistory([]); setCurrent(null); setFile(null); setListing(null); setTab("changes");
    pos.current = { scope: null, turn: null, last: 0 }; pending.current = null;
    loadChanges();
    return () => { alive.current = false; gen.current++; dirGen.current++; changesGen.current++; clearTimeout(changesTimer.current); };
  }, [instance]);
  // The first visit to Files lists the folder's top without closing a file Follow (or you) just opened.
  useEffect(() => { if (tab === "files" && !listing && !file) loadDirQuiet(""); }, [tab]);
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
  // #3160: while Follow is on (or paused, to keep the strip), ask for this turn's new steps once a second — only while
  // this panel is open (this component is mounted) and the page is visible. The newest step is shown at most every
  // FOLLOW_TIMING.applyMs; the strip keeps all of them.
  useEffect(() => {
    if (follow === "off") return undefined;
    let stopped = false, busy = false;
    const tick = async () => {
      if (stopped || busy || (typeof document !== "undefined" && document.hidden)) return;
      busy = true;
      const { scope, turn, last } = pos.current;
      const r = await read(instance, "follow", undefined, `&after=${last}${turn != null ? `&turn=${turn}` : ""}${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`);
      busy = false;
      if (stopped || !visible()) return;
      if (!r.ok) { if (r.status === 400) setFollowInfo({ supported: false, running: true }); return; }
      const b = r.body;
      setFollowInfo({ supported: !!b.supported, running: !!b.running });
      const fresh = turn !== b.turn || scope !== (b.scope || null);
      pos.current = { scope: b.scope || null, turn: b.turn, last: b.last };
      if (fresh) { pending.current = null; setCurrent(null); }
      if (fresh) setHistory(b.steps.slice(-FOLLOW_TIMING.historyMax));
      else if (b.steps.length) setHistory((h) => {
        const merged = new Map(h.map(s => [s.id || s.seq, s]));
        for (const s of b.steps) merged.set(s.id || s.seq, s);
        return [...merged.values()].slice(-FOLLOW_TIMING.historyMax);
      });
      if (b.steps.length) pending.current = newestStep(b.steps);
      apply();
    };
    const apply = () => {
      const step = pending.current;
      if (!step || followRef.current !== "on" || !visible()) return;
      const now = Date.now();
      if (now - lastApply.current < FOLLOW_TIMING.applyMs) return;                  // the next tick shows the newest
      lastApply.current = now; pending.current = null;
      actions.current.show(step);
    };
    tick();
    const iv = setInterval(() => { tick(); apply(); }, FOLLOW_TIMING.pollMs);
    return () => { stopped = true; clearInterval(iv); };
  }, [follow === "off", instance]);
  useEffect(() => () => clearTimeout(changesTimer.current), []);
  const toggleFollow = () => {
    if (follow === "on") { pause(); followRef.current = "off"; setFollow("off"); setHistory([]); setCurrent(null); pos.current = { scope: null, turn: null, last: 0 }; pending.current = null; return; }
    // Turning it on (or resuming) shows the newest step at once.
    if (follow === "paused" && history.length) pending.current = newestStep(history);
    lastApply.current = 0;
    followRef.current = "on";
    setFollow("on");
  };

  const crumbs = dir ? dir.split("/") : [];
  const notHere = followInfo && !followInfo.supported;
  const followLabel = follow === "on" ? t("chat.wsFollowing") : follow === "paused" ? t("chat.wsFollowPaused") : t("chat.wsFollow");
  return html`<aside data-trust="preview" class=${`pv-panel ws-panel${fs ? ` pv-fs pv-fs-${fs}` : ""}`} ref=${panel} aria-label=${t("chat.wsTitle")} onKeyDown=${onKey}>
    <div class="pv-panel-head">
      <button type="button" class="icon-btn only-narrow pv-panel-close" title=${t("chat.pvBack")} aria-label=${t("chat.pvBack")} onClick=${close}><${Icon} name="back" size=${18} /></button>
      <div class="pv-panel-title"><strong>${t("chat.wsTitle")}</strong><span class="pv-source ws-agent">${name}</span></div>
      <button type="button" class="icon-btn only-wide pv-panel-close" title=${t("chat.pvClose")} aria-label=${t("chat.pvClose")} onClick=${close}><${Icon} name="close" size=${18} /></button>
    </div>
    <div class="pv-panel-bar">
      <div class="seg-inline" role="tablist" aria-label=${t("chat.wsTitle")}>
        <button type="button" role="tab" class=${`btn btn-sm${tab === "changes" ? " on" : ""}`} aria-selected=${tab === "changes" ? "true" : "false"} onClick=${() => userTab("changes")}><${Icon} name="diff" size=${14} /><span class="lbl">${t("chat.wsChanges")}</span></button>
        <button type="button" role="tab" class=${`btn btn-sm${tab === "files" ? " on" : ""}`} aria-selected=${tab === "files" ? "true" : "false"} onClick=${() => userTab("files")}><${Icon} name="file" size=${14} /><span class="lbl">${t("chat.wsFiles")}</span></button>
      </div>
      <span class="grow"></span>
      <button type="button" class=${`btn btn-sm ws-follow${follow === "on" ? " on" : follow === "paused" ? " paused" : ""}`} aria-pressed=${follow === "on" ? "true" : "false"}
        title=${notHere ? t("chat.wsFollowNotHere") : follow === "paused" ? t("chat.wsFollowPausedTitle") : t("chat.wsFollowTitle")} onClick=${toggleFollow}>
        <${Icon} name="eye" size=${14} /><span class="lbl">${followLabel}</span></button>
      <button type="button" class="btn btn-sm ws-refresh" title=${t("chat.wsRefresh")} onClick=${refresh}><${Icon} name="restart" size=${14} /><span class="lbl">${t("chat.wsRefresh")}</span></button>
      <button type="button" class=${`btn btn-sm only-wide pv-panel-fs${fs ? " on" : ""}`} aria-pressed=${fs ? "true" : "false"} title=${t(fs ? "chat.pvFsExit" : "chat.pvFs")} aria-label=${t(fs ? "chat.pvFsExit" : "chat.pvFs")}
        onClick=${() => (fs ? leaveFs() : enterFs())}><${Icon} name=${fs ? "fullscreenexit" : "fullscreen"} size=${14} /></button>
    </div>
    ${follow !== "off" ? html`<${FollowStrip} history=${history} current=${current} info=${followInfo} pick=${(s) => { pause(); show(s, false); }} />` : null}
    <div class="pv-note ws-readonly" role="note">${t("chat.wsReadOnly")}</div>
    <div class="pv-panel-body show-code ws-body" onWheel=${pause} onTouchMove=${pause} onPointerDown=${pause}
      onScroll=${(e) => { const target = e.currentTarget; if (autoScroll.current === target.scrollTop) { autoScroll.current = null; return; } pause(); }}
      onKeyDown=${(e) => { if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) pause(); }}>
      ${tab === "changes" ? html`<${Changes} state=${changes} openFiles=${openFiles} toggle=${(p) => { pause(); setOpenFiles((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; }); }} />`
        : html`<div class="ws-files">
          <nav class="ws-crumbs" aria-label=${t("chat.wsFiles")}>
            <button type="button" class="btn btn-sm btn-ghost" onClick=${() => userDir("")}>${name}</button>
            ${crumbs.map((c, i) => html`<span aria-hidden="true">/</span><button type="button" class="btn btn-sm btn-ghost" onClick=${() => userDir(crumbs.slice(0, i + 1).join("/"))}>${c}</button>`)}
          </nav>
          ${file ? html`<${Viewer} file=${file} instance=${instance} scroll=${(el) => {
            const body = panel.current && panel.current.querySelector(".ws-body");
            if (!body || typeof el.getBoundingClientRect !== "function") return;
            body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 2;
            autoScroll.current = body.scrollTop;
          }} back=${() => { pause(); setFile(null); }} />`
            : html`<${Listing} listing=${listing} dir=${dir} hl=${hlEntry} openDir=${userDir} openFile=${userFile} />`}
        </div>`}
    </div>
  </aside>`;
}

/** #3160: this turn's steps, newest last; a click shows one (and pauses Follow). */
function FollowStrip({ history, current, info, pick }) {
  if (info && !info.supported) return html`<div class="ws-follow-note" role="status">${t("chat.wsFollowNotHere")}</div>`;
  if (info && !info.running) return html`<div class="ws-follow-note" role="status">${t("chat.wsFollowNotRunning")}</div>`;
  if (!history.length) return html`<div class="ws-follow-note" role="status">${t("chat.wsFollowIdle")}</div>`;
  return html`<div class="ws-history" role="list" aria-label=${t("chat.wsThisTurn")}>
    <span class="ws-history-label">${t("chat.wsThisTurn")}</span>
    ${history.flatMap(s => s.paths.map(p => ({ ...s, paths: [p] }))).map((s) => {
      const p = s.paths[0], hidden = !!(p && p.hidden);
      const title = [`${t(`chat.wsKind_${s.kind}`)} ${s.paths.map((x) => x.path || ".").join(", ")}`, hidden ? t("chat.wsHiddenStep") : null, s.exact ? null : t("chat.wsBestEffort")].filter(Boolean).join(" — ");
      return html`<button type="button" role="listitem" key=${`${s.id || s.seq}:${p && p.path}`} class=${`ws-step k-${s.kind}${(s.id || s.seq) === current ? " is-current" : ""}${hidden ? " is-hidden" : ""}`}
        title=${title} aria-current=${(s.id || s.seq) === current ? "true" : undefined} disabled=${hidden} onClick=${() => pick(s)}>
        <span class="ws-step-kind">${t(`chat.wsKind_${s.kind}`)}${s.exact ? "" : " ≈"}</span><span class="ws-step-path">${p ? baseOf(p.path) : ""}</span></button>`;
    })}
  </div>`;
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

function Listing({ listing, hl, openDir, openFile }) {
  if (!listing || listing.state === "loading") return html`<div class="pv-note">${t("chat.pvLoading")}</div>`;
  if (listing.state === "failed") return html`<div class="pv-note" role="alert">${errText(listing.error)}</div>`;
  const l = listing.body;
  return html`<div>
    ${l.cut ? html`<div class="pv-note" role="status">${t("chat.wsDirCut")}</div>` : null}
    ${!l.entries.length ? html`<div class="pv-note">${t("chat.wsEmptyDir")}</div>` : null}
    <ul class="ws-entries">${l.entries.map((e) => {
      const rel = l.path ? `${l.path}/${e.name}` : e.name;
      const usable = !e.hidden && (e.type === "dir" || e.type === "file");
      return html`<li key=${e.name} class=${`ws-entry t-${e.type}${e.hidden ? " is-hidden" : ""}${hl === rel ? " hl" : ""}`}>
        <button type="button" class="ws-entry-btn" disabled=${!usable} onClick=${() => (e.type === "dir" ? openDir(rel) : openFile(rel))}>
          <${Icon} name=${e.type === "dir" ? "chevron" : e.type === "symlink" ? "external" : "file"} size=${14} />
          <span class="ws-name">${e.name}${e.type === "dir" ? "/" : ""}</span>
          <span class="ws-meta">${e.hidden ? t("chat.wsHiddenFile") : e.type === "symlink" ? t("chat.wsLink") : e.type === "file" ? size(e.size) : ""}</span>
        </button></li>`;
    })}</ul></div>`;
}

/** Whether line `n` (1-based) is in the step's highlight. */
const hlOf = (hl, n) => !hl ? null : hl.kind === "edit" ? (hl.lines.has(n) ? "hl-edit" : null) : n >= hl.from && n <= hl.to ? "hl-read" : null;

function Viewer({ file, instance, back, scroll }) {
  const pre = useRef(null);
  const head = html`<div class="ws-viewer-head"><button type="button" class="btn btn-sm" onClick=${back}><${Icon} name="back" size=${14} />${t("chat.pvBack")}</button><code class="ws-path">${file.path}</code></div>`;
  // #3160: bring the first highlighted line into view (a programmatic scroll: it does not pause Follow).
  useEffect(() => {
    const el = pre.current && pre.current.querySelector(".ws-line.hl-edit, .ws-line.hl-read");
    if (el && typeof scroll === "function") scroll(el);
  }, [file]);
  if (file.state === "loading") return html`<div>${head}<div class="pv-note">${t("chat.pvLoading")}</div></div>`;
  if (file.state === "failed") return html`<div>${head}<div class="pv-note" role="alert">${errText(file.error)}</div></div>`;
  const f = file.body;
  if (f.kind === "image") return html`<div>${head}<img class="ws-image" alt=${f.path} src=${api(instance, "image", f.path)} /></div>`;
  if (f.kind !== "text") return html`<div>${head}<div class="pv-note">${t(f.kind === "binary" ? "chat.wsBinaryFile" : "chat.wsTooLargeFile", size(f.size))}</div></div>`;
  const lines = f.text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const hl = file.hl, w = String(lines.length).length;
  return html`<div>${head}
    ${hl ? html`<div class="ws-follow-note" role="status">${t(hl.kind === "edit" ? hl.exact ? "chat.wsFollowHlEditExact" : "chat.wsFollowHlEdit" : "chat.wsFollowHlRead")}</div>` : null}
    <pre class="pv-code ws-text" ref=${pre}><code>${lines.map((l, i) => {
      const cls = hlOf(hl, i + 1);
      return html`<span class=${`ws-line${cls ? ` ${cls}` : ""}`} data-line=${i + 1}><span class="ws-ln" aria-hidden="true">${String(i + 1).padStart(w, " ")}</span>${`${l}\n`}</span>`;
    })}</code></pre></div>`;
}
