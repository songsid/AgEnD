// #1408 step 1: the chat panel. Behind the session gate (/ui/js/), loaded by the app with a dynamic import in "full"
// mode only. boot() runs once per page (the chat store must hear the stream from the first frame); <ChatPanel> mounts
// for /ui and /ui/chat/<name>.
//
// The look follows the design (§2): the conversation in a centred column, the person's messages as bubbles on the
// right, the agent's at full width, and one rounded composer pinned below with attach, Stop reply and Send inside it.
// The instance's own actions (details, start, stop, restart, delete) are in the header's ⋯ menu, and only the ones
// that apply to its state are offered (#1408 rough edges 4 and 7).
import { html, useCallback, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { lang, t } from "/assets/app-i18n.js";
import { appStore, createStore, guestPage, useStore } from "/assets/app-store.js";
import { ComposerAuth } from "/assets/web-authorize.js";
import { useLease } from "/assets/app-ctx.js";
import { modelText, namesOf, namesStore, navStore as instanceNavStore } from "/assets/instance-nav.js";
import { PanelHeader, onPanelKey, setTitle, statusClass, statusLabel, openDrawer, requestNewInstance } from "/assets/app-shell.js";
import { detailsPath, textLinkSegments } from "/assets/app-route.js";
import { InstanceSwitch } from "/assets/instance-switch.js";
import { HeaderTools } from "/assets/header-tools.js";
import { navigate, navStore } from "/assets/app-nav.js";
import { Menu } from "/assets/ui-menu.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { savePref } from "/assets/app-prefs.js";
import { applyTheme, clearAmbient, resolvedMode, themeFor, themeImageUrl, themeMenuItems, themesStore } from "/assets/app-themes.js";
import { colorMenuItem } from "/assets/identity-color.js";
import { brokenPictures, cardFoldable, IdentityCard, useCard } from "/assets/identity-card.js";
import { AgentWidget, instanceBinds, widgetFor } from "/assets/agent-widget.js";

// #1629 r4 §1: the identity card under the chat's header — hidden by default; shown or not is this device's choice.
// #2217 (the user, 2026-10-19): no row of its own; its picture and bio can be folded away (the banner stays) — this
// device's choice too, kept the same way. The user (2026-10-20): no control on the card — one card button in the header
// (a guest's and the public link's header too: they have no ⋯ menu), pressed-looking while the card is shown, opens a
// small menu of two checkboxes: Show card, and Show picture and bio (disabled while the card is hidden, or when it cannot
// fold: no banner, or nothing on its row).
const CHAT_CARD_KEY = "agend_chat_card";
const CHAT_CARD_ROW_KEY = "agend_chat_card_row";
const readKey = (k, v) => { try { return localStorage.getItem(k) === v; } catch { return false; } };
const writeKey = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* this page only */ } };
/** Shared by the header's Show card and the card itself, so the two never disagree. */
export const chatCardPrefs = createStore({ open: readKey(CHAT_CARD_KEY, "open"), rowHidden: readKey(CHAT_CARD_ROW_KEY, "hidden") });
export const setChatCardOpen = (open) => { writeKey(CHAT_CARD_KEY, open ? "open" : null); chatCardPrefs.set((s) => ({ ...s, open })); };
export const setChatCardRowHidden = (rowHidden) => { writeKey(CHAT_CARD_ROW_KEY, rowHidden ? "hidden" : null); chatCardPrefs.set((s) => ({ ...s, rowHidden })); };
function ChatCard({ name, card }) {
  const prefs = useStore(chatCardPrefs);
  if (!card || !prefs.open) return null;
  return html`<div data-trust="card" class="chat-card open">
    <${IdentityCard} name=${name} card=${card} compact=${true} rowHidden=${prefs.rowHidden} />
  </div>`;
}
/** The header's card menu: ☑ Show card, ☑ Show picture and bio. */
function CardMenu({ card }) {
  const prefs = useStore(chatCardPrefs);
  useStore(brokenPictures);                        // a banner that failed to load: the card cannot fold, the item greys out
  if (!card) return null;
  const items = [
    { key: "card", checkbox: true, checked: prefs.open, label: t("card.show"), onSelect: () => setChatCardOpen(!prefs.open) },
    { key: "row", checkbox: true, checked: !prefs.rowHidden && cardFoldable(card), disabled: !prefs.open || !cardFoldable(card), label: t("card.showRow"),
      onSelect: () => setChatCardRowHidden(!prefs.rowHidden) },
  ];
  return html`<${Menu} items=${items} label=${t("card.menu")} icon="idcard" cls="chat-card-menu" active=${prefs.open} />`;
}
import "./chat-strings.js";
import { confirmedWrite, selfConfirmed } from "./settings-confirm.js";
import { createChatStore } from "./chat-store.js";
import { createThread, msgKey } from "./chat-thread.js";
import { installMessageActions } from "./chat-msg-actions.js";
import { createEmojiIndex } from "./chat-emojis.js";
import { pollPublicPreview } from "./preview-status.js";
import { createMentionIndex } from "./chat-mentions.js";
import { PreviewPanel, claimPanel, openPanel, panelClaims, panelStore, panelVersion, shownKey } from "./preview-panel.js";
import { needsArgument, paletteFor, parseCommandLine } from "./chat-commands.js";
import { installTour, refreshTourSpot } from "./chat-tour.js";
import { LightboxHost, openLightbox } from "./image-lightbox.js";
import { ChatEffectPosters } from "/ui/js/chat-effect-posters.js";
import { ChatEffects, chatEffectsMenuAvailable } from "./chat-effects.js";
import { setFollowsReducedMotion } from "/assets/fx-motion.js";
import { AmbientMotionNote, ChatAmbient, ambientMenuItems } from "./chat-ambient.js";
import { startEffectsWaker, getAppEffects, wakeEffects, effectsLoaded, onEffectsAwake, chatHasEffects } from "./effects-waker.js";

const R = () => globalThis.AgendChatRender;
const P = () => globalThis.AgendPreview;

/** The page's chat store (boot creates it). Exported for the tests. */
export let store = null;

// ── Announcements: one polite, visually hidden line for the coarse events only (a reply arrived, the agent started,
// finished, or waits on you). Messages themselves are not read out as they arrive; the list is a log to browse.
let announceTimer = null;
/** #1630: which Discord server emoji this page may draw (created with the store, in boot). */
let emojiIndex = null;
let mentionIndex = null;   // #1682: the names of the mentions shown
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
 * running preview. Resolves to the choice in force. commit(apply): runs `apply` (the change itself) — the panel's Allow
 * wraps it to know which change of the choice is its own (#1704).
 */
export async function setPreviewOptIn(on, commit = (apply) => apply()) {
  if (on && !P().optedIn() && !(await confirmDialog({ message: t("chat.pvConfirm"), confirmLabel: t("chat.pvAllowButton") }))) on = false;
  commit(() => P().setOptIn(on));
  // #1665: kept on the host for every device (only a signed-in page writes it; never the public link).
  savePref("preview.optIn", P().optedIn());
  return P().optedIn();
}

/** Once per page, in "full" mode: the store on the app's stream, previews (#1306), the sidebar's chat controls. */
export function boot({ stream, boot: bootData, deps = {} }) {
  if (store) return store;
  store = createChatStore({
    fetch: (...a) => fetch(...a), toast, announce, t, setTimeout: (fn, ms) => setTimeout(fn, ms), confirm: confirmDialog, ...deps,
  });
  emojiIndex = createEmojiIndex((url) => (deps.fetch || fetch)(url, { credentials: "same-origin" }));
  mentionIndex = createMentionIndex((url) => (deps.fetch || fetch)(url, { credentials: "same-origin" }));
  store.attach(stream);
  // #1306: what the server said about previews for this load. The page-wide message and storage listeners this adds
  // belong to the app, once (they are never per mount).
  // #1554: its words in the page's language (chat.pv*); a key the dictionary does not have keeps preview.js's English.
  if (P() && bootData) P().init(bootData, { text: (key, ...v) => { const k = `chat.${key}`, s = t(k, ...v); return s === k ? null : s; } });
  // #1723: the public link's preview was still starting when this page loaded: ask until it is up (or failed).
  if (P() && bootData) pollPublicPreview(P());
  // #1568: the banner's "I understand" lasts until the next sign-in — preview.js is told which sign-in this page is
  // (the session handle, from the one /auth/session read); none (no session, or no AgendAuth): this tab only.
  if (P() && typeof P().setBannerScope === "function") {
    const auth = globalThis.AgendAuth;
    if (auth && typeof auth.sessionHandle === "function") auth.sessionHandle().then((h) => P().setBannerScope(h), () => P().setBannerScope(null));
    else P().setBannerScope(null);
  }
  // #1604: the preview opt-in and Tour live in Settings → This device now (and on each preview card's menu).
  installTour();
  // #2118: viewing current in-scope Chat effects needs no management or personal-slot authority. #2193: the runtime
  // itself loads only when there is something to play (effects-waker.js).
  startEffectsWaker({ store });
  return store;
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

/** #1722: the chat's title — the name that leads, the other on hover. */
const headerName = ({ primary, secondary }) => (secondary ? html`<span title=${secondary}>${primary}</span>` : primary);

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
    // #1854 (rank 7): one instruction — pick an agent, or with none at all, the one way to make one. Connecting a chat
    // app (the first-run card, #1519 P7) is offered in Settings, not here: it competed with the first agent.
    const none = app.ready && !app.instances.length;
    return html`<div class="panel p-chat"><${PanelHeader} title=${t("app.chat")} />
      <div class="panel-body center">
        ${none ? html`<${Empty} icon="bot" title=${t("chat.noAgents")}
          action=${html`<button type="button" class="btn btn-primary" onClick=${requestNewInstance}><${Icon} name="plus" size=${16} />${t("chat.newAgent")}</button>`} />`
        : html`<${Empty} icon="chat" title=${t("chat.pick")}
          action=${html`<button type="button" class="btn only-narrow" onClick=${openDrawer}>${t("chat.backToList")}</button>`} />`}</div></div>`;
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

/**
 * #1629: the mode the page is drawn in, followed live (the chosen theme, or the system's for "system"), so an agent's
 * light and dark palettes swap with it.
 */
function useResolvedMode(lease) {
  const [mode, setMode] = useState(resolvedMode);
  useEffect(() => {
    const T = globalThis.AgendTheme;
    const update = () => setMode(resolvedMode());
    const off = T && typeof T.onChange === "function" ? T.onChange(update) : null;
    let mq = null;
    try { mq = globalThis.matchMedia ? globalThis.matchMedia("(prefers-color-scheme: light)") : null; } catch { mq = null; }
    if (mq && typeof mq.addEventListener === "function") lease.on(mq, "change", update);
    return () => { if (typeof off === "function") off(); };
  }, [lease]);
  return mode;
}

function ChatView({ name, inst, lease, navKey, exec, awaiting }) {
  const names = useStore(namesStore);   // #1722: which name leads (the title)
  // #1629: this agent's theme, on this surface only; redrawn when the themes, the viewer's switch or the mode move.
  useStore(themesStore);
  const mode = useResolvedMode(lease);
  const theme = themeFor(name);
  const themeKey = JSON.stringify(theme);
  const card = useCard(name, inst.card_v);
  const [dialog, setDialog] = useState(null);       // "delete" | null
  const [canvasPlayback, setCanvasPlayback] = useState(null);
  const publishCanvasPlayback = useCallback(value => setCanvasPlayback(previous =>
    !previous && !value.playing || previous?.name === value.name && previous.playing === value.playing ? previous : value), []);
  const [wrap, setWrap] = useState(codeWrap);
  const view = useRef(null), split = useRef(null), thread = useRef(null), bg = useRef(null), effectSurface = useRef(null);
  useLayoutEffect(() => { applyTheme(view.current, theme, mode); }, [themeKey, mode]);
  useLayoutEffect(() => {
    const img = bg.current;
    if (img && img.style && theme && theme.background) img.style.setProperty("--th-bg-opacity", String(theme.background.opacity));
  }, [themeKey]);
  useEffect(() => { wrapListeners.add(setWrap); return () => wrapListeners.delete(setWrap); }, []);
  // First visit to this instance's chat on this page: its history (a navigation — it counts as use). Back again: nothing.
  // #2188: left before it answered (passing through on the way to another chat) — the read is aborted.
  useEffect(() => {
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    store.openHistory(name, lease, ac?.signal);
    return () => ac?.abort();
  }, [name]);
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
    else if (r && r.held) toast(r.message);
    else toast(t(verb === "start" ? "chat.started" : verb === "stop" ? "chat.stoppedInst" : "chat.restarted", name));
  };
  // #2193: this chat's Canvas Worker placements (its status row's effect_chat_v): none, no effects code runs for it.
  const fxHere = chatHasEffects(name);
  const items = [
    // #1523 N2: Details is a page now (the Fleet side of this instance), not a dialog.
    { key: "details", label: t("chat.details"), icon: "info", onSelect: () => navigate(detailsPath(name)) },
    running ? null : { key: "start", label: t("chat.start"), icon: "play", onSelect: () => action("start") },
    running ? { key: "restart", label: t("chat.restart"), icon: "restart", onSelect: () => action("restart") } : null,
    running ? { key: "stop", label: t("chat.stopInstance"), icon: "stop", onSelect: () => action("stop") } : null,
    // #1958: its identity colour and where it shows (the public link too, as profile edits).
    colorMenuItem(name, inst),
    // #1629: a person's control over this agent's theme — not over the public link (it only views themes).
    ...themeMenuItems(name),
    // #2117: its ambient — why it is not showing here (with the way to change that), and a person's Clear.
    ...ambientMenuItems(name, { publicLink: document.body.dataset.publicLink === "1", clear: clearAmbient }),
    chatEffectsMenuAvailable() ? { key: "effects", label: t("chatFx.title"), onSelect: () => setDialog("effects") } : null,
    { key: "delete", label: t("chat.delete"), icon: "trash", danger: true, onSelect: () => setDialog("delete") },
  ];
  const cls = statusClass(inst, exec, awaiting);
  // #1920 phase 3: a guest has this chat only — no Details, View or Log to switch to, no lifecycle, colour, theme,
  // effect management or delete (a guest's status frame carries no model or effort either, so those chips do not show).
  const guest = guestPage();
  // #1269 quick actions: the model and effort it runs, each a way to /model or /effort (the same pick list).
  const pick = (command) => store.runCommand(name, command, "", { alive: () => lease.current() });
  const sub = html`<span class="status"><span class=${`dot ${cls}`} aria-hidden="true"></span>${statusLabel(inst, exec, awaiting)}</span>
    ${inst.model ? html`<button type="button" class="hd-chip" title=${t("chat.chipModel", modelText(inst))} aria-label=${t("chat.chipModel", modelText(inst))} onClick=${() => pick("model")}>${modelText(inst)}</button>` : null}
    ${inst.effort ? html`<button type="button" class="hd-chip" title=${t("chat.chipEffort", inst.effort)} aria-label=${t("chat.chipEffort", inst.effort)} onClick=${() => pick("effort")}>${inst.effort}</button>` : null}`;
  return html`<div class=${`panel p-chat${wrap ? " wrap-code" : ""}`} ref=${view}>
    <${PanelHeader} title=${headerName(namesOf(inst || { name }, names.primary))} sub=${sub} nav=${guest ? null : html`<${InstanceSwitch} name=${name} current="chat" />`} notice=${html`<${ChatEffects} name=${name} lease=${lease} element=${effectSurface} store=${store} open=${dialog === "effects"} onPlayback=${publishCanvasPlayback} onClose=${() => setDialog(null)} active=${fxHere} />`}>${fxHere ? html`<${ChatEffectPosters} name=${name} lease=${lease} element=${effectSurface} />` : null}<${CardMenu} card=${card} /><${HeaderTools} navKey=${navKey} />${guest ? null : html`<${Menu} items=${items} label=${t("app.more")} />`}</${PanelHeader}>
    <${ChatCard} key=${name} name=${name} card=${card} />
    <${AgentWidget} slot="chat_header" widget=${widgetFor(name, "chat_header")} binds=${instanceBinds(inst, exec, awaiting)} />
    <div class="chat-split" ref=${split}>
      <div ref=${effectSurface} class=${`chat-main${theme && theme.background ? " has-th-bg" : ""}`}>
        ${theme && theme.background ? html`<img ref=${bg} class=${`th-bg th-bg-${theme.background.fit}`} src=${themeImageUrl(name, theme.background.image)} alt="" aria-hidden="true" decoding="async" />` : null}
        <${ChatAmbient} name=${name} surface=${effectSurface} part="layer" />
        <${AmbientMotionNote} name=${name} canvasPlaying=${canvasPlayback?.name === name && canvasPlayback.playing} />
        <${Thread} name=${name} th=${thread} />
        <${Dock} name=${name} inst=${inst} lease=${lease} exec=${exec} awaiting=${awaiting} workingLabel=${theme ? theme.workingLabel : undefined} />
        <${ChatAmbient} name=${name} surface=${effectSurface} part="front" />
      </div>
      <${PreviewPanel} name=${name} split=${split} msgs=${() => store.state.msgs[name] || []} subscribe=${(fn) => store.subscribe(fn)}
        keyOf=${msgKey} reveal=${(k) => thread.current && thread.current.reveal(k)} download=${downloadHtml} allow=${(commit) => setPreviewOptIn(true, commit)} />
    </div>
    <${LightboxHost} />
    <div data-trust="drop" class="drop-overlay" aria-hidden="true"><div class="drop-card"><${Icon} name="attach" size=${32} /><span>${t("chat.dropHere")}</span></div></div>
    ${dialog === "delete" ? html`<${DeleteDialog} name=${name} onClose=${() => setDialog(null)} />` : null}
  </div>`;
}

/**
 * #2053: the last THREAD_KEEP chats' threads are kept when their view leaves (the chat view is keyed by instance, so
 * each switch built the thread again: a revisit was no faster than a first visit). A kept thread is its list element
 * and its renderer, and nothing more: it leaves as a chat always did (previews stop), with no subscription or timer
 * left; shown again, one render draws only what changed meanwhile, where the reader was. A new language, another
 * document, or more than the budget lets one go.
 *
 * #2184: the budget (raised for people who switch among ~10 favourites): up to THREAD_KEEP threads on a wide screen and
 * THREAD_KEEP_NARROW on a narrow one (a phone), and THREAD_KEEP_NODES drawn messages in all, so memory stays bounded
 * however long the chats are. Over it, the least recently shown goes first — one that is not a favourite before a
 * favourite; the chat on screen never goes.
 */
export const THREAD_KEEP = 12;
export const THREAD_KEEP_NARROW = 6;
export const THREAD_KEEP_NODES = 2400;
/**
 * #2188: a chat shown for less than this, on the way to another (clicking down the sidebar), is not kept: it is let go
 * as it leaves, so passing through chats never evicts the ones in use. One that was already kept stays kept.
 */
export const THREAD_PASS_MS = 1000;
const monotonic = () => (typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now());
let now = monotonic;
/** Tests only: the clock THREAD_PASS_MS is measured on (null: the page's monotonic clock). */
export function setThreadClock(fn) { now = typeof fn === "function" ? fn : monotonic; }
/**
 * The kept threads to let go, in order. `kept`: [name, drawn messages], least recently shown first; `current`: the
 * one on screen (never let go).
 */
export function threadsToLetGo(kept, current, { keep, maxNodes, favorites }) {
  let count = kept.length, nodes = kept.reduce((n, [, d]) => n + d, 0);
  const out = [];
  const order = [...kept.filter(([n]) => n !== current && !favorites.has(n)), ...kept.filter(([n]) => n !== current && favorites.has(n))];
  for (const [n, d] of order) {
    if (count <= keep && nodes <= maxNodes) break;
    out.push(n); count--; nodes -= d;
  }
  return out;
}
const narrowScreen = () => typeof matchMedia === "function" && matchMedia("(max-width: 899px)").matches;
/** Let go what the budget does not hold (after `current` was shown, or drew more). */
function trimKept(current) {
  const kept = [...keptThreads].map(([n, e]) => [n, e.thread.nodes.size]);
  const favorites = new Set(instanceNavStore.get().favorites);
  for (const n of threadsToLetGo(kept, current, { keep: narrowScreen() ? THREAD_KEEP_NARROW : THREAD_KEEP, maxNodes: THREAD_KEEP_NODES, favorites })) {
    letGo(keptThreads.get(n), true); keptThreads.delete(n);
  }
}
const keptThreads = new Map();                 // name → { thread, list, sink, lang }
/** Tests only: let every kept thread go. */
export function forgetKeptThreads() { for (const e of keptThreads.values()) letGo(e, true); keptThreads.clear(); }
function letGo(e, own) { e.thread.dispose(own); e.list.remove(); }

/** A chat's thread: its own list element and renderer, and a sink for the view that shows it. */
function threadEntry(name, doc) {
  const list = doc.createElement("div");
  list.className = "thread";
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "off");
  list.setAttribute("aria-label", t("chat.conversationWith", name));
  const e = { list, sink: null, lang: lang(), thread: null };
  const thread = createThread(list, doc.createElement("div"), {
    t, tf: t, isUser: (x) => store.isUser(x, name), onJump: (j) => e.sink?.setJump(j), onEmpty: (v) => e.sink?.setEmpty(v),
    setPreviewOptIn, copyText, download: downloadHtml, toggleWrap,
    // #2193: an offer shown while the effects runtime sleeps wakes it; until it answers, the offer is being checked.
    effectTrialStatus: x => { const fx = getAppEffects(); if (fx) return fx.trialStatus(x); if (!effectsLoaded()) { void wakeEffects(); return "checking"; } return "localAdmin"; },
    effectTrialFailure: x => getAppEffects()?.trialFailure(x),
    fixEffectTrial: (x, reason) => {
      if (reason === "reducedMotion") setFollowsReducedMotion(false);
      else if (reason === "busy") getAppEffects()?.stopTrial();
      else if (reason === "transport") location.reload();
      else if (reason === "localAdmin") location.href = "/signin?next=" + encodeURIComponent(location.pathname + location.search);
      else navigate("/settings/appearance");
    },
    canTryEffect: x => getAppEffects()?.canTry(x) === true,
    startEffectTrial: x => { const seq = navStore.get().seq; void getAppEffects()?.startTrial(x).then(ok => { if (!ok && e.sink && navStore.get().seq === seq && document.hasFocus?.() === true && document.visibilityState === "visible") toast(t("chat.effectTrialUnavailable")); }); },
    clickReplyButton: (id, index) => store.clickReplyButton(name, id, index),      // #1266
    // #2272: reply to a message (the bar above the composer), and show the one a reply quotes.
    startReply: (x) => { store.startReply(name, x); doc.getElementById("msgIn")?.focus(); },
    findQuoted: (key) => store.findQuoted(name, key),
    notice: (text) => toast(text, false),
    replyButtonBusy: (id) => store.state.rbBusy.has(id),
    pollMine: (id) => store.state.pollMine[id],                            // #1823: this device's own vote
    serverNow: () => Date.now() + store.state.clockSkew,                   // #1823: the deadline is the server's
    panel: { shown: shownKey, open: (spec, o) => openPanel(spec, o), version: panelVersion, claim: claimPanel, claims: panelClaims },   // #1481, #1704
    openImage: openLightbox,                                               // an image, full size, in the page
    emojis: (id) => !!emojiIndex && emojiIndex.known(id),                  // #1630: the fleet's server emoji
    mentions: (kind, id) => (mentionIndex ? mentionIndex.name(kind, id) : null),   // #1682: mention names
  });
  e.thread = thread;
  return e;
}
/** While a thread is shown: what it follows. Returns what lets it all go. */
function follow(name, thread) {
  // #1630: the server-emoji list is read once a message shows a tag; when it arrives, those messages are drawn again.
  // #1682: the same for mention names — asked for the ids the messages carry; when names arrive, drawn again.
  const wantEmojis = (msgs) => { if (emojiIndex && emojiIndex.wants(msgs)) emojiIndex.ensure(); if (mentionIndex) mentionIndex.ensure(msgs); };
  const offs = [];
  if (emojiIndex) offs.push(emojiIndex.subscribe(() => thread.render(store.state.msgs[name] || [])));
  if (mentionIndex) offs.push(mentionIndex.subscribe(() => thread.render(store.state.msgs[name] || [])));
  wantEmojis(store.state.msgs[name]);
  offs.push(store.subscribe((instance, kind) => {
    if (instance !== name) return;
    if (kind === "msgs") { thread.render(store.state.msgs[name] || []); wantEmojis(store.state.msgs[name]); }
    else if (kind === "sent") thread.jumpLatest();
  }));
  offs.push(P() ? P().onChange(() => thread.refreshCards()) : () => {});
  // #2193: the runtime may start later (an offer shown wakes it): its trial updates are followed from then.
  let trialOff = null;
  const watchTrial = () => { trialOff = getAppEffects()?.subscribeTrial(() => thread.render(store.state.msgs[name] || [])) ?? null; };
  watchTrial();
  if (!trialOff) offs.push(onEffectsAwake(() => { watchTrial(); thread.render(store.state.msgs[name] || []); }));
  offs.push(() => trialOff?.());
  offs.push(panelStore.subscribe(() => thread.refreshCards()));   // a card shows whether the panel has its block
  return () => { for (const off of offs) off(); };
}

/** The thread's view: Preact owns the scroller and the jump pill; the kept list (chat-thread.js) is put inside it. */
function Thread({ name, th }) {
  const scroller = useRef(null), host = useRef(null);
  const [jump, setJump] = useState({ show: false, unseen: 0 });
  const [empty, setEmpty] = useState(false);
  useLayoutEffect(() => {
    const doc = host.current.ownerDocument;
    let e = keptThreads.get(name);
    // Kept only while it can be shown as it is: the same language, and this page's own document.
    if (e && (e.lang !== lang() || e.list.ownerDocument !== doc)) { letGo(e, true); keptThreads.delete(name); e = undefined; }
    const kept = !!e;
    if (e) keptThreads.delete(name);
    else e = threadEntry(name, doc);
    keptThreads.set(name, e);                                              // the most recent last
    // A thread already kept is trimmed against at once; a new one first has to stay (see THREAD_PASS_MS).
    if (kept) trimKept(name);
    const shownAt = now();
    const thread = e.thread, sc = scroller.current, ls = e.list;
    e.sink = { setJump, setEmpty };
    host.current.append(ls);
    thread.attach(sc);
    th.current = thread;
    // Up to date, at the reader's place (the bottom unless they had scrolled up); a kept one's cards say what they can do.
    thread.render(store.state.msgs[name] || [], { restore: store.state.scrollMemo[name] ?? null });
    if (kept) thread.refreshCards();
    const unfollow = follow(name, thread);
    const onScroll = () => { store.state.scrollMemo[name] = thread.onScroll(); };
    sc.addEventListener("scroll", onScroll, { passive: true });
    ls.addEventListener("click", thread.onClick);
    // #2272: the message menu, swipe left / long-press on a phone, R on a focused message.
    const offActions = installMessageActions(ls, {
      t, messageOf: thread.messageOf, rove: thread.rove, reply: (x) => { store.startReply(name, x); document.getElementById("msgIn")?.focus(); },
      copyText, notice: (text, ok = true) => toast(text, ok),
      linkOf: (x) => `${location.origin}/ui/chat/${encodeURIComponent(name)}#m=${msgKey(x)}`,
    });
    // A copied message link (#m=<boot>-<id>): show that message, flashed.
    const linked = /^#m=([0-9a-f]{1,32}-\d{1,15})$/.exec(location.hash);
    if (linked) void thread.jumpTo(linked[1]);
    // #2293: search opening a message of this chat while it is shown — the address's #m= changes, the route does not.
    // Only this chat's address: during a jump to another chat this one is still mounted for a moment.
    const onHash = () => {
      const m = /^#m=([0-9a-f]{1,32}-\d{1,15})$/.exec(location.hash);
      if (m && location.pathname === `/ui/chat/${encodeURIComponent(name)}`) void thread.jumpTo(m[1]);
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      unfollow();
      offActions();
      sc.removeEventListener("scroll", onScroll);
      ls.removeEventListener("click", thread.onClick);
      e.sink = null;
      th.current = null;
      // Passed through (new, and shown under THREAD_PASS_MS): let go. Otherwise kept for a later visit, within the budget.
      if (keptThreads.get(name) === e && !kept && now() - shownAt < THREAD_PASS_MS) { keptThreads.delete(name); letGo(e, false); }
      else if (keptThreads.get(name) === e) { thread.park(); ls.remove(); trimKept(null); }   // kept for a later visit: the chat left
      else letGo(e, false);                                                // let go meanwhile (a new language)
    };
  }, [name]);
  return html`<div class="scroller" ref=${scroller}>
    <div class="thread-host" ref=${host}></div>
    ${empty ? html`<${Empty} icon="chat" title=${t("chat.noMessages")} />` : null}
    <div class="jump-dock">${jump.show ? html`<button data-trust="thread-control" type="button" class="jump-latest" onClick=${() => th.current && th.current.jumpLatest()}>
      <${Icon} name="down" size=${16} />${jump.unseen > 0 ? t("chat.newBelow", jump.unseen) : t("chat.jumpLatest")}</button>` : null}</div>
  </div>`;
}

/** Everything under the thread: prompts, the working line, a failed send, files waiting, and the composer. */
function Dock({ name, inst, lease, exec, awaiting, workingLabel }) {
  useChatTick(name, ["state"]);
  const s = store.state;
  return html`<div data-trust="composer" class="dock"><div class="dock-col">
    <${Prompts} name=${name} />
    <${WorkBar} name=${name} lease=${lease} exec=${exec} awaiting=${awaiting} workingLabel=${workingLabel} />
    <${CommandCard} name=${name} lease=${lease} />
    <${QuickActions} name=${name} inst=${inst} lease=${lease} />
    ${s.failedSends[name] ? html`<div class="failed-send" role="alert"><span>${t("chat.notSent")}</span><span class="txt">${s.failedSends[name]}</span>
      <button type="button" class="btn btn-primary btn-sm" onClick=${() => store.putBack(name)}>${t("chat.putBack")}</button>
      <button type="button" class="btn btn-sm" onClick=${() => store.discardFailed(name)}>${t("chat.discard")}</button></div>` : null}
    ${s.waking[name] ? html`<p class="send-waking" role="status">${t("chat.waking", name)}</p>` : null}
    ${s.sendFailures[name] ? html`<div class="failed-send send-failure" role="alert"><span>${s.sendFailures[name].error}</span>
      <button type="button" class="btn btn-sm" disabled=${!store.canRetrySend(name)} onClick=${() => store.retrySend(name)}>${t("chat.retrySend")}</button></div>` : null}
    <${Composer} name=${name} lease=${lease} busy=${R().isBusy(exec)} />
    <div class="composer-row">${guestPage() ? html`<span class="guest-note" title=${t("chat.guestNote")}>${t("chat.guestNote")}</span>` : html`<${ComposerAuth} />`}<span
      class="hint" title=${t(guestPage() ? "chat.guestMore" : "chat.composerMore")}>${t("chat.composerHint")}</span></div>
  </div></div>`;
}

/** #2233: the public link's page — the dashboard's Sign in is refused there, so it is never offered (#2262 review). */
const publicLinkPage = () => typeof document !== "undefined" && !!document.body && document.body.dataset.publicLink === "1";
/** #2233: a backend's "not signed in" choice offers Sign in (the module behind the session gate, loaded when asked). */
function openBackendSignIn(backend) {
  import("./backend-signin.js").then((m) => m.openSignIn({ backend }), () => toast(t("app.loadFailed"), false));
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
    ${c.compact ? html`<p class="cmd-text cmd-phase">${c.compact === "running" ? t("chat.compactRunning")
      : c.compact === "done" ? t("chat.compactDone") : c.compact === "timeout" ? t("chat.compactTimeout", "10")
      : c.compact === "lost" ? t("chat.compactLost") : c.compact === "not_compacted" ? t("chat.compactNotCompacted") : t("chat.compactUnknown")}</p>` : null}
    ${c.choices && c.choices.prompt ? html`<pre class="cmd-text">${c.choices.prompt}</pre>` : null}
    ${c.choices ? html`<div class="cmd-choices" role="group" aria-label=${t("chat.cmdChoose")}>${c.choices.options.map((o) => html`<button key=${o.id} type="button"
      class=${`btn btn-sm${o.id === c.choices.current ? " current" : ""}`} aria-current=${o.id === c.choices.current ? "true" : undefined}
      disabled=${!!o.disabled} title=${o.disabled || undefined} onClick=${() => { if (!o.disabled) run(o.id); }}>${o.label}</button>`)}</div>` : null}
    ${c.choices && c.choices.options.some((o) => o.signIn) && !publicLinkPage() ? html`<div class="cmd-choices" role="group" aria-label=${t("chat.cmdSignIn")}>${c.choices.options.filter((o) => o.signIn).map((o) => html`<button
      key=${`signin:${o.signIn}`} type="button" class="btn btn-sm btn-primary" onClick=${() => openBackendSignIn(o.signIn)}>${t("chat.cmdSignInTo", o.signIn)}</button>`)}</div>` : null}
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
  return html`<div data-trust="permission" class="prompts" aria-live="polite">${list.map(p => html`<div key=${p.nonce} class=${`prompt${p.resolved ? " done" : ""}`} role="group" aria-label=${p.text}>
    <div class="txt">${p.resolved ? (p.outcome || t("chat.promptGone")) : textLinkSegments(p.text, p.links).map(sg => sg.href ? html`<a data-trust="link" class="st-link" href=${sg.href}>${sg.text}</a>` : sg.text)}</div>
    ${p.resolved ? null : html`<div class="acts">${p.actions.map(a => html`<button key=${a.id} type="button" class="btn" disabled=${!!p.busy} onClick=${() => store.answerPrompt(p, a.id)}>${a.label}</button>`)}
      ${p.busy ? html`<span class="wait">${t("chat.promptAnswering")}</span>` : null}</div>`}</div>`)}</div>`;
}

/** "<name> is working… 0:42", "looks stuck", "Stopping…", or what it waits on at its terminal. Text only. */
function WorkBar({ name, lease, exec, awaiting, workingLabel }) {
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
  // #1629: the agent's own working label (its theme), shown as text — only for "working", never for the other states.
  const label = kind === "working" && workingLabel ? workingLabel
    : t(kind === "stuck" ? "chat.stuck" : kind === "stopping" ? "chat.stopping" : kind === "awaiting" ? "chat.awaiting" : "chat.working", name);
  const since = s.workingSince[name];
  return html`<div class=${`work-bar ${kind}`}><span class="pulse" aria-hidden="true"></span><span class="lbl">${label}</span>
    ${kind === "awaiting" ? html`<span class="note" title=${t("chat.approxNote")}>${awaiting || t("chat.approxNote")}</span>`
      : html`<span class="elapsed" title=${t("chat.elapsedTitle")} aria-hidden="true">${since == null ? "" : R().formatElapsed(performance.now() - since)}</span>`}</div>`;
}

/** #2272: the reply bar's quote — the first ~80 characters, or what it had instead of text. */
function replySnippet(r) {
  const text = r.text ? (r.text.length > 80 ? `${r.text.slice(0, 79).trimEnd()}…` : r.text) : "";
  return text || (r.media === "photo" ? t("chat.replyPhoto") : r.media === "document" ? t("chat.replyFile") : "");
}

function Composer({ name, lease, busy }) {
  const s = store.state;
  const input = useRef(null), fileIn = useRef(null);
  const [, tick] = useState(0);
  const [sel, setSel] = useState(0);
  const [closedFor, setClosedFor] = useState(null);    // the draft the palette was closed on (Esc); it opens again on change
  const value = s.drafts[name] || "";
  const files = s.pendingFiles[name] || [];
  const reply = s.replies[name];                       // #2272: the message this one will reply to
  const content = !!value.trim() || files.length > 0;
  // A file waiting: what goes is a message with its file, never a command (no palette, no command line). A guest never
  // runs one (#1920: the server refuses its slash text), so it has no palette either.
  const guest = guestPage();
  const palette = guest || files.length || closedFor === value ? null : paletteFor(value);
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
    // #1920: a guest's "/…" would be refused as a command — said here, the draft kept to edit.
    if (guest && /^\s*\//.test(value)) { toast(t("chat.guestNoCommands"), false); return; }
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
    if (reply && e.key === "Escape" && !e.isComposing) { e.preventDefault(); store.clearReply(name); return; }   // #2272
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
    ${palette ? html`<ul data-trust="palette" class="cmd-palette" id="cmdPalette" role="listbox" aria-label=${t("chat.cmdCommands")}>
      ${palette.length ? palette.map((c) => html`<li key=${c.name} id=${optId(c)} role="option" aria-selected=${c === pick ? "true" : "false"}
          class=${c === pick ? "on" : ""} onMouseDown=${(e) => { e.preventDefault(); complete(c); }}>
          <span class="cmd-name mono">/${c.name}${c.arg ? html` <span class="cmd-arg">${c.arg}</span>` : null}</span><span class="cmd-desc">${t(`chat.cmd_${c.name}`)}</span></li>`)
        : html`<li class="cmd-none" role="option" aria-selected="false">${t("chat.cmdNotCommand")}</li>`}
    </ul>` : null}
    ${reply ? html`<div class="reply-bar" data-trust="composer" role="status">
      <span class="reply-mark" aria-hidden="true"><svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg></span><span class="reply-label">${t("chat.replyingTo", reply.sender)}</span>
      <span class="reply-text">${replySnippet(reply)}</span>
      <button type="button" class="icon-btn reply-cancel" title=${t("chat.replyCancel")} aria-label=${t("chat.replyCancel")} onClick=${() => { store.clearReply(name); input.current?.focus(); }}><${Icon} name="close" size=${14} /></button>
    </div>` : null}
    ${files.length ? html`<div class="pending-files">${files.map((f, i) => html`<${FileChip} key=${`${f.name}-${i}`} f=${f} i=${i} name=${name} />`)}</div>` : null}
    <div class="composer">
      <button id="attachBtn" type="button" class="icon-btn" title=${t("chat.attachTitle")} aria-label=${t("chat.attachTitle")} onClick=${() => fileIn.current && fileIn.current.click()}><${Icon} name="attach" /></button>
      <input ref=${fileIn} type="file" multiple hidden
        onChange=${(e) => { store.addFiles(name, e.target.files); e.target.value = ""; }} />
      <textarea id="msgIn" ref=${input} rows="1" value=${value} placeholder=${t("chat.composerPlaceholder", name)} aria-label=${t("chat.composerPlaceholder", name)}
        autocomplete="off" aria-controls=${palette ? "cmdPalette" : undefined} aria-expanded=${palette ? "true" : "false"}
        aria-activedescendant=${pick ? optId(pick) : undefined} onInput=${onInput} onKeyDown=${onKeyDown} onPaste=${onPaste}></textarea>
      <button id="stopBtn" type="button" class="btn btn-stop" hidden=${!busy} title=${t("chat.stopReplyTitle")}
        disabled=${!!s.cancelling[name]} onClick=${() => store.cancelReply(name)}><${Icon} name="stop" size=${14} /><span class="stop-label">${t("chat.stopReply")}</span></button>
      <button id="sendBtn" type="button" class="btn btn-primary btn-send" hidden=${busy && !content} disabled=${!content || !!s.sending[name]}
        onMouseDown=${(e) => e.preventDefault()}
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
        onPending: (_id, view) => { handedOver = true; toast(t(selfConfirmed(view) ? "app.pendingSelfSent" : "app.pendingSent")); if (lease.current()) { setBusy(false); onClose(); } } });
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
      <input type="text" value=${typed} autocomplete="off" spellcheck=${false} placeholder=${want} onInput=${(e) => setTyped(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Enter") go(); }} /></label>
  </${Dialog}>`;
}
