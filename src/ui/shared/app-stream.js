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
//
// Reconnecting (#1580): a fleet restart drops every open tab's stream at once, and used to have each tab retry through
// the browser's own EventSource loop (about every 3 s) AND poll every 5 s, both forever, hidden or not — through a
// relay (WSL2's wslrelay, a tunnel) that is dozens of fresh connections per tab per minute. Now this file owns it:
// - a dropped stream is closed (no browser retry) and reopened on a capped exponential backoff with jitter (about
//   1, 2, 4, 8, 16, then 30 s; each 50–100 % of its step). One EventSource at a time, ever.
// - a stream that fails before it speaks is followed by ONE /ui/poll probe: answered → the fleet is up and only the
//   stream is broken (a buffering proxy): poll every 5 s as before, and keep retrying the stream on the backoff; not
//   answered → "reconnecting", and no poll loop at all. The public link's poll loop backs off the same way.
// - a step due while the tab is hidden waits until it is shown again (a live stream stays open: Needs you).
// - every reconnect catches up once the new stream speaks (catchUp(), with the page's cursor — #1566/#1578), so what
//   was said meanwhile is shown, once.
// - a 401 is the session ending: nothing is retried (agend-auth.js says so).
// - suspend()/resume(): the page is leaving (pagehide) / came back from the back-forward cache.

const EVENTS = ["status", "message", "delivery", "deliveries", "prompt", "prompts", "prompt_resolved", "activity", "needs", "reply_buttons"];
const MAX_HELD = 1000;                    // live events held during one catch-up read; more → read again afterwards
const RETRY_DELAYS = [1000, 2000, 4000];  // after the first failed catch-up read; then it waits for Retry
const POLL_LIMIT_MS = 10000;              // a poll that has not answered by then counts as failed
const MAX_OVERFLOW_READS = 3;            // reads again after dropped live events, within one catch-up
// #1580: the reconnect backoff — step n waits min(cap, base·2ⁿ), drawn from 50–100 % of that (jitter: tabs that lost
// the fleet together do not come back together).
export const RECONNECT = { baseMs: 1000, capMs: 30000 };
export function reconnectDelay(step, random = Math.random) {
  const full = Math.min(RECONNECT.capMs, RECONNECT.baseMs * 2 ** Math.min(step, 20));
  return Math.round(full * (0.5 + random() * 0.5));
}

export function createStream(opts) {
  const env = opts.env || globalThis;
  const listeners = new Map();          // event name → Set of handlers
  const state = { connection: "connecting", cursor: "", hydration: "none" };
  let sse = null, pollTimer = null, silentTimer = null, closed = false, started = false;
  // #1580: the reconnect step waiting, how many failed in a row, a step waiting for the tab to be shown, a page that left.
  let reconnectTimer = null, attempts = 0, waitingVisible = false, suspended = false, ended = false, retryAt = 0;
  const random = typeof env.random === "function" ? env.random : Math.random;
  const doc = env.document || null;
  const hidden = () => !!(doc && doc.hidden);
  const now = () => (env.performance && typeof env.performance.now === "function" ? env.performance.now() : Date.now());
  let polling = null, pollAgain = false, pollSeq = 0;   // the poll in flight, whether another was asked for meanwhile
  let held = null;                                // live events held while a catch-up read is in flight
  let catching = null, retryTimer = null, retryWake = null;
  // #1580 review: who owns the work in flight. `readEpoch` moves when the page lets everything go (suspend, end,
  // close): a read, a catch-up or a queued poll begun before it neither emits, nor releases, nor queues, nor decides
  // anything. `epoch` also moves when the stream comes back live: a fallback read's or a probe's late failure must not
  // turn a healthy stream into "reconnecting" — those control decisions belong to the epoch they started in.
  let readEpoch = 0, epoch = 0;

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
    const mine = ++pollSeq, ep = readEpoch;
    let status = 0;                                  // this read's HTTP status — its own, never another read's
    if (sse && !held) held = [];
    let limit = null;
    const read = (async () => {
      try {
        const r = await env.fetch(`/ui/poll?after=${encodeURIComponent(state.cursor)}`, { cache: "no-store" });
        status = r.status | 0;
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
    const p = polling = Promise.race([read, timedOut]).then((ok) => {
      env.clearTimeout(limit);
      // Let go of (suspend, end, close) while it was out: it decides nothing — and touches nothing that is newer.
      if (ep !== readEpoch) return { ok: false, overflow: false, status, stale: true };
      if (mine === pollSeq) pollSeq++;               // whatever this read still does from here on is ignored
      if (polling === p) polling = null;
      if (closed) { held = null; return { ok: false, overflow: false, status }; }
      // #1580: the session ended, whichever read heard it — everything stops here, queued work included.
      if (status === 401) { held = null; end(); return { ok: false, overflow: false, status }; }
      const overflow = release();
      // Live events were dropped: what they changed is recovered by catching up — inside its lifecycle, so a failed
      // recovery read is retried and shown, never taken for done (#1425 review). A catch-up awaiting this read loops.
      if (overflow && !catching) catchUp();
      if (pollAgain) { pollAgain = false; pollOnce(); }
      return { ok, overflow, status };
    });
    return p;
  }
  /** #1580 review: the page lets go of everything in flight — reads, the queued poll, the catch-up and its retry wait. */
  function cancelWork() {
    readEpoch++; epoch++;
    pollSeq++; polling = null; pollAgain = false; held = null;
    env.clearTimeout(retryTimer); retryTimer = null;
    const wake = retryWake; retryWake = null;
    catching = null;
    if (wake) wake();                                // the old catch-up settles (false) instead of waiting forever
  }
  /** The 5 s poll: the public link's transport, and a reachable fleet whose stream does not get through. */
  function startPolling(pollNow = true) {
    if (pollTimer || closed || suspended || ended) return;
    setConnection("polling");
    if (pollNow) pollTick();
    pollTimer = env.setInterval(pollTick, 5000);
  }
  async function pollTick() {
    const ep = epoch;
    const r = await pollOnce();
    if (closed || suspended || ended || ep !== epoch || r.stale || r.ok || r.overflow) return;
    // Not answered: the fleet is not there (a restart). The loop stops — no poll storm — and the backoff takes over.
    stopPolling();
    setConnection("reconnecting");
    scheduleStep();
  }
  function stopPolling() { if (pollTimer) { env.clearInterval(pollTimer); pollTimer = null; } }
  function alive() {
    if (state.connection !== "live") epoch++;      // back live: earlier fallback/probe failures decide nothing now
    stopPolling();
    attempts = 0;
    env.clearTimeout(reconnectTimer); reconnectTimer = null; waitingVisible = false;
    env.clearTimeout(silentTimer); silentTimer = env.setTimeout(startPolling, 30000);
    setConnection("live");
  }

  // ── #1580: reconnecting ──
  function closeStream() {
    if (sse) { sse.onerror = null; try { sse.close(); } catch { /* already closed */ } }
    sse = null;
    env.clearTimeout(silentTimer); silentTimer = null;
  }
  /** Open the one EventSource. `again`: a reconnect — once it speaks, catch up on what was said while it was away. */
  function openStream(again) {
    closeStream();
    const es = sse = new env.EventSource("/ui/events");
    let spoke = false;
    silentTimer = env.setTimeout(startPolling, 15000);   // the server sends a status frame the moment a stream opens
    for (const name of EVENTS) {
      es.addEventListener(name, (e) => {
        if (es !== sse) return;                          // a stream this page already let go of
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        if (!spoke) { spoke = true; alive(); if (again) catchUp(); }
        else alive();
        live(name, data, name === "message" ? e.lastEventId : null);
      });
    }
    es.onerror = () => {
      if (es !== sse) return;
      closeStream();                                     // never the browser's own retry loop
      if (closed || suspended || ended) return;
      if (spoke) { setConnection("reconnecting"); scheduleStep(); return; }
      probe();
    };
  }
  /** The stream failed before it spoke: is the fleet there at all? One poll says. */
  async function probe() {
    if (pollTimer) { scheduleStep(); return; }          // already polling: that loop is the probe
    const ep = epoch;
    const r = await pollOnce({ join: true });
    if (closed || suspended || ended || ep !== epoch || r.stale) return;
    if (r.ok) startPolling(false);                       // reachable, the stream does not get through: poll meanwhile
    else setConnection("reconnecting");
    scheduleStep();
  }
  function scheduleStep() {
    if (reconnectTimer || closed || suspended || ended) return;
    const ms = reconnectDelay(attempts++, random);
    retryAt = now() + ms;
    emit("retry", { inMs: ms });
    reconnectTimer = env.setTimeout(() => { reconnectTimer = null; step(); }, ms);
  }
  function step() {
    if (closed || suspended || ended) return;
    if (hidden()) { waitingVisible = true; return; }    // not while nobody looks: the next step waits to be shown
    if (opts.transport === "poll") { pollProbe(); return; }
    openStream(true);
  }
  /** The public link's reconnect step: one poll; answered → the 5 s loop again (it just read), else the next step. */
  async function pollProbe() {
    const ep = epoch;
    const r = await pollOnce();
    if (closed || suspended || ended || ep !== epoch || r.stale) return;
    if (r.ok) { attempts = 0; startPolling(false); }
    else scheduleStep();
  }
  function onVisible() {
    if (!hidden() && waitingVisible) { waitingVisible = false; step(); }
  }
  function end() {
    if (ended) return;
    ended = true;
    cancelWork();
    closeStream(); stopPolling();
    env.clearTimeout(reconnectTimer); reconnectTimer = null;
    setConnection("ended");
  }

  /**
   * Read what is current now, once, ordered against the live stream (see the top). Resolves true once a read was
   * applied. While retries are spent it resolves false and the state stays "failed" until catchUp() is called again.
   * It opens no transport: still the one EventSource, and no polling loop.
   */
  function catchUp() {
    if (closed || ended) return Promise.resolve(false);
    if (catching) return catching;
    env.clearTimeout(retryTimer); retryTimer = null;
    setHydration("catching");
    const ep = readEpoch;
    // Settles this catch-up; the page's current one is cleared only if it is still this one (a resume may have
    // started a newer one meanwhile).
    const done = (value, hydration) => { if (catching === me) { catching = null; if (hydration) setHydration(hydration); } return value; };
    const me = (async () => {
      let failures = 0, overflows = 0;
      for (;;) {
        // A poll already on its way will do (its answer reaches the listener that just attached); nothing is queued.
        const { ok, overflow } = await pollOnce({ join: true });
        if (closed || ep !== readEpoch) return done(false);   // let go of (suspend, end — a 401 — or close): no retry
        if (ok && !overflow) return done(true, "ok");
        if (ok) {
          // Read, but live events were dropped meanwhile: not done until a read without that succeeds. At once (nothing
          // failed), and bounded: a stream that floods every read gives up as failed, with Retry.
          if (++overflows > MAX_OVERFLOW_READS) return done(false, "failed");
          continue;
        }
        if (failures >= RETRY_DELAYS.length) return done(false, "failed");
        setHydration("retrying");
        await new Promise((resolve) => { retryWake = resolve; retryTimer = env.setTimeout(resolve, RETRY_DELAYS[failures++]); });
        retryTimer = null; retryWake = null;
        if (closed || ep !== readEpoch) return done(false);
      }
    })();
    catching = me;
    return me;
  }

  /** Open the transport. Called once every listener that must see the first frames is attached (the chat's store):
   *  a status, prompts or deliveries frame sent on connect is never missed. */
  function start() {
    if (started || closed) return;
    started = true;
    if (opts.mode === "full" && doc && typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onVisible);
    if (opts.mode === "full" && opts.transport === "poll") startPolling();
    else if (opts.mode === "full") openStream(false);
    else setConnection("none");
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
    /** #1580: ms until the next reconnect step (0 when none is waiting). */
    retryIn: () => (reconnectTimer ? Math.max(0, retryAt - now()) : 0),
    /** #1580: the page is leaving (pagehide): the stream and every timer go — nothing is left half-open. */
    suspend() {
      if (closed || !started || suspended) return;
      suspended = true;
      cancelWork();
      closeStream(); stopPolling();
      env.clearTimeout(reconnectTimer); reconnectTimer = null; waitingVisible = false;
    },
    /** #1580: back from the back-forward cache (pageshow, persisted): reconnect at once and catch up. */
    resume() {
      if (closed || !suspended || ended) return;
      suspended = false;
      epoch++;
      attempts = 0;
      if (opts.transport === "poll") { startPolling(); return; }
      openStream(true);
    },
    /** For tests and page unload: nothing is emitted after this. */
    close() {
      closed = true;
      cancelWork();
      stopPolling();
      closeStream();
      env.clearTimeout(reconnectTimer); env.clearTimeout(retryTimer);
      if (doc && typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", onVisible);
    },
    _pollOnce: pollOnce,
  };
}
