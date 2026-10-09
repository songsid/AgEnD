// #1408 §3/§5: the app's one source of live updates, for the whole page whatever panel is showing.
//
// The mode comes from the server (<body data-mode / data-web-transport>):
// - local, signed in: ONE EventSource on /ui/events; while it is silent or down, /ui/poll every 5 s until it speaks.
// - the public link (data-web-transport="poll"): NO EventSource (its manifest has no /ui/events); /ui/poll from the start.
// - View-only (step 2): neither.
// A proxy that buffers a stream looks exactly like a server that never sends, so a stream that says nothing is treated
// as no stream. Every read here is on the #1374 passive list: no timer here ever counts as the person's activity.
// The poll's cursor is the stream's cursor; ticks and prompts come with every poll, so nothing is re-read elsewhere.
//
// Catching up (#1425 review): a listener that attached after the stream opened (the chat loading only on Retry) missed
// the frames sent on connect, and a healthy stream sends only status after that. catchUp() reads /ui/poll once — and
// orders it against the live stream: while that read is in flight, live events are held, and once its snapshot is
// applied they are replayed in arrival order, so an answer or a new prompt that came meanwhile is never undone by the
// older snapshot. A failed read is retried a few times with a growing delay, and then waits for the person (Retry);
// the state is told as "hydration" events. Polls never overlap: a poll asked for while one runs follows it.

const EVENTS = ["status", "message", "delivery", "deliveries", "prompt", "prompts", "prompt_resolved", "activity", "needs", "reply_buttons"];
const MAX_HELD = 1000;                    // live events held during one catch-up read; more → read again afterwards
const RETRY_DELAYS = [1000, 2000, 4000];  // after the first failed catch-up read; then it waits for Retry
const POLL_LIMIT_MS = 10000;              // a poll that has not answered by then counts as failed
const MAX_OVERFLOW_READS = 3;            // reads again after dropped live events, within one catch-up

export function createStream(opts) {
  const env = opts.env || globalThis;
  const listeners = new Map();          // event name → Set of handlers
  const state = { connection: "connecting", cursor: "", hydration: "none" };
  let sse = null, pollTimer = null, silentTimer = null, errorTimer = null, closed = false, started = false;
  let polling = null, pollAgain = false, pollSeq = 0;   // the poll in flight, whether another was asked for meanwhile
  let held = null;                                // live events held while a catch-up read is in flight
  let catching = null, retryTimer = null;

  function emit(name, data, extra) {
    const set = listeners.get(name);
    if (set) for (const fn of [...set]) { try { fn(data, extra); } catch (e) { if (env.console) env.console.error(e); } }
  }
  function setConnection(c) { if (state.connection !== c) { state.connection = c; emit("connection", c); } }
  function setHydration(h) { if (state.hydration !== h) { state.hydration = h; emit("hydration", h); } }

  /** A live event: delivered now, or held (in order) while a catch-up snapshot is on its way. */
  function live(name, data, cursor) {
    if (held) {
      if (held.length < MAX_HELD) held.push([name, data, cursor]); else held.overflow = true;
      return;
    }
    if (cursor) state.cursor = cursor;
    emit(name, data);
    // A full set of open prompts arrives on every (re)connect: whatever a failed catch-up missed is current again.
    if (name === "prompts" && (state.hydration === "failed" || state.hydration === "retrying") && !catching) setHydration("ok");
  }
  function release() {
    const list = held;
    held = null;
    if (!list) return false;
    for (const [name, data, cursor] of list) { if (cursor) state.cursor = cursor; emit(name, data); }
    return !!list.overflow;
  }

  /**
   * One /ui/poll; resolves { ok, overflow }: ok when it was read and applied, overflow when more live events arrived
   * meanwhile than could be held (what was held is applied; the rest is recovered by reading again — see below).
   * - Ordered against the live stream, whatever asked for it (the fallback loop, a catch-up, a poll queued behind
   *   another): live events that arrive while it is in flight are held and replayed after its snapshot, so an older
   *   snapshot never lands on top of newer events (#1425 review).
   * - Never two at once: a poll asked for meanwhile runs after it — unless the caller only wants the current read
   *   (`join`, the catch-up): then it waits for that one and queues nothing.
   * - One that has not answered within POLL_LIMIT_MS counts as failed and its late answer is ignored, so a stuck
   *   request never holds up the polls after it (or the live events it holds).
   */
  function pollOnce(opts = {}) {
    if (polling) { if (!opts.join) pollAgain = true; return polling; }
    const mine = ++pollSeq;
    if (sse && !held) held = [];
    let limit = null;
    const read = (async () => {
      try {
        const r = await env.fetch(`/ui/poll?after=${encodeURIComponent(state.cursor)}`, { cache: "no-store" });
        if (closed || mine !== pollSeq || !r.ok) return false;
        const d = await r.json();
        if (closed || mine !== pollSeq) return false;
        if (d.status) emit("status", d.status);
        for (const m of d.messages || []) emit("message", m);
        if (typeof d.cursor === "string") state.cursor = d.cursor;
        if (Array.isArray(d.deliveries)) emit("deliveries", d.deliveries);
        if (Array.isArray(d.prompts)) emit("prompts", d.prompts);
        if (Array.isArray(d.reply_buttons)) for (const u of d.reply_buttons) emit("reply_buttons", u);   // #1266
        if (Array.isArray(d.needs)) emit("needs", { items: d.needs });
        return true;
      } catch { return false; /* the next tick, or the catch-up's retry, tries again */ }
    })();
    const timedOut = new Promise((resolve) => { limit = env.setTimeout(() => { if (mine === pollSeq) pollSeq++; resolve(false); }, POLL_LIMIT_MS); });
    polling = Promise.race([read, timedOut]).then((ok) => {
      env.clearTimeout(limit);
      if (mine === pollSeq) pollSeq++;               // whatever this read still does from here on is ignored
      polling = null;
      if (closed) { held = null; return { ok: false, overflow: false }; }
      const overflow = release();
      // Live events were dropped: what they changed is recovered by catching up — inside its lifecycle, so a failed
      // recovery read is retried and shown, never taken for done (#1425 review). A catch-up awaiting this read loops.
      if (overflow && !catching) catchUp();
      if (pollAgain) { pollAgain = false; pollOnce(); }
      return { ok, overflow };
    });
    return polling;
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

  /**
   * Read what is current now, once, ordered against the live stream (see the top). Resolves true once a read was
   * applied. While retries are spent it resolves false and the state stays "failed" until catchUp() is called again.
   * It opens no transport: still the one EventSource, and no polling loop.
   */
  function catchUp() {
    if (closed) return Promise.resolve(false);
    if (catching) return catching;
    env.clearTimeout(retryTimer); retryTimer = null;
    setHydration("catching");
    catching = (async () => {
      let failures = 0, overflows = 0;
      for (;;) {
        // A poll already on its way will do (its answer reaches the listener that just attached); nothing is queued.
        const { ok, overflow } = await pollOnce({ join: true });
        if (closed) return false;
        if (ok && !overflow) { catching = null; setHydration("ok"); return true; }
        if (ok) {
          // Read, but live events were dropped meanwhile: not done until a read without that succeeds. At once (nothing
          // failed), and bounded: a stream that floods every read gives up as failed, with Retry.
          if (++overflows > MAX_OVERFLOW_READS) { catching = null; setHydration("failed"); return false; }
          continue;
        }
        if (failures >= RETRY_DELAYS.length) { catching = null; setHydration("failed"); return false; }
        setHydration("retrying");
        await new Promise((resolve) => { retryTimer = env.setTimeout(resolve, RETRY_DELAYS[failures++]); });
        retryTimer = null;
        if (closed) return false;
      }
    })();
    return catching;
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
          let data;
          try { data = JSON.parse(e.data); } catch { return; }
          live(name, data, name === "message" ? e.lastEventId : null);
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
    /** Listen to one event ("status", "message", …, "connection" or "hydration"); returns the unsubscribe. */
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    start,
    started: () => started,
    catchUp,
    connection: () => state.connection,
    hydration: () => state.hydration,
    cursor: () => state.cursor,
    usesEventSource: () => sse !== null,
    /** For tests and page unload: nothing is emitted after this. */
    close() {
      closed = true;
      held = null;
      stopPolling();
      env.clearTimeout(silentTimer); env.clearTimeout(errorTimer); env.clearTimeout(retryTimer);
      if (sse) sse.close();
    },
    _pollOnce: pollOnce,
  };
}
