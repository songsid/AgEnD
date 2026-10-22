// #1408 §5: the web chat's state, for the life of the page — every instance's messages, drafts, files waiting to go,
// failed sends, prompts and turn state. It is fed by the app's one stream from the first frame, whatever panel is on
// screen, so leaving the chat and coming back loses nothing (draft, scroll, files) and re-reads nothing.
//
// What it does is what the dashboard did (#1307, #1306, #1313, #1316, #1317); only where it lives changed. No DOM:
// the chat panel renders it; tests drive it directly.
//
// Requests and #1374: the history of an instance is read once per page, when a person first opens its chat (a
// navigation — it counts as use, as the old click did). Coming back to it reads nothing; the stream keeps it current.
import "./chat-render.js";
import { createLiveAgentReplies } from "./chat-live-replies.js";

const R = () => globalThis.AgendChatRender;

// #1823: this device's own votes on polls (set id → options), so a reload still marks them. A convenience only: the
// server holds the ballot; storage may be missing or throw (private window), and then marks last for the page.
const POLL_MINE_KEY = "agend_poll_mine";
const POLL_MINE_MAX = 50;
function readPollMine() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(POLL_MINE_KEY) || "{}");
    const out = {};
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [id, opts] of Object.entries(v)) if (/^[0-9a-f]{32}$/.test(id) && Array.isArray(opts)) out[id] = opts.filter(Number.isInteger);
    }
    return out;
  } catch { return {}; }
}
function writePollMine(mine) {
  const ids = Object.keys(mine);
  for (const id of ids.slice(0, Math.max(0, ids.length - POLL_MINE_MAX))) delete mine[id];   // the oldest go first
  try { globalThis.localStorage?.setItem(POLL_MINE_KEY, JSON.stringify(mine)); } catch { /* storage unavailable */ }
}

/** Board 003648ac: an answer the server marks `sent` (handed over, and its text says only that) leaves after this. */
const SENT_CLEAR_MS = 8000;
const COMPACT_DONE_CLEAR_MS = 6000;
const COMPACT_UNKNOWN_CLEAR_MS = 12000;
/** The fleet stops following a /compact after 10 minutes (compact-watch.ts); the page waits a minute more. */
const COMPACT_PAGE_LIMIT_MS = 11 * 60_000;

/** Build a store. `deps` (fetch, toast, announce, t, now) are injected so tests can drive every path. */
export function createChatStore(deps) {
  const s = {
    msgs: {}, drafts: {}, replies: {}, pendingFiles: {}, sending: {}, outgoing: {}, instanceStatus: {}, waking: {},
    prompts: {}, workingSince: {}, stopping: {}, cancelling: {}, scrollMemo: {}, historyRead: new Set(), rbBusy: new Set(),
    pollMine: readPollMine(),
    // #1823 (#1828 review): the server's clock minus this device's. A poll's deadline is the server's; a page whose clock
    // is a few seconds off would count a 10 s poll wrong. Only the server's explicit `clock` sets it (#1830 review): a
    // view's rev is when it was made, and a polled or replayed view can be minutes old.
    clockSkew: 0,
    exec: {}, awaiting: {}, current: null,
    // #1269: the last chat command per instance — { command, busy, text?, error?, choices? } — shown above the composer.
    commands: {},
  };
  const subs = new Set();
  const pastedTexts = new WeakMap();
  const now = deps.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const t = deps.t, tf = deps.t;
  const liveReplies = createLiveAgentReplies(now);

  /** Tell subscribers what changed: `kind` "msgs" (the thread redraws) or "state" (everything else). */
  function changed(instance, kind = "state") { for (const fn of [...subs]) fn(instance, kind); }
  async function api(method, path, body, signal) {
    const o = { method, headers: { "Content-Type": "application/json" } };
    if (body) o.body = JSON.stringify(body);
    if (signal) o.signal = signal;
    const r = await deps.fetch(path, o);
    return r.json();
  }
  const isUser = (x, instance) => x.sender === "web-user" || (!x.sender.startsWith("agend") && x.sender !== instance && x.sender !== "general");

  // ── The turn (#1307): when this page saw the agent start working (its own monotonic clock, so approximate), a Stop
  // on its way, and an instance waiting on a terminal prompt.
  function noteExec(name, state) {
    const was = R().isBusy(s.exec[name]), busy = R().isBusy(state);
    const known = Object.prototype.hasOwnProperty.call(s.exec, name);
    s.exec[name] = state;
    if (busy && !was) s.workingSince[name] = now();
    if (!busy) { delete s.workingSince[name]; delete s.stopping[name]; }
    if (known && name === s.current && busy !== was) deps.announce(tf(busy ? "chat.a11yWorking" : "chat.a11yIdle", name));
  }
  function applyStatus(d) {
    if (!d || !Array.isArray(d.instances)) return;
    for (const i of d.instances) {
      s.instanceStatus[i.name] = i.status;
      noteExec(i.name, (i.execution_state !== undefined ? i.execution_state : i.state) ?? null);
      const waits = i.state === "awaiting_input" ? (typeof i.interaction_summary === "string" ? i.interaction_summary : "") : null;
      if (i.name === s.current && waits != null && s.awaiting[i.name] == null) deps.announce(tf("chat.awaiting", i.name));
      s.awaiting[i.name] = waits;
      if (i.compact) noteCompact(i.name, i.compact);
    }
    changed(null);
  }
  function applyActivity(d) {
    if (!d || typeof d.instance !== "string") return;
    noteExec(d.instance, d.state ?? null);
    changed(d.instance);
  }

  // ── Messages: one way in, from the stream, a poll or the history; one entry per boot+id.
  /** #1823: the server's clock, `clock` from the stream or a poll answer — handed over as soon as it is read. */
  function noteServerClock(c) {
    if (c && typeof c.now === "number" && Number.isFinite(c.now)) s.clockSkew = c.now - Date.now();
  }
  function ingest(m, extra) {
    if (!m || typeof m.instance !== "string") return;
    liveReplies.message(m, extra);
    const before = s.msgs[m.instance];
    s.msgs[m.instance] = R().mergeMessages(before, [m], 500);
    // The live copy of a message this page sent carries its clientId: its pending bubble goes in this same redraw.
    if (settleOutgoing(m.instance, m.role === "user" ? m.clientId : undefined) && s.msgs[m.instance] === before) changed(m.instance, "msgs");
    if (m.instance === s.current && s.msgs[m.instance] !== before && m.role !== "status" && !isUser(m, m.instance) && (s.msgs[m.instance] || []).length > (before || []).length) deps.announce(tf("chat.a11yReplied", m.sender));
    if (s.msgs[m.instance] !== before) changed(m.instance, "msgs");
  }
  function applyDeliveries(list) {
    if (!Array.isArray(list)) return;
    const touched = new Set();
    for (const d of list) {
      if (!d || typeof d.instance !== "string") continue;
      const before = s.msgs[d.instance];
      s.msgs[d.instance] = R().applyDelivery(before, d.messageId, d.delivery);
      if (s.msgs[d.instance] !== before) touched.add(d.instance);
    }
    for (const i of touched) changed(i, "msgs");
  }
  /** #1266: a reply's buttons ended — its message shows it. */
  function applyReplyButtons(u) {
    if (!u || typeof u.instance !== "string") return;
    const before = s.msgs[u.instance];
    s.msgs[u.instance] = R().applyReplyButtons(before, u.buttons);
    if (s.msgs[u.instance] !== before) changed(u.instance, "msgs");
  }
  /** #2305: the instance reacted to a message — its bubble shows it. */
  function applyReactions(u) {
    if (!u || typeof u.instance !== "string" || typeof u.boot !== "string" || typeof u.id !== "number") return;
    const before = s.msgs[u.instance];
    s.msgs[u.instance] = R().applyReactions(before, u.boot, u.id, u.reactions);
    if (s.msgs[u.instance] !== before) changed(u.instance, "msgs");
  }
  /**
   * #1266: click one of a reply's buttons (the first click anywhere answers for everyone). On a poll (#1823) it is this
   * session's vote: the answer is its ballot, which only this page marks.
   */
  async function clickReplyButton(instance, id, index) {
    if (s.rbBusy.has(id)) return;
    s.rbBusy.add(id); changed(instance, "msgs");
    let r;
    try { r = await api("POST", "/ui/reply-button", { instance, id, index }); }
    catch (err) { r = { error: err && err.message ? err.message : t("chat.disconnected") }; }
    if (r && r.answered && Array.isArray(r.options)) { s.pollMine[id] = r.options.filter(Number.isInteger); writePollMine(s.pollMine); }
    s.rbBusy.delete(id); changed(instance, "msgs");
    if (!r || !r.answered) deps.toast(r && r.error ? r.error : t("chat.disconnected"), false);
  }

  /**
   * Read an instance's history once per page (the first time a person opens its chat). #2188: `signal` — the chat was
   * left before the answer came (clicking down the sidebar): the read is aborted, nothing is merged, and the next visit
   * reads again.
   */
  async function openHistory(name, lease, signal) {
    if (s.historyRead.has(name) || signal?.aborted) return false;
    s.historyRead.add(name);
    try {
      const r = await api("GET", `/ui/history?instance=${encodeURIComponent(name)}&limit=200`, undefined, signal);
      if (signal?.aborted) { s.historyRead.delete(name); return false; }
      if (!r || !Array.isArray(r.messages)) { s.historyRead.delete(name); return true; }
      // Kept even when the person has moved on: the store is page-lived, and the answer belongs to `name`.
      for (const m of r.messages) liveReplies.message(m);
      s.msgs[name] = R().mergeMessages(s.msgs[name], r.messages, 500);
      settleOutgoing(name);
      changed(name, "msgs");
    } catch { s.historyRead.delete(name); /* the live stream still works; the next visit tries again */ }
    void lease;
    return true;
  }

  // ── Prompts the fleet has open (hang / clean exit / interactive input): the same buttons the platform shows.
  function onPrompt(p) {
    if (!p || typeof p.nonce !== "string") return;
    const had = s.prompts[p.nonce];
    const fresh = !had;
    // A prompt already held (being answered, or claimed from Needs you) keeps its busy/answered state: a repeat of it
    // only refreshes its text and buttons (#1463 review).
    if (!had) s.prompts[p.nonce] = { ...p, resolved: false, busy: false };
    else if (!had.resolved) Object.assign(had, { text: p.text, links: p.links, actions: p.actions, expiresAt: p.expiresAt });
    if (p.instance === s.current) changed(p.instance);
    else if (fresh) deps.toast(tf("chat.promptFor", p.instance, p.text), false);
  }
  /** The open prompts, on every stream (re)connect and with every poll: a prompt answered or expired while this page
   *  was not listening is caught up here, and no timer ever re-reads anything. */
  function applyPrompts(list) {
    if (!Array.isArray(list)) return;
    const open = new Set(list.map(p => p.nonce));
    for (const p of list) {
      const had = s.prompts[p.nonce];
      if (!had) s.prompts[p.nonce] = { ...p, resolved: false, busy: false };
      else if (!had.resolved) Object.assign(had, { text: p.text, links: p.links, actions: p.actions, expiresAt: p.expiresAt });
    }
    for (const n of Object.keys(s.prompts)) if (!s.prompts[n].resolved && !open.has(n)) s.prompts[n].resolved = true;
    changed(null);
  }
  function resolvePrompt(d) {
    const p = d && s.prompts[d.nonce];
    if (!p) return;
    p.resolved = true; p.busy = false;
    if (d.outcome) p.outcome = d.outcome;
    deps.setTimeout(() => { if (s.prompts[d.nonce] === p) { delete s.prompts[d.nonce]; changed(p.instance); } }, 60000);
    changed(p.instance);
  }
  async function answerPrompt(p, action) {
    if (p.busy || p.resolved) return;
    p.busy = true; changed(p.instance);
    let r;
    try { r = await api("POST", "/ui/prompt", { instance: p.instance, nonce: p.nonce, action }); }
    catch (err) { r = { error: err && err.message ? err.message : t("chat.disconnected") }; }
    if (r && r.answered) return;   // the outcome arrives as prompt_resolved
    const latest = s.prompts[p.nonce];
    for (const q of latest && latest !== p ? [p, latest] : [p]) { q.busy = false; if (r && r.gone) q.resolved = true; }
    changed(p.instance);
    deps.toast(r && r.error ? r.error : t("chat.disconnected"), false);
  }
  /**
   * Answer a prompt known only by its nonce (Needs you, #1386): the page's one claim on it. A prompt this store does not
   * hold yet is entered now, busy, so the chat, a second click and a later hydration all see the same claim; the next
   * prompts list or prompt_resolved settles it, as for any prompt.
   */
  function answerByNonce(item, action) {
    if (!item || typeof item.nonce !== "string") return Promise.resolve();
    let p = s.prompts[item.nonce];
    if (!p) p = s.prompts[item.nonce] = { instance: item.instance, nonce: item.nonce, text: item.text || item.detail || "", actions: item.actions || [], resolved: false, busy: false };
    return answerPrompt(p, action);
  }
  /** A claim taken elsewhere before this store existed (Needs you, before Chat booted): held here from now on. */
  function holdPrompt(item) {
    if (!item || typeof item.nonce !== "string") return;
    let p = s.prompts[item.nonce];
    if (!p) p = s.prompts[item.nonce] = { instance: item.instance, nonce: item.nonce, text: item.text || item.detail || "", actions: item.actions || [], resolved: false, busy: false };
    if (!p.resolved) { p.busy = true; changed(p.instance); }
  }
  /** That claim's answer was refused: the prompt can be answered again (unless it was settled meanwhile). */
  function releasePrompt(nonce) {
    const p = s.prompts[nonce];
    if (p && !p.resolved) { p.busy = false; changed(p.instance); }
  }
  const promptsFor = (instance) => Object.values(s.prompts).filter(p => p.instance === instance);

  // ── Sending (Discord-like, the user's request): a message shows at once as its own bubble, dimmed while it goes; its
  // files show their upload progress. The server's copy replaces it when it arrives — matched by the page's clientId
  // (on the live copy) or the messageId the send answered with — so it is never shown twice. A send that fails stays,
  // marked, with Retry and Delete: nothing is lost, and nothing is put back into the composer behind the person's back.
  // Sends of one chat go out in order, one at a time; a later one waits behind an earlier one still going.
  let outSeq = 0;
  const objectUrl = (f) => { try { return globalThis.URL && typeof URL.createObjectURL === "function" && /^image\/(png|jpeg|gif|webp)$/.test(f.type || "") ? URL.createObjectURL(f) : null; } catch { return null; } };
  const freeUrl = (u) => { try { if (u) URL.revokeObjectURL(u); } catch { /* gone */ } };
  const newClientId = () => {
    const bytes = new Uint8Array(12);
    try { globalThis.crypto.getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
    return "c" + [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  /** Pending bubbles the server's copy now stands for go (their previews freed). Returns whether any went. */
  function settleOutgoing(name, clientId) {
    const list = s.outgoing[name];
    if (!list || !list.length) return false;
    const ids = new Set((s.msgs[name] || []).map((m) => m.messageId).filter(Boolean)), clients = new Set(clientId ? [clientId] : []);
    const kept = list.filter((e) => !((e.messageId && ids.has(e.messageId)) || clients.has(e.clientId)));
    if (kept.length === list.length) return false;
    for (const e of list) if (!kept.includes(e)) for (const f of e.files) freeUrl(f.url);
    s.outgoing[name] = kept;
    return true;
  }
  /** The thread as drawn: the server's messages, then this page's pending ones. */
  function threadRows(name) {
    const out = s.outgoing[name];
    return out && out.length ? (s.msgs[name] || []).concat(out) : (s.msgs[name] || []);
  }
  /** Upload one file, its progress told as it goes (XHR: fetch cannot report an upload's progress). */
  async function uploadFile(target, file, onProgress) {
    const url = `/ui/upload?instance=${encodeURIComponent(target)}`;
    const X = deps.XMLHttpRequest;
    if (!X) {                                                            // no XHR given (a test): the whole file at once
      const r = await deps.fetch(url, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-Agend-Filename": encodeURIComponent(file.name || "file") }, body: file });
      let body = {};
      try { body = await r.json(); } catch { /* not JSON */ }
      if (!r.ok || !body || typeof body.id !== "string") throw new Error(body && body.error ? `${file.name}: ${body.error}` : `${file.name}: upload failed (${r.status})`);
      onProgress?.(file.size || 0, file.size || 0);
      return body;
    }
    // The CSRF header the page's fetch adds (agend-auth.js), added here too; a 401 ends the session as fetch's would.
    const csrf = globalThis.AgendAuth && typeof globalThis.AgendAuth.csrf === "function" ? await globalThis.AgendAuth.csrf().catch(() => null) : null;
    return new Promise((resolve, reject) => {
      const xhr = new X();
      xhr.open("POST", url);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-Agend-Filename", encodeURIComponent(file.name || "file"));
      if (csrf) xhr.setRequestHeader("X-Agend-CSRF", csrf);
      if (xhr.upload && onProgress) xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded, ev.total); };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* not JSON */ }
        if (xhr.status === 401) globalThis.AgendAuth?.unauthorized?.();
        if (xhr.status >= 200 && xhr.status < 300 && body && typeof body.id === "string") resolve(body);
        else reject(new Error(body && body.error ? `${file.name}: ${body.error}` : `${file.name}: upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error(`${file.name}: ${t("chat.uploadNoConnection")}`));
      xhr.onabort = () => reject(new Error(`${file.name}: ${t("chat.uploadNoConnection")}`));
      xhr.send(file);
    });
  }
  /** Send what the composer holds: its bubble at once, then out in this chat's order. */
  function send(target) {
    const txt = (s.drafts[target] || "").trim();
    const files = (s.pendingFiles[target] || []).slice();
    if ((!txt && !files.length) || !target) return;
    const quote = s.replies[target];
    const e = {
      // "You" until the server's copy (with the person's name) replaces it: no request is made for a name.
      boot: "out", id: ++outSeq, instance: target, role: "user", sender: t("chat.you"), text: txt,
      ts: new Date().toISOString(), clientId: newClientId(), replyTo: quote ? { boot: quote.boot, id: quote.id, sender: quote.sender, text: quote.text, media: quote.media } : undefined,
      quote, outgoing: { state: "queued" },
      files: files.map((f) => ({ file: f, name: f.name || "file", size: f.size || 0, type: f.type || "", url: objectUrl(f), loaded: 0, total: f.size || 0, state: "waiting", id: null })),
    };
    (s.outgoing[target] = s.outgoing[target] || []).push(e);
    s.drafts[target] = "";
    s.pendingFiles[target] = [];
    if (quote) delete s.replies[target];
    changed(target, "msgs");
    changed(target);
    changed(target, "sent");          // your own message: the thread goes to the bottom
    return pump(target);
  }
  /** Take this chat's waiting sends, one after another. */
  async function pump(target) {
    if (s.sending[target]) return;
    s.sending[target] = true;
    try {
      for (let e = nextQueued(target); e; e = nextQueued(target)) await deliver(target, e);
    } finally { s.sending[target] = false; delete s.waking[target]; changed(target); }
  }
  const nextQueued = (target) => (s.outgoing[target] || []).find((x) => x.outgoing.state === "queued");
  /** One send: its files (each with its own progress), then the message. */
  async function deliver(target, e) {
    e.outgoing = { state: "sending" };
    s.waking[target] = s.instanceStatus[target] === "paused";
    changed(target, "msgs"); changed(target);
    let r;
    try {
      for (const f of e.files) {
        if (f.id) continue;                                              // uploaded by an earlier try
        f.state = "uploading"; f.loaded = 0; changed(target, "progress");
        let last = 0;
        const body = await uploadFile(target, f.file, (loaded, total) => {
          f.loaded = loaded; f.total = total || f.total;
          const at = deps.now ? deps.now() : Date.now();
          if (at - last > 60 || loaded >= f.total) { last = at; changed(target, "progress"); }
        });
        f.id = body.id; f.state = "done"; f.loaded = f.total; changed(target, "progress");
      }
      const body = { instance: target, message: e.text, clientId: e.clientId };
      const ids = e.files.map((f) => f.id);
      if (ids.length) body.attachments = ids;
      if (e.quote) body.replyTo = { boot: e.quote.boot, id: e.quote.id };
      r = await api("POST", "/ui/send", body);
    } catch (err) {
      const f = e.files.find((x) => x.state === "uploading");
      if (f) f.state = "failed";
      // The browser's own words for a request that never reached the server (Chrome, Firefox, Safari): the page's.
      const offline = err && err.name === "TypeError" && /failed to fetch|networkerror|load failed/i.test(err.message || "");
      r = { error: offline ? t("chat.sendNoConnection") : err && err.message ? err.message : t("chat.disconnected") };
    }
    if (!(s.outgoing[target] || []).includes(e)) return;                // deleted meanwhile
    if (r && !r.error && r.sent !== false) {
      e.outgoing = { state: "sent" };
      if (typeof r.messageId === "string") e.messageId = r.messageId;
      settleOutgoing(target);
      changed(target, "msgs"); changed(target);
      return;
    }
    // Files the server no longer holds (they are released when a delivery fails) are uploaded again on Retry.
    if (r && typeof r.error === "string" && /files? (are|is) not available|no such file|already sent/i.test(r.error)) for (const f of e.files) { f.id = null; f.state = "waiting"; }
    // #2272: the quoted message is gone: Retry sends it without the quote.
    if (r && r.reason === "reply_gone") { e.quote = undefined; e.replyTo = undefined; }
    const why = r && r.reason;
    const key = typeof why === "string" ? `chat.sendFailure_${why}` : "";
    const localized = key ? t(key) : "";
    e.outgoing = { state: "failed", error: localized && localized !== key ? localized : (r && r.error ? r.error : t("chat.disconnected")) };
    changed(target, "msgs"); changed(target);
    deps.toast(e.outgoing.error, false);
  }
  /** A failed send, sent again (the same bubble; files already uploaded are not uploaded again). */
  function retryOutgoing(target, clientId) {
    const e = (s.outgoing[target] || []).find((x) => x.clientId === clientId);
    if (!e || e.outgoing.state !== "failed") return;
    e.outgoing = { state: "queued" };
    for (const f of e.files) if (f.state === "failed") f.state = "waiting";
    changed(target, "msgs");
    return pump(target);
  }
  /** A failed send, let go (its previews freed). */
  function deleteOutgoing(target, clientId) {
    const list = s.outgoing[target] || [];
    const e = list.find((x) => x.clientId === clientId);
    if (!e || e.outgoing.state !== "failed") return;
    for (const f of e.files) freeUrl(f.url);
    s.outgoing[target] = list.filter((x) => x !== e);
    changed(target, "msgs"); changed(target);
  }
  /**
   * A failed send, back in the composer to change it: its text before what is typed there now, its files (within the
   * limits) and its reply, if none is started; the bubble goes. The page records the composer's undo step first.
   */
  function putBackOutgoing(target, clientId) {
    const list = s.outgoing[target] || [];
    const e = list.find((x) => x.clientId === clientId);
    if (!e || e.outgoing.state !== "failed") return;
    const draft = s.drafts[target] || "";
    s.drafts[target] = e.text ? (draft ? e.text + "\n" + draft : e.text) : draft;
    for (const f of e.files) freeUrl(f.url);
    s.outgoing[target] = list.filter((x) => x !== e);
    if (e.quote && !s.replies[target]) s.replies[target] = e.quote;
    changed(target, "msgs");
    if (e.files.length) addFiles(target, e.files.map((f) => f.file)); else changed(target);
  }
  function addFiles(target, list) {
    if (!target) return;
    const res = R().checkFiles(s.pendingFiles[target] || [], [...(list || [])]);
    s.pendingFiles[target] = res.kept;
    for (const x of res.rejected) { const why = R().fileRejection(x.reason); deps.toast(`${x.name}: ${t(why.key, ...why.values)}`, false); }
    changed(target);
  }
  function removeFile(target, index) { (s.pendingFiles[target] || []).splice(index, 1); changed(target); }
  /** A long paste as a .txt file when it fits beside what is attached; true when it was attached. */
  function attachPastedText(target, text) {
    if (!target) return false;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const f = new File([text], `pasted-${stamp}.txt`, { type: "text/plain" });
    const taken = s.pendingFiles[target] || [];
    if (R().checkFiles(taken, [f]).rejected.length) { deps.toast(t("chat.pasteKeptAsText")); return false; }
    pastedTexts.set(f, text);
    addFiles(target, [f]);
    deps.toast(tf("chat.pasteAttached", text.length.toLocaleString()));
    return true;
  }
  /** A pasted file back into the composer as text. */
  function fileBackAsText(target, index) {
    const f = (s.pendingFiles[target] || [])[index];
    if (!f || !pastedTexts.has(f)) return;
    s.pendingFiles[target].splice(index, 1);
    const draft = s.drafts[target] || "";
    s.drafts[target] = draft ? `${draft}\n${pastedTexts.get(f)}` : pastedTexts.get(f);
    changed(target);
  }
  const isPasted = (f) => pastedTexts.has(f);
  /** Typing stays local. */
  function setDraft(target, value) { s.drafts[target] = value; }
  /**
   * #2272: reply to a message of this chat — what the bar above the composer shows (its sender and first words); only
   * its row is sent. One at a time per chat: a new one replaces it.
   */
  function startReply(target, m) {
    if (!target || !m || typeof m.boot !== "string" || typeof m.id !== "number") return;
    s.replies[target] = { boot: m.boot, id: m.id, sender: String(m.sender || ""), text: String(m.click?.label ?? m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      media: (m.attachments || []).length ? ((m.attachments || []).some(a => a.kind === "photo") ? "photo" : "document") : undefined };
    changed(target);
  }
  function clearReply(target) { if (s.replies[target]) { delete s.replies[target]; changed(target); } }
  /**
   * #2272: the quoted message, drawn for a jump: in what this chat holds, or after reading the longest history the
   * server keeps for it (the newest 500). false: no longer kept.
   */
  async function findQuoted(name, key) {
    const has = () => (s.msgs[name] || []).some(m => `${m.boot}-${m.id}` === key);
    if (has()) return true;
    try {
      const r = await api("GET", `/ui/history?instance=${encodeURIComponent(name)}&limit=500`);
      if (r && Array.isArray(r.messages)) { s.msgs[name] = R().mergeMessages(s.msgs[name], r.messages, 500); settleOutgoing(name); changed(name, "msgs"); }
    } catch { /* the jump says it is not there */ }
    return has();
  }

  // ── Stop the reply under way (the composer's Stop, or Esc). Set before the request goes, so a held Esc or a second
  // click sends nothing more (#1317); "Stopping…" until the agent goes idle, or a minute passes.
  async function cancelReply(target) {
    if (!target || s.cancelling[target]) return;
    s.cancelling[target] = true;
    changed(target);
    let r;
    try { r = await api("POST", `/ui/cancel/${encodeURIComponent(target)}`); }
    catch (err) { r = { error: err && err.message ? err.message : t("chat.disconnected") }; }
    delete s.cancelling[target];
    if (r && !r.error) {
      if (R().isBusy(s.exec[target])) {
        s.stopping[target] = true;
        deps.setTimeout(() => { if (s.stopping[target]) { delete s.stopping[target]; changed(target); } }, 60000);
      }
      deps.toast(`${target}: ${t("chat.stopSent")}`);
    } else deps.toast(r && r.error ? r.error : t("chat.disconnected"), false);
    changed(target);
  }

  // ── Chat commands (#1269): the instance's own /ctx, /compact, /clear, /model … through POST /ui/command. One command
  // at a time per instance, claimed before the request goes (a double Enter sends nothing more). /clear answers with a
  // confirmation first: asked in the app's dialog, and a yes counts only while `alive()` (the chat that asked is still
  // the one on screen) — the token is the server's, used once, for the instance as it was when asked.
  async function runCommand(target, command, args, opts = {}) {
    if (!target || !commandFree(target)) return;
    const alive = opts.alive || (() => true);
    s.commands[target] = { command, busy: true };
    changed(target);
    const post = async (extra) => {
      try { return await api("POST", "/ui/command", { instance: target, command, ...(args ? { args } : {}), ...extra }); }
      catch (err) { return { error: err && err.message ? err.message : t("chat.disconnected") }; }
    };
    let r = await post({});
    if (r && r.confirm) {
      const yes = deps.confirm ? await deps.confirm({ title: `/${command}`, message: r.confirm.message, confirmLabel: t(command === "backend" ? "chat.cmdConfirmBackend" : "chat.cmdConfirm"), danger: true }) : false;
      if (!yes || !alive()) { delete s.commands[target]; changed(target); return; }
      r = await post({ confirm: r.confirm.token });
    }
    const follow = r && r.follow && r.follow.kind === "compact" ? r.follow : null;
    showCommand(target, r && r.choices ? { command, busy: false, choices: r.choices }
      : r && r.error ? { command, busy: false, error: r.error }
      : { command, busy: false, text: (r && r.text) || "", ...(r && r.sent === true ? { sent: true } : {}), ...(follow ? { compact: follow.id ? "running" : "unknown", watch: follow.id } : {}) });
    changed(target);
  }
  // Board 003648ac: an answer the server marks `sent` leaves by itself; a sent /compact says "compacting…" until the
  // status frame's `compact` (same watch id) says it ended, then leaves when it is done. Everything else — a refusal
  // (even one worded as text), a list to choose from, an answer to read, a compaction timed out, lost or not made — stays.
  function showCommand(target, card) {
    s.commands[target] = card;
    const later = (ms, fn) => deps.setTimeout(() => { if (s.commands[target] === card) { fn(); changed(target); } }, ms);
    const leave = () => { delete s.commands[target]; };
    if (card.busy || card.error || card.choices || ["timeout", "lost", "not_compacted"].includes(card.compact)) return;
    if (card.compact === "running") later(COMPACT_PAGE_LIMIT_MS, () => showCommand(target, { ...card, compact: "timeout" }));
    else if (card.compact === "done") later(COMPACT_DONE_CLEAR_MS, leave);
    else if (card.compact === "unknown") later(COMPACT_UNKNOWN_CLEAR_MS, leave);
    else if (card.sent === true) later(SENT_CLEAR_MS, leave);
  }
  /** The status frame's word on a followed /compact: done, not compacted (kiro said so, board 907c7899), timed out, or lost. */
  function noteCompact(name, view) {
    const c = s.commands[name];
    if (!c || c.compact !== "running" || !view || view.id !== c.watch || !["done", "not_compacted", "timeout", "lost"].includes(view.state)) return;
    showCommand(name, { ...c, compact: view.state });
    changed(name);
  }
  function dismissCommand(target) { delete s.commands[target]; changed(target); }
  /** Whether a command can start for `target` now (none is out): checked before a typed command line is consumed. */
  const commandFree = (target) => !(s.commands[target] && s.commands[target].busy);

  /** Wire the store to the app's stream, for the life of the page. */
  function attach(stream) {
    stream.on("status", applyStatus);
    stream.on("activity", applyActivity);
    stream.on("message", ingest);
    stream.on("agent_reply_live", liveReplies.receipt);
    stream.on("delivery", (d) => applyDeliveries([d]));
    stream.on("deliveries", applyDeliveries);
    stream.on("prompt", onPrompt);
    stream.on("prompts", applyPrompts);
    stream.on("prompt_resolved", resolvePrompt);
    stream.on("reply_buttons", applyReplyButtons);
    stream.on("reactions", applyReactions);                              // #2305
    stream.on("clock", noteServerClock);                                  // #1823
  }

  return {
    state: s,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    setCurrent(name) { s.current = name; },
    onAgentReply: liveReplies.subscribe,
    attach, applyStatus, applyActivity, ingest, applyDeliveries, openHistory,
    onPrompt, applyPrompts, resolvePrompt, answerPrompt, answerByNonce, holdPrompt, releasePrompt, promptsFor,
    applyReplyButtons, clickReplyButton,
    uploadFile, send, retryOutgoing, deleteOutgoing, putBackOutgoing, threadRows, addFiles, removeFile, attachPastedText, fileBackAsText, isPasted, setDraft,
    startReply, clearReply, findQuoted,
    cancelReply, isUser, runCommand, dismissCommand, commandFree,
  };
}
