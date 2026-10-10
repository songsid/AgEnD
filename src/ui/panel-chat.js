// #1408 step 1: the chat panel. Behind the session gate (/ui/js/), loaded by the app with a dynamic import in "full"
// mode only. boot() runs once per page (the chat store must hear the stream from the first frame); <ChatPanel> mounts
// for /ui and /ui/chat/<name>.
//
// The look follows the design (§2): the conversation in a centred column, the person's messages as bubbles on the
// right, the agent's at full width, and one rounded composer pinned below with attach, Stop reply and Send inside it.
// The instance's own actions (details, start, stop, restart, delete) are in the header's ⋯ menu, and only the ones
// that apply to its state are offered (#1408 rough edges 4 and 7).
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, onPanelKey, setTitle, addFooterItem, statusClass, statusLabel, openDrawer, requestNewInstance } from "/assets/app-shell.js";
import { detailsPath } from "/assets/app-route.js";
import { InstanceSwitch } from "/assets/instance-switch.js";
import { HeaderTools } from "/assets/header-tools.js";
import { navigate } from "/assets/app-nav.js";
import { Menu } from "/assets/ui-menu.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import "./chat-strings.js";
import { confirmedWrite } from "./settings-confirm.js";
import { createChatStore } from "./chat-store.js";
import { createThread, msgKey } from "./chat-thread.js";
import { PreviewPanel, openPanel, panelStore, shownKey } from "./preview-panel.js";
import { needsArgument, paletteFor, parseCommandLine } from "./chat-commands.js";
import { installTour, refreshTourSpot, startTour } from "./chat-tour.js";
import { FirstRunCard } from "./first-run.js";
import { LightboxHost, openLightbox } from "./image-lightbox.js";

const R = () => globalThis.AgendChatRender;
const P = () => globalThis.AgendPreview;

/** The page's chat store (boot creates it). Exported for the tests. */
export let store = null;

// ── Announcements: one polite, visually hidden line for the coarse events only (a reply arrived, the agent started,
// finished, or waits on you). Messages themselves are not read out as they arrive; the list is a log to browse.
let announceTimer = null;
function announce(text) {
  let el = document.getElementById("announcer");
  if (!el) { el = document.createElement("div"); el.id = "announcer"; el.className = "sr-only"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite"); el.setAttribute("aria-atomic", "true"); document.body.appendChild(el); }
  if (!text) return;
  el.textContent = "";
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.textContent = text; }, 60);
}

/**
 * This device's preview opt-in: asks once (the app's dialog) and says what it means; turning it off stops every
 * running preview. Resolves to the choice in force.
 */
export async function setPreviewOptIn(on) {
  if (on && !P().optedIn() && !(await confirmDialog({ message: t("chat.pvConfirm"), confirmLabel: t("chat.pvAllowButton") }))) on = false;
  P().setOptIn(on);
  return P().optedIn();
}

/** Once per page, in "full" mode: the store on the app's stream, previews (#1306), the sidebar's chat controls. */
export function boot({ stream, boot: bootData, deps = {} }) {
  if (store) return store;
  store = createChatStore({
    fetch: (...a) => fetch(...a), toast, announce, t, setTimeout: (fn, ms) => setTimeout(fn, ms), confirm: confirmDialog, ...deps,
  });
  store.attach(stream);
  // #1306: what the server said about previews for this load. The page-wide message and storage listeners this adds
  // belong to the app, once (they are never per mount).
  // #1554: its words in the page's language (chat.pv*); a key the dictionary does not have keeps preview.js's English.
  if (P() && bootData) P().init(bootData, { text: (key, ...v) => { const k = `chat.${key}`, s = t(k, ...v); return s === k ? null : s; } });
  addFooterItem("previews", PreviewOptIn);
  addFooterItem("tour", TourButton);
  installTour();
  return store;
}

function PreviewOptIn() {
  const [on, setOn] = useState(P() ? P().optedIn() : false);
  useEffect(() => (P() ? P().onChange(() => setOn(P().optedIn())) : undefined), []);
  return html`<label class="side-row toggle"><input type="checkbox" checked=${on} onChange=${(e) => { const want = e.target.checked; setPreviewOptIn(want).then(setOn); }} />
    <span>${t("chat.previews")}</span></label>`;
}
function TourButton() {
  return html`<button type="button" id="tourBtn" class="side-row" title=${t("chat.tourBtnTitle")} onClick=${startTour}><${Icon} name="info" /><span>${t("chat.tour")}</span></button>`;
}

// ── Code wrap: this browser's choice (agend_code_wrap). On a phone, code wraps whatever it is (app.css).
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
let codeWrap = stored("agend_code_wrap") === "1";
const wrapListeners = new Set();
function toggleWrap() {
  codeWrap = !codeWrap;
  try { localStorage.setItem("agend_code_wrap", codeWrap ? "1" : "0"); } catch { /* this page only */ }
  for (const fn of wrapListeners) fn(codeWrap);
}

async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.className = "offscreen";
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
/** The HTML as a file: a blob of the source as application/octet-stream, saved as reply.html — never opened. */
function downloadHtml(code, name) {
  const url = URL.createObjectURL(new Blob([code], { type: "application/octet-stream" }));
  const a = document.createElement("a"); a.href = url; a.download = typeof name === "string" && name.trim() ? name.trim() : "reply.html"; a.className = "offscreen";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** Re-render when the store changes for `name` (or for everyone). `kind` "msgs" is the thread's alone. */
function useChatTick(name, kinds) {
  const [, tick] = useState(0);
  useEffect(() => store.subscribe((instance, kind) => {
    if ((instance === null || instance === name) && (!kinds || kinds.includes(kind || "state"))) tick(n => n + 1);
  }), [name]);
}

// ── The panel ──

export function ChatPanel({ route, navKey }) {
  const lease = useLease(navKey);
  const app = useStore(appStore);
  const name = route.instance;
  const inst = name ? app.instances.find(i => i.name === name) : null;
  useEffect(() => {
    store.setCurrent(name && inst ? name : null);
    return () => store.setCurrent(null);
  }, [name, !!inst]);
  useEffect(() => { setTitle(name || t("app.chat")); }, [name, navKey]);
  if (!name) {
    // #1519 P7: a web-only fleet starts here with the first-run card; with no agent at all, the way to make one.
    const none = app.ready && !app.instances.length;
    return html`<div class="panel p-chat"><${PanelHeader} title=${t("app.chat")} />
      <div class="panel-body center"><div class="first-run-stack"><${FirstRunCard} />
        ${none ? html`<${Empty} icon="bot" title=${t("app.noInstances")} hint=${t("app.noInstancesHint")}
          action=${html`<button type="button" class="btn btn-primary" onClick=${requestNewInstance}><${Icon} name="plus" size=${16} />${t("app.newInstance")}</button>`} />`
        : html`<${Empty} icon="chat" title=${t("chat.pick")} hint=${t("chat.pickHint")}
          action=${html`<button type="button" class="btn only-narrow" onClick=${openDrawer}>${t("chat.backToList")}</button>`} />`}</div></div></div>`;
  }
  if (!app.ready) return html`<div class="panel p-chat"><${PanelHeader} title=${name} /><div class="panel-body"><${Skeleton} lines=${5} /></div></div>`;
  if (!inst) return html`<${NotFound} name=${name} />`;
  return html`<${ChatView} key=${name} name=${name} inst=${inst} lease=${lease} navKey=${navKey} exec=${app.exec[name]}
    awaiting=${Object.prototype.hasOwnProperty.call(app.awaiting, name) ? app.awaiting[name] : null} />`;
}

function NotFound({ name }) {
  // A remembered chat that no longer exists is forgotten, so /ui does not come back here.
  useEffect(() => { try { if (localStorage.getItem("agend_last_instance") === name) localStorage.removeItem("agend_last_instance"); } catch { /* none */ } }, [name]);
  return html`<div class="panel p-chat"><${PanelHeader} title=${name} />
    <div class="panel-body center"><${Empty} icon="alert" title=${t("chat.notFound", name)} hint=${t("chat.notFoundHint")}
      action=${html`<button type="button" class="btn only-narrow" onClick=${openDrawer}>${t("chat.backToList")}</button>`} /></div></div>`;
}

function ChatView({ name, inst, lease, navKey, exec, awaiting }) {
  const [dialog, setDialog] = useState(null);       // "delete" | null
  const [wrap, setWrap] = useState(codeWrap);
  const view = useRef(null), split = useRef(null), thread = useRef(null);
  useEffect(() => { wrapListeners.add(setWrap); return () => wrapListeners.delete(setWrap); }, []);
  // First visit to this instance's chat on this page: its history (a navigation — it counts as use). Back again: nothing.
  useEffect(() => { store.openHistory(name, lease); }, [name]);
  useEffect(() => { try { localStorage.setItem("agend_last_instance", name); } catch { /* none */ } }, [name]);
  // Files dragged over the chat show where they go; a drop attaches them (counted, so moving over messages does not flicker).
  useEffect(() => {
    const el = view.current; if (!el) return undefined;
    let depth = 0;
    const hasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes("Files"));
    lease.on(el, "dragenter", (e) => { if (hasFiles(e)) { depth++; el.classList.add("dragging"); } });
    lease.on(el, "dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    lease.on(el, "dragleave", (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; el.classList.remove("dragging"); } });
    lease.on(el, "drop", (e) => { depth = 0; el.classList.remove("dragging"); if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); store.addFiles(name, e.dataTransfer.files); } });
    return undefined;
  }, [lease]);
  // Esc stops the agent's reply (as Esc in its terminal would): from the chat, while it works, and only when nothing
  // else that Esc would close is open (a dialog, a menu, the Session menu).
  useEffect(() => lease.hold(onPanelKey((e) => {
    if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
    if (!R().isBusy(store.state.exec[name]) || store.state.stopping[name] || store.state.cancelling[name]) return;
    if (document.querySelector("dialog[open], .menu-list, .pop")) return;
    const active = document.activeElement;
    if (active && active !== document.body && !(view.current && view.current.contains(active))) return;
    e.preventDefault();
    store.cancelReply(name);
  })), [lease]);
  const running = inst.status === "running";
  const action = async (verb) => {
    let r;
    try { const res = await fetch(`/ui/${verb}/${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/json" } }); r = await res.json(); }
    catch (err) { r = { error: err && err.message ? err.message : t("chat.disconnected") }; }
    if (r && r.error) toast(r.error, false);
    else toast(t(verb === "start" ? "chat.started" : verb === "stop" ? "chat.stoppedInst" : "chat.restarted", name));
  };
  const items = [
    // #1523 N2: Details is a page now (the Fleet side of this instance), not a dialog.
    { key: "details", label: t("chat.details"), icon: "info", onSelect: () => navigate(detailsPath(name)) },
    running ? null : { key: "start", label: t("chat.start"), icon: "play", onSelect: () => action("start") },
    running ? { key: "restart", label: t("chat.restart"), icon: "restart", onSelect: () => action("restart") } : null,
    running ? { key: "stop", label: t("chat.stopInstance"), icon: "stop", onSelect: () => action("stop") } : null,
    { key: "delete", label: t("chat.delete"), icon: "trash", danger: true, onSelect: () => setDialog("delete") },
  ];
  const cls = statusClass(inst, exec, awaiting);
  // #1269 quick actions: the model and effort it runs, each a way to /model or /effort (the same pick list).
  const pick = (command) => store.runCommand(name, command, "", { alive: () => lease.current() });
  const sub = html`<span class="status"><span class=${`dot ${cls}`} aria-hidden="true"></span>${statusLabel(inst, exec, awaiting)}</span>
    ${inst.model ? html`<button type="button" class="hd-chip" title=${t("chat.chipModel", inst.model)} aria-label=${t("chat.chipModel", inst.model)} onClick=${() => pick("model")}>${inst.model}</button>` : null}
    ${inst.effort ? html`<button type="button" class="hd-chip" title=${t("chat.chipEffort", inst.effort)} aria-label=${t("chat.chipEffort", inst.effort)} onClick=${() => pick("effort")}>${inst.effort}</button>` : null}`;
  return html`<div class=${`panel p-chat${wrap ? " wrap-code" : ""}`} ref=${view}>
    <${PanelHeader} title=${name} sub=${sub} nav=${html`<${InstanceSwitch} name=${name} current="chat" />`}><${HeaderTools} navKey=${navKey} /><${Menu} items=${items} label=${t("app.more")} /></${PanelHeader}>
    <div class="chat-split" ref=${split}>
      <div class="chat-main">
        <${Thread} name=${name} th=${thread} />
        <${Dock} name=${name} inst=${inst} lease=${lease} exec=${exec} awaiting=${awaiting} />
      </div>
      <${PreviewPanel} name=${name} split=${split} msgs=${() => store.state.msgs[name] || []} subscribe=${(fn) => store.subscribe(fn)}
        keyOf=${msgKey} reveal=${(k) => thread.current && thread.current.reveal(k)} download=${downloadHtml} allow=${() => setPreviewOptIn(true)} />
    </div>
    <${LightboxHost} />
    <div class="drop-overlay" aria-hidden="true"><div class="drop-card"><${Icon} name="attach" size=${32} /><span>${t("chat.dropHere")}</span></div></div>
    ${dialog === "delete" ? html`<${DeleteDialog} name=${name} onClose=${() => setDialog(null)} />` : null}
  </div>`;
}

/** The thread: Preact owns the elements, the keyed renderer owns what is inside the list (chat-thread.js). */
function Thread({ name, th }) {
  const scroller = useRef(null), list = useRef(null);
  const [jump, setJump] = useState({ show: false, unseen: 0 });
  const [empty, setEmpty] = useState(false);
  useLayoutEffect(() => {
    const thread = createThread(list.current, scroller.current, {
      t, tf: t, isUser: (x) => store.isUser(x, name), onJump: setJump, onEmpty: setEmpty,
      setPreviewOptIn, copyText, download: downloadHtml, toggleWrap,
      clickReplyButton: (id, index) => store.clickReplyButton(name, id, index),      // #1266
      replyButtonBusy: (id) => store.state.rbBusy.has(id),
      panel: { shown: shownKey, open: (spec, o) => openPanel(spec, o) },   // #1481
      openImage: openLightbox,                                               // an image, full size, in the page
    });
    th.current = thread;
    thread.render(store.state.msgs[name] || [], { restore: store.state.scrollMemo[name] ?? null });
    const off = store.subscribe((instance, kind) => {
      if (instance !== name) return;
      if (kind === "msgs") thread.render(store.state.msgs[name] || []);
      else if (kind === "sent") thread.jumpLatest();
    });
    const offPv = P() ? P().onChange(() => thread.refreshCards()) : () => {};
    const offPanel = panelStore.subscribe(() => thread.refreshCards());   // a card shows whether the panel has its block
    const onScroll = () => { store.state.scrollMemo[name] = thread.onScroll(); };
    const sc = scroller.current, ls = list.current;
    sc.addEventListener("scroll", onScroll, { passive: true });
    ls.addEventListener("click", thread.onClick);
    return () => {
      off(); offPv(); offPanel();
      sc.removeEventListener("scroll", onScroll);
      ls.removeEventListener("click", thread.onClick);
      thread.dispose();                     // the whole thread goes: every preview in it stops first
      th.current = null;
    };
  }, [name]);
  return html`<div class="scroller" ref=${scroller}>
    <div class="thread" ref=${list} role="log" aria-live="off" aria-label=${t("chat.conversationWith", name)}></div>
    ${empty ? html`<${Empty} icon="chat" title=${t("chat.noMessages")} hint=${t("chat.sendFirst")} />` : null}
    ${jump.show ? html`<button type="button" class="jump-latest" onClick=${() => th.current && th.current.jumpLatest()}>
      <${Icon} name="down" size=${16} />${jump.unseen > 0 ? t("chat.newBelow", jump.unseen) : t("chat.jumpLatest")}</button>` : null}
  </div>`;
}

/** Everything under the thread: prompts, the working line, a failed send, files waiting, and the composer. */
function Dock({ name, inst, lease, exec, awaiting }) {
  useChatTick(name, ["state"]);
  const s = store.state;
  return html`<div class="dock"><div class="dock-col">
    <${Prompts} name=${name} />
    <${WorkBar} name=${name} lease=${lease} exec=${exec} awaiting=${awaiting} />
    <${CommandCard} name=${name} lease=${lease} />
    <${QuickActions} name=${name} inst=${inst} lease=${lease} />
    ${s.failedSends[name] ? html`<div class="failed-send" role="alert"><span>${t("chat.notSent")}</span><span class="txt">${s.failedSends[name]}</span>
      <button type="button" class="btn btn-primary btn-sm" onClick=${() => store.putBack(name)}>${t("chat.putBack")}</button>
      <button type="button" class="btn btn-sm" onClick=${() => store.discardFailed(name)}>${t("chat.discard")}</button></div>` : null}
    <${Composer} name=${name} lease=${lease} busy=${R().isBusy(exec)} />
    <p class="hint">${t("chat.composerHint")}</p>
  </div></div>`;
}

/** #1269: what the last chat command answered — its text, why it was refused, or a list to choose from. */
function CommandCard({ name, lease }) {
  const c = store.state.commands[name];
  if (!c) return null;
  const run = (args) => store.runCommand(name, c.command, args, { alive: () => lease.current() });
  return html`<div class=${`cmd-card${c.error ? " bad" : ""}`} role=${c.error ? "alert" : "status"}>
    <div class="cmd-head"><span class="cmd-name mono">/${c.command}</span>
      ${c.busy ? html`<span class="wait">${t("chat.cmdRunning", c.command)}</span>` : html`<button type="button" class="icon-btn" title=${t("chat.cmdDismiss")}
        aria-label=${t("chat.cmdDismiss")} onClick=${() => store.dismissCommand(name)}><${Icon} name="close" size=${14} /></button>`}</div>
    ${c.error ? html`<p class="cmd-text">${c.error}</p>` : null}
    ${c.text ? html`<pre class="cmd-text">${c.text}</pre>` : null}
    ${c.choices ? html`<div class="cmd-choices" role="group" aria-label=${t("chat.cmdChoose")}>${c.choices.options.map((o) => html`<button key=${o.id} type="button"
      class=${`btn btn-sm${o.id === c.choices.current ? " current" : ""}`} aria-current=${o.id === c.choices.current ? "true" : undefined} onClick=${() => run(o.id)}>${o.label}</button>`)}</div>` : null}
  </div>`;
}

/** #1269 quick actions: Compact and Clear… once the instance's context is 70% used (from the status it already has). */
function QuickActions({ name, inst, lease }) {
  const pct = inst && typeof inst.context_pct === "number" ? Math.round(inst.context_pct) : null;
  if (pct == null || pct < 70) return null;
  const busy = !!(store.state.commands[name] && store.state.commands[name].busy);
  const run = (command) => store.runCommand(name, command, "", { alive: () => lease.current() });
  return html`<div class="quick-actions" role="group" aria-label=${t("chat.chipContext", pct)}>
    <span class="qa-ctx">${t("chat.chipContext", pct)}</span>
    <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => run("compact")}>${t("chat.chipCompact")}</button>
    <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => run("clear")}>${t("chat.chipClear")}</button>
  </div>`;
}

function Prompts({ name }) {
  const list = store.promptsFor(name);
  if (!list.length) return null;
  return html`<div class="prompts" aria-live="polite">${list.map(p => html`<div key=${p.nonce} class=${`prompt${p.resolved ? " done" : ""}`} role="group" aria-label=${p.text}>
    <div class="txt">${p.resolved ? (p.outcome || t("chat.promptGone")) : p.text}</div>
    ${p.resolved ? null : html`<div class="acts">${p.actions.map(a => html`<button key=${a.id} type="button" class="btn" disabled=${!!p.busy} onClick=${() => store.answerPrompt(p, a.id)}>${a.label}</button>`)}
      ${p.busy ? html`<span class="wait">${t("chat.promptAnswering")}</span>` : null}</div>`}</div>`)}</div>`;
}

/** "<name> is working… 0:42", "looks stuck", "Stopping…", or what it waits on at its terminal. Text only. */
function WorkBar({ name, lease, exec, awaiting }) {
  const s = store.state;
  const busy = R().isBusy(exec) ? exec : "";
  const kind = awaiting != null ? "awaiting" : s.stopping[name] && busy ? "stopping" : busy;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!kind || kind === "awaiting") return undefined;
    const h = lease.interval(() => tick(n => n + 1), 1000);      // ticks only while it shows, cleared with the lease
    return () => lease.clear(h);
  }, [kind, lease]);
  if (!kind) return null;
  const label = t(kind === "stuck" ? "chat.stuck" : kind === "stopping" ? "chat.stopping" : kind === "awaiting" ? "chat.awaiting" : "chat.working", name);
  const since = s.workingSince[name];
  return html`<div class=${`work-bar ${kind}`}><span class="pulse" aria-hidden="true"></span><span class="lbl">${label}</span>
    ${kind === "awaiting" ? html`<span class="note" title=${t("chat.approxNote")}>${awaiting || t("chat.approxNote")}</span>`
      : html`<span class="elapsed" title=${t("chat.elapsedTitle")} aria-hidden="true">${since == null ? "" : R().formatElapsed(performance.now() - since)}</span>`}</div>`;
}

function Composer({ name, lease, busy }) {
  const s = store.state;
  const input = useRef(null), fileIn = useRef(null);
  const [, tick] = useState(0);
  const [sel, setSel] = useState(0);
  const [closedFor, setClosedFor] = useState(null);    // the draft the palette was closed on (Esc); it opens again on change
  const value = s.drafts[name] || "";
  const files = s.pendingFiles[name] || [];
  const content = !!value.trim() || files.length > 0;
  // A file waiting: what goes is a message with its file, never a command (no palette, no command line).
  const palette = files.length || closedFor === value ? null : paletteFor(value);
  const pick = palette && palette.length ? palette[Math.min(sel, palette.length - 1)] : null;
  // Grow with the text, up to a limit: set through the CSSOM, never a style attribute (#1300).
  useLayoutEffect(() => { const el = input.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 240)}px`; }, [value]);
  useEffect(() => { if (input.current) input.current.focus(); }, [name]);
  useEffect(() => { refreshTourSpot(); });
  const setValue = (v) => { store.setDraft(name, v); setSel(0); tick(n => n + 1); };
  // #1269: a command line runs the command (POST /ui/command); anything else — "/" included — is sent as before.
  // The draft is consumed only by a command that starts: one still out keeps the new line in the composer (#1476 review).
  const runLine = (cmd) => {
    if (!store.commandFree(name)) return;
    setValue("");
    store.runCommand(name, cmd.command, cmd.args, { alive: () => lease.current() });
  };
  const complete = (c) => setValue(`/${c.name}${c.arg ? " " : ""}`);
  const submit = () => {
    if (pick) {
      if (value === `/${pick.name}` && !needsArgument(pick.name)) runLine({ command: pick.name, args: "" });
      else complete(pick);
      return;
    }
    const cmd = files.length ? null : parseCommandLine(value);
    if (cmd && needsArgument(cmd.command) && !cmd.args) { setValue(`/${cmd.command} `); return; }
    if (cmd) { runLine(cmd); return; }
    store.send(name);
  };
  const onKeyDown = (e) => {
    if (palette && palette.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSel((n) => (Math.min(n, palette.length - 1) + (e.key === "ArrowDown" ? 1 : palette.length - 1)) % palette.length);
      return;
    }
    if (pick && e.key === "Tab" && !e.shiftKey) { e.preventDefault(); complete(pick); return; }
    if (palette && e.key === "Escape" && !e.isComposing) { e.preventDefault(); setClosedFor(value); return; }
    if (R().composerKey(e) === "send") { e.preventDefault(); submit(); }
  };
  const onInput = (e) => { setValue(e.target.value); };
  // Files in a paste are attached; a very long text paste goes as a text file — only once it is really attached.
  const onPaste = (e) => {
    const list = e.clipboardData && e.clipboardData.files;
    const text = e.clipboardData ? e.clipboardData.getData("text") : "";
    if (list && list.length) { store.addFiles(name, list); if (!text) e.preventDefault(); return; }
    if (R().isLongPaste(text) && store.attachPastedText(name, text)) e.preventDefault();
  };
  const optId = (c) => `cmd-${c.name}`;
  return html`<div class="composer-box">
    ${palette ? html`<ul class="cmd-palette" id="cmdPalette" role="listbox" aria-label=${t("chat.cmdCommands")}>
      ${palette.length ? palette.map((c) => html`<li key=${c.name} id=${optId(c)} role="option" aria-selected=${c === pick ? "true" : "false"}
          class=${c === pick ? "on" : ""} onMouseDown=${(e) => { e.preventDefault(); complete(c); }}>
          <span class="cmd-name mono">/${c.name}${c.arg ? html` <span class="cmd-arg">${c.arg}</span>` : null}</span><span class="cmd-desc">${t(`chat.cmd_${c.name}`)}</span></li>`)
        : html`<li class="cmd-none" role="option" aria-selected="false">${t("chat.cmdNotCommand")}</li>`}
    </ul>` : null}
    ${files.length ? html`<div class="pending-files">${files.map((f, i) => html`<${FileChip} key=${`${f.name}-${i}`} f=${f} i=${i} name=${name} />`)}</div>` : null}
    <div class="composer">
      <button id="attachBtn" type="button" class="icon-btn" title=${t("chat.attachTitle")} aria-label=${t("chat.attachTitle")} onClick=${() => fileIn.current && fileIn.current.click()}><${Icon} name="attach" /></button>
      <input ref=${fileIn} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.log,.yaml,.yml"
        onChange=${(e) => { store.addFiles(name, e.target.files); e.target.value = ""; }} />
      <textarea id="msgIn" ref=${input} rows="1" value=${value} placeholder=${t("chat.composerPlaceholder", name)} aria-label=${t("chat.composerPlaceholder", name)}
        autocomplete="off" aria-controls=${palette ? "cmdPalette" : undefined} aria-expanded=${palette ? "true" : "false"}
        aria-activedescendant=${pick ? optId(pick) : undefined} onInput=${onInput} onKeyDown=${onKeyDown} onPaste=${onPaste}></textarea>
      <button id="stopBtn" type="button" class="btn btn-stop" hidden=${!busy} title=${t("chat.stopReplyTitle")}
        disabled=${!!s.cancelling[name]} onClick=${() => store.cancelReply(name)}><${Icon} name="stop" size=${14} /><span class="stop-label">${t("chat.stopReply")}</span></button>
      <button id="sendBtn" type="button" class="btn btn-primary btn-send" hidden=${busy && !content} disabled=${!content || !!s.sending[name]}
        aria-label=${t("chat.send")} title=${t("chat.send")} onClick=${submit}><${Icon} name="send" size=${16} /><span class="send-label">${t("chat.send")}</span></button>
    </div></div>`;
}

function FileChip({ f, i, name }) {
  const img = useRef(null);
  const isImage = /^image\//.test(f.type) && typeof URL.createObjectURL === "function";
  useEffect(() => {
    if (!isImage || !img.current) return undefined;
    const url = URL.createObjectURL(f);
    img.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [f]);
  return html`<span class="file-chip">
    ${isImage ? html`<img ref=${img} alt="" />` : html`<span class="ic"><${Icon} name="file" size=${16} /></span>`}
    <span class="nm">${f.name}</span><span class="sz">${R().formatSize(f.size)}</span>
    ${store.isPasted(f) ? html`<button type="button" class="as-text" onClick=${() => store.fileBackAsText(name, i)}>${t("chat.asText")}</button>` : null}
    <button type="button" class="chip-x" title=${t("chat.removeFile")} aria-label=${`${t("chat.removeFile")} ${f.name}`} onClick=${() => store.removeFile(name, i)}><${Icon} name="close" size=${14} /></button></span>`;
}

// ── Dialogs ──

function DeleteDialog({ name, onClose }) {
  // The dialog's own lease: it ends when the dialog goes (closed, or the chat left for another page). The delete
  // may still finish on the server, and says so, but a dialog that is gone never closes or navigates the page the
  // person is on now (#1425 review).
  const lease = useLease(`delete:${name}`);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const want = `delete ${name}`;
  async function go() {
    if (typed !== want || busy) return;
    setBusy(true);
    let r, handedOver = false;
    // Deleting an instance may need a fleet admin's confirmation (#1423): then the dialog goes at once and the shell
    // follows the request. From then on the dialog is done: the decision is said in a toast, and it never closes or
    // navigates anything (the person may be anywhere by then).
    try {
      const res = await confirmedWrite(`/ui/instances/${encodeURIComponent(name)}/delete`, { method: "POST", body: { confirm: typed }, label: t("chat.deleteTitle", name),
        onPending: () => { handedOver = true; toast(t("app.pendingSent")); if (lease.current()) { setBusy(false); onClose(); } } });
      r = res.ok ? res.body || {} : { error: (res.body && res.body.error) || `HTTP ${res.status}` };
    } catch (err) { r = { error: err && err.message ? err.message : t("chat.disconnected") }; }
    if (r && r.error) { toast(r.error, false); if (!handedOver && lease.current()) setBusy(false); return; }
    toast(t("chat.instanceDeleted", name));
    if (handedOver || !lease.current()) return;
    setBusy(false);
    onClose();
    navigate("/ui");
  }
  return html`<${Dialog} title=${t("chat.deleteTitle", name)} onClose=${onClose} busy=${busy}
    actions=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${t("chat.cancel")}</button>
      <button type="button" class="btn btn-danger" disabled=${typed !== want || busy} onClick=${go}>${t("chat.deleteGo")}</button>`}>
    <p>${t("chat.deleteHelp", name)}</p>
    <label class="field"><span class="sr-only">${t("chat.deleteHelp", name)}</span>
      <input type="text" value=${typed} autocomplete="off" spellcheck="false" placeholder=${want} onInput=${(e) => setTyped(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Enter") go(); }} /></label>
  </${Dialog}>`;
}
