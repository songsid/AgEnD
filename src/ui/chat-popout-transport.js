// #3637: a bounded data handoff between exact same-origin windows, never an authentication channel.
import { isSafeInstanceName, chatPath } from "/assets/app-route.js";
const channel = "agend-chat-popout-v1";
const message = (type, fields) => ({ channel, type, ...fields });
const valid = data => !!data && data.channel === channel && typeof data.type === "string";
export const POPOUT_DEADLINE_MS = 15_000;

export function createPopoutTransport({ win = window, scope, notify = () => {}, now = () => performance.now() }) {
  let alive = true, pending = null;
  const cancel = reason => { if (pending) pending.finish(reason); };
  function open({ name, payload, current, complete }) {
    if (!alive || !scope || !isSafeInstanceName(name) || !current()) return false;
    if (pending) { notify("busy"); return false; }
    const origin = win.location.origin, nonce = win.crypto.randomUUID(), started = now();
    let child = null, offered = false, done = false;
    const time = () => now() >= started && now() < started + POPOUT_DEADLINE_MS;
    const finish = reason => {
      if (done) return; done = true; win.removeEventListener("message", receive); clearInterval(timer);
      if (pending?.finish === finish) pending = null;
      try { if (child) child.opener = null; } catch { /* a navigated window may no longer be same-origin */ }
      if (reason) notify(reason);
    };
    const receive = event => {
      if (done || !child || event.source !== child || event.origin !== origin || !valid(event.data)) return;
      const data = event.data;
      if (data.name !== name || data.scope !== scope) return;
      if (!time() || child.closed || !current()) { finish("retained"); return; }
      if (data.type === "ready" && !offered) {
        offered = true;
        try { child.postMessage(message("draft", { name, scope, nonce, payload }), origin); } catch { finish("retained"); }
      } else if (offered && data.nonce === nonce && ["received", "refused"].includes(data.type)) {
        // Consume before invoking any callback; a duplicate ACK cannot close a later pane.
        finish();
        let completed = false;
        try { completed = data.type === "received" && current() && complete() === true; } catch { /* retain on a failed local transition */ }
        if (!completed) notify("retained");
      }
    };
    const timer = setInterval(() => { if (!time() || child?.closed || !current()) finish("retained"); }, 100);
    pending = { finish }; win.addEventListener("message", receive);
    // This must stay in the click stack. noopener would return null even after a successful open.
    try { child = win.open(`${chatPath(name)}?presentation=popout`, "_blank", "popup,width=760,height=800"); } catch { /* blocked */ }
    if (!child) { finish("blocked"); return false; }
    return true;
  }
  const hide = () => cancel("retained"); win.addEventListener("pagehide", hide);
  return { open, cancel, close() { alive = false; cancel(); win.removeEventListener("pagehide", hide); } };
}

export function receivePopoutDraft({ win = window, name, scope, ready, current, accept, notify = () => {}, now = () => performance.now() }) {
  const parent = win.opener, origin = win.location.origin, started = now();
  if (!parent || !scope || !isSafeInstanceName(name)) return () => {};
  let sent = false, done = false;
  const time = () => now() >= started && now() < started + POPOUT_DEADLINE_MS;
  const finish = () => {
    if (done) return; done = true; clearInterval(timer); win.removeEventListener("message", receive); win.removeEventListener("pagehide", finish);
    try { win.opener = null; } catch { /* the browser still controls its window */ }
  };
  const receive = event => {
    const data = event.data;
    if (done || !sent || event.source !== parent || event.origin !== origin || !valid(data) || data.type !== "draft"
      || data.name !== name || data.scope !== scope || typeof data.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(data.nonce)) return;
    const allowed = time() && current() && ready();
    // One offer only, even when validation fails. Never overwrite later typing with a replay.
    finish();
    let accepted = false;
    try { accepted = allowed && accept(data.payload) === true; } catch { /* malformed/unclonable local data never becomes a send */ }
    try { parent.postMessage(message(accepted ? "received" : "refused", { name, scope, nonce: data.nonce }), origin); } catch { /* parent keeps its original */ }
    if (!accepted) notify("retained");
  };
  const tick = () => {
    if (!time() || !current() || parent.closed) { finish(); return; }
    if (!sent && ready()) {
      sent = true;
      try { parent.postMessage(message("ready", { name, scope }), origin); } catch { finish(); }
    }
  };
  const timer = setInterval(tick, 50); win.addEventListener("message", receive); win.addEventListener("pagehide", finish); tick();
  return finish;
}
