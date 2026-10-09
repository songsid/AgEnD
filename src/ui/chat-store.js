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

const R = () => globalThis.AgendChatRender;

/** Build a store. `deps` (fetch, toast, announce, t, now) are injected so tests can drive every path. */
export function createChatStore(deps) {
  const s = {
    msgs: {}, drafts: {}, failedSends: {}, pendingFiles: {}, sending: {}, inFlightFiles: {},
    prompts: {}, workingSince: {}, stopping: {}, cancelling: {}, scrollMemo: {}, historyRead: new Set(),
    exec: {}, awaiting: {}, current: null,
  };
  const subs = new Set();
  const pastedTexts = new WeakMap();
  const now = deps.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const t = deps.t, tf = deps.t;

  /** Tell subscribers what changed: `kind` "msgs" (the thread redraws) or "state" (everything else). */
  function changed(instance, kind = "state") { for (const fn of [...subs]) fn(instance, kind); }
  async function api(method, path, body) {
    const o = { method, headers: { "Content-Type": "application/json" } };
    if (body) o.body = JSON.stringify(body);
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
      noteExec(i.name, (i.execution_state !== undefined ? i.execution_state : i.state) ?? null);
      const waits = i.state === "awaiting_input" ? (typeof i.interaction_summary === "string" ? i.interaction_summary : "") : null;
      if (i.name === s.current && waits != null && s.awaiting[i.name] == null) deps.announce(tf("chat.awaiting", i.name));
      s.awaiting[i.name] = waits;
    }
    changed(null);
  }
  function applyActivity(d) {
    if (!d || typeof d.instance !== "string") return;
    noteExec(d.instance, d.state ?? null);
    changed(d.instance);
  }

  // ── Messages: one way in, from the stream, a poll or the history; one entry per boot+id.
  function ingest(m) {
    if (!m || typeof m.instance !== "string") return;
    const before = s.msgs[m.instance];
    s.msgs[m.instance] = R().mergeMessages(before, [m], 500);
    if (m.instance === s.current && s.msgs[m.instance] !== before && !isUser(m, m.instance) && (s.msgs[m.instance] || []).length > (before || []).length) deps.announce(tf("chat.a11yReplied", m.sender));
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
  /** Read an instance's history once per page (the first time a person opens its chat). */
  async function openHistory(name, lease) {
    if (s.historyRead.has(name)) return false;
    s.historyRead.add(name);
    try {
      const r = await api("GET", `/ui/history?instance=${encodeURIComponent(name)}&limit=200`);
      if (!r || !Array.isArray(r.messages)) { s.historyRead.delete(name); return true; }
      // Kept even when the person has moved on: the store is page-lived, and the answer belongs to `name`.
      s.msgs[name] = R().mergeMessages(s.msgs[name], r.messages, 500);
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
    else if (!had.resolved) Object.assign(had, { text: p.text, actions: p.actions, expiresAt: p.expiresAt });
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
      else if (!had.resolved) Object.assign(had, { text: p.text, actions: p.actions, expiresAt: p.expiresAt });
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
  const promptsFor = (instance) => Object.values(s.prompts).filter(p => p.instance === instance);

  // ── Sending. Never lose anything: a failed send's files go back to that chat's list and its text back into its own
  // composer when that is empty, otherwise it is kept for its chat and offered back (Put back).
  async function uploadFile(target, file) {
    const r = await deps.fetch(`/ui/upload?instance=${encodeURIComponent(target)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-Agend-Filename": encodeURIComponent(file.name || "file") },
      body: file,
    });
    let body = {};
    try { body = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || !body || typeof body.id !== "string") throw new Error(body && body.error ? `${file.name}: ${body.error}` : `${file.name}: upload failed (${r.status})`);
    return body;
  }
  async function send(target) {
    const txt = (s.drafts[target] || "").trim();
    const files = (s.pendingFiles[target] || []).slice();
    if ((!txt && !files.length) || !target || s.sending[target]) return;
    s.sending[target] = true;
    s.drafts[target] = "";
    s.pendingFiles[target] = []; s.inFlightFiles[target] = files;
    changed(target);
    changed(target, "sent");          // your own message: the thread goes to the bottom
    let r;
    try {
      const ids = [];
      for (const f of files) ids.push((await uploadFile(target, f)).id);
      r = await api("POST", "/ui/send", ids.length ? { instance: target, message: txt, attachments: ids } : { instance: target, message: txt });
    } catch (err) { r = { error: err && err.message ? err.message : t("chat.disconnected") }; }
    s.sending[target] = false;
    delete s.inFlightFiles[target];
    if (r && !r.error) { changed(target); return; }
    if (files.length) s.pendingFiles[target] = R().checkFiles(files, s.pendingFiles[target] || []).kept;
    if (txt) {
      const shown = s.current === target;
      if (R().settleFailedSend(target, s.current, shown, shown ? (s.drafts[target] || "") : "") === "restore") s.drafts[target] = txt;
      else s.failedSends[target] = s.failedSends[target] ? `${s.failedSends[target]}\n${txt}` : txt;
    }
    changed(target);
    deps.toast(r && r.error ? r.error : t("chat.disconnected"), false);
  }
  function addFiles(target, list) {
    if (!target) return;
    const inFlight = s.inFlightFiles[target] || [];
    const res = R().checkFiles(inFlight.concat(s.pendingFiles[target] || []), [...(list || [])]);
    s.pendingFiles[target] = res.kept.slice(inFlight.length);
    for (const x of res.rejected) deps.toast(`${x.name}: ${t(`chat.file_${x.reason.replace(/-/g, "_")}`)}`, false);
    changed(target);
  }
  function removeFile(target, index) { (s.pendingFiles[target] || []).splice(index, 1); changed(target); }
  /** A long paste as a .txt file when it fits beside what is attached; true when it was attached. */
  function attachPastedText(target, text) {
    if (!target) return false;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const f = new File([text], `pasted-${stamp}.txt`, { type: "text/plain" });
    const taken = (s.inFlightFiles[target] || []).concat(s.pendingFiles[target] || []);
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
  function putBack(target) {
    const kept = s.failedSends[target];
    if (!kept) return;
    s.drafts[target] = R().putBack(kept, s.drafts[target] || "");
    delete s.failedSends[target];
    changed(target);
  }
  function discardFailed(target) { delete s.failedSends[target]; changed(target); }
  /** Typing: kept for its chat, no redraw (the composer already shows it). */
  function setDraft(target, value) { s.drafts[target] = value; }

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

  /** Wire the store to the app's stream, for the life of the page. */
  function attach(stream) {
    stream.on("status", applyStatus);
    stream.on("activity", applyActivity);
    stream.on("message", ingest);
    stream.on("delivery", (d) => applyDeliveries([d]));
    stream.on("deliveries", applyDeliveries);
    stream.on("prompt", onPrompt);
    stream.on("prompts", applyPrompts);
    stream.on("prompt_resolved", resolvePrompt);
  }

  return {
    state: s,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    setCurrent(name) { s.current = name; },
    attach, applyStatus, applyActivity, ingest, applyDeliveries, openHistory,
    onPrompt, applyPrompts, resolvePrompt, answerPrompt, answerByNonce, promptsFor,
    uploadFile, send, addFiles, removeFile, attachPastedText, fileBackAsText, isPasted, putBack, discardFailed, setDraft,
    cancelReply, isUser,
  };
}
