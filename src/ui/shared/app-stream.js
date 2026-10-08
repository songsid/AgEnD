// #1408 §3/§5: the app's one source of live updates, for the whole page whatever panel is showing.
//
// The mode comes from the server (<body data-mode / data-web-transport>):
// - local, signed in: ONE EventSource on /ui/events; while it is silent or down, /ui/poll every 5 s until it speaks.
// - the public link (data-web-transport="poll"): NO EventSource (its manifest has no /ui/events); /ui/poll from the start.
// - View-only (step 2): neither.
// A proxy that buffers a stream looks exactly like a server that never sends, so a stream that says nothing is treated
// as no stream. Every read here is on the #1374 passive list: no timer here ever counts as the person's activity.
// The poll's cursor is the stream's cursor; ticks and prompts come with every poll, so nothing is re-read elsewhere.

const EVENTS = ["status", "message", "delivery", "deliveries", "prompt", "prompts", "prompt_resolved", "activity", "needs"];

export function createStream(opts) {
  const env = opts.env || globalThis;
  const listeners = new Map();          // event name → Set of handlers
  const state = { connection: "connecting", cursor: "" };
  let sse = null, pollTimer = null, silentTimer = null, errorTimer = null, closed = false, started = false;

  function emit(name, data, extra) {
    const set = listeners.get(name);
    if (set) for (const fn of [...set]) { try { fn(data, extra); } catch (e) { if (env.console) env.console.error(e); } }
  }
  function setConnection(c) { if (state.connection !== c) { state.connection = c; emit("connection", c); } }

  async function pollOnce() {
    try {
      const r = await env.fetch(`/ui/poll?after=${encodeURIComponent(state.cursor)}`, { cache: "no-store" });
      if (closed || !r.ok) return;
      const d = await r.json();
      if (closed) return;
      if (d.status) emit("status", d.status);
      for (const m of d.messages || []) emit("message", m);
      if (typeof d.cursor === "string") state.cursor = d.cursor;
      if (Array.isArray(d.deliveries)) emit("deliveries", d.deliveries);
      if (Array.isArray(d.prompts)) emit("prompts", d.prompts);
      if (Array.isArray(d.needs)) emit("needs", { items: d.needs });
    } catch { /* the next tick tries again */ }
  }
  function startPolling() {
    if (pollTimer || closed) return;
    setConnection("polling");
    pollOnce();
    pollTimer = env.setInterval(pollOnce, 5000);
  }
  function stopPolling() { if (pollTimer) { env.clearInterval(pollTimer); pollTimer = null; } }
  function alive() {
    stopPolling();
    env.clearTimeout(errorTimer); errorTimer = null;
    env.clearTimeout(silentTimer); silentTimer = env.setTimeout(startPolling, 30000);
    setConnection("live");
  }

  /** Open the transport. Called once every listener that must see the first frames is attached (the chat's store):
   *  a status, prompts or deliveries frame sent on connect is never missed. */
  function start() {
    if (started || closed) return;
    started = true;
    if (opts.mode === "full" && opts.transport === "poll") startPolling();
    else if (opts.mode === "full") {
      sse = new env.EventSource("/ui/events");
      silentTimer = env.setTimeout(startPolling, 15000);   // the server sends a status frame the moment a stream opens
      for (const name of EVENTS) {
        sse.addEventListener(name, (e) => {
          alive();
          if (name === "message" && e.lastEventId) state.cursor = e.lastEventId;
          let data;
          try { data = JSON.parse(e.data); } catch { return; }
          emit(name, data);
        });
      }
      sse.onerror = () => {
        if (state.connection === "live") setConnection("down");
        // Armed once, not re-armed: the browser retries every few seconds and each retry fires this again.
        if (!errorTimer) errorTimer = env.setTimeout(startPolling, 5000);
      };
    } else setConnection("none");
  }

  return {
    /** Listen to one event ("status", "message", …, or "connection"); returns the unsubscribe. */
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    start,
    started: () => started,
    /**
     * One passive /ui/poll, now: the current status, open prompts, delivery ticks and messages since the cursor, as
     * events. For a listener that attached after the stream opened (the chat recovering from a failed first load,
     * #1425 review): what was sent on connect reached nobody, and a healthy stream does not send it again. It starts
     * no transport — the stream stays the one it is.
     */
    catchUp: () => (closed ? Promise.resolve() : pollOnce()),
    connection: () => state.connection,
    usesEventSource: () => sse !== null,
    /** For tests and page unload. */
    close() {
      closed = true;
      stopPolling();
      env.clearTimeout(silentTimer); env.clearTimeout(errorTimer);
      if (sse) sse.close();
    },
    _pollOnce: pollOnce,
  };
}
