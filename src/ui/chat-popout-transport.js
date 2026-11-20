// #3637: a bounded data handoff between exact same-origin windows, never an authentication channel.
import { isSafeInstanceName, chatPath } from "/assets/app-route.js";
const protocols = {
  chat: { channel: "agend-chat-popout-v1", payload: "draft", presentation: "popout" },
  preview: { channel: "agend-preview-popout-v1", payload: "locator", presentation: "preview" },
};
const message = (wire, type, fields) => ({ channel: wire.channel, type, ...fields });
const valid = (wire, data) => !!data && data.channel === wire.channel && typeof data.type === "string";
export const POPOUT_DEADLINE_MS = 15_000;
function secureNonce(crypto) {
  try {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto?.getRandomValues !== "function") return null;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(n => n.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  } catch { return null; }
}


export function createPopoutTransport({ win = window, scope, notify = () => {}, now = () => performance.now(), kind = "chat" }) {
  const wire = Object.hasOwn(protocols, kind) ? protocols[kind] : null;
  let alive = true, pending = null;
  const cancel = reason => { if (pending) pending.finish(reason); };
  function open({ name, payload, current, complete }) {
    if (!wire || !alive || !scope || !isSafeInstanceName(name) || !current()) return false;
    if (pending) { notify("busy"); return false; }
    const origin = win.location.origin, nonce = secureNonce(win.crypto), started = now();
    if (!nonce) { notify("retained"); return false; }
    let child = null, offered = false, done = false;
    const time = () => now() >= started && now() < started + POPOUT_DEADLINE_MS;
    const finish = reason => {
      if (done) return; done = true; win.removeEventListener("message", receive); clearInterval(timer);
      if (pending?.finish === finish) pending = null;
      try { if (child) child.opener = null; } catch { /* a navigated window may no longer be same-origin */ }
      if (reason) notify(reason);
    };
    const receive = event => {
      if (done || !child || event.source !== child || event.origin !== origin || !valid(wire, event.data)) return;
      const data = event.data;
      if (data.name !== name || data.scope !== scope) return;
      if (!time() || child.closed || !current()) { finish("retained"); return; }
      if (data.type === "ready" && !offered) {
        offered = true;
        try { child.postMessage(message(wire, wire.payload, { name, scope, nonce, payload }), origin); } catch { finish("retained"); }
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
    try { child = win.open(`${chatPath(name)}?presentation=${wire.presentation}`, "_blank", "popup,width=760,height=800"); } catch { /* blocked */ }
    if (!child) { finish("blocked"); return false; }
    return true;
  }
  const hide = () => cancel("retained"); win.addEventListener("pagehide", hide);
  return { open, cancel, close() { alive = false; cancel(); win.removeEventListener("pagehide", hide); } };
}

export function receivePopoutDraft({ win = window, name, scope, ready, current, accept, notify = () => {}, now = () => performance.now(), kind = "chat" }) {
  const wire = Object.hasOwn(protocols, kind) ? protocols[kind] : null;
  const parent = win.opener, origin = win.location.origin, started = now();
  if (!wire || !parent || !scope || !isSafeInstanceName(name)) return () => {};
  let sent = false, done = false;
  const time = () => now() >= started && now() < started + POPOUT_DEADLINE_MS;
  const finish = () => {
    if (done) return; done = true; clearInterval(timer); win.removeEventListener("message", receive); win.removeEventListener("pagehide", finish);
    try { win.opener = null; } catch { /* the browser still controls its window */ }
  };
  const receive = event => {
    const data = event.data;
    if (done || !sent || event.source !== parent || event.origin !== origin || !valid(wire, data) || data.type !== wire.payload
      || data.name !== name || data.scope !== scope || typeof data.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(data.nonce)) return;
    const stillCurrent = () => time() && current() && ready();
    const allowed = stillCurrent();
    // Consume before any asynchronous history read; no replay can initiate another read.
    finish();
    const answer = result => {
      const accepted = result === true && (kind !== "preview" || stillCurrent());
      try { parent.postMessage(message(wire, accepted ? "received" : "refused", { name, scope, nonce: data.nonce }), origin); } catch { /* parent keeps its original */ }
      if (!accepted) notify("retained");
    };
    try {
      const result = allowed && (kind === "preview" ? accept(data.payload, stillCurrent) : accept(data.payload));
      if (kind === "preview" && result && typeof result.then === "function") result.then(answer, () => answer(false));
      else answer(result);
    } catch { answer(false); }

  };
  const tick = () => {
    if (!time() || !current() || parent.closed) { finish(); return; }
    if (!sent && ready()) {
      sent = true;
      try { parent.postMessage(message(wire, "ready", { name, scope }), origin); } catch { finish(); }
    }
  };
  const timer = setInterval(tick, 50); win.addEventListener("message", receive); win.addEventListener("pagehide", finish); tick();
  return finish;
}


// Preview uses the same bounded exact-window protocol, with a separate channel and asynchronous own-history validation.
export const createPreviewPopoutTransport = opts => createPopoutTransport({ ...opts, kind: "preview" });
export const receivePreviewPopout = opts => receivePopoutDraft({ ...opts, kind: "preview" });
