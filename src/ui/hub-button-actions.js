/** Hub F's four chat-store hooks. Shared thread markup stays unchanged; the server owns authorization and votes. */
const SET_ID = /^[a-f0-9]{32}$/;
const ownStorage = () => { try { return globalThis.sessionStorage || null; } catch { return null; } };
const indexes = v => Array.isArray(v) && v.length <= 10 && v.every(i => Number.isInteger(i) && i >= 0 && i < 10) && new Set(v).size === v.length;

export function createHubButtonActions(room, { client, entries, refresh, changed = () => {}, storage = ownStorage(), newKey = () => crypto.randomUUID() }) {
  const roomId = String(room.id), prefix = `agend-hub-buttons:${roomId}:`;
  const busy = new Set(), votes = new Map(), pending = new Map();
  let stopped = false;
  const notify = () => { if (!stopped) { try { changed(); } catch { /* a subscriber does not alter a committed action */ } } };
  const read = key => { try { return JSON.parse(storage?.getItem(prefix + key) || "null"); } catch { return null; } };
  const write = (key, value) => { try { if (value === null) storage?.removeItem(prefix + key); else storage?.setItem(prefix + key, JSON.stringify(value)); } catch { /* memory still works when storage is disabled */ } };
  const mine = id => {
    if (!votes.has(id)) { const saved = read(`mine:${id}`); votes.set(id, indexes(saved) ? [...saved].sort((a, b) => a - b) : []); }
    return [...votes.get(id)];
  };
  const view = id => (entries() || []).find(e => e.buttons?.id === id)?.buttons;
  const intent = body => JSON.stringify([body.setId, body.index ?? null, body.options ?? null]);
  async function post(setId, fields) {
    if (stopped) return { ok: false, code: "stopped" };
    if (!room.features?.includes("buttons-v1") || typeof client.chooseButtons !== "function") return { ok: false, code: "unsupported" };
    if (!SET_ID.test(setId)) return { ok: false, code: "invalid" };
    const b = view(setId);
    if (!b || b.state !== "open") return { ok: false, code: "expired" };
    if (busy.has(setId)) return { ok: false, code: "busy" };
    const desired = { setId, ...fields };
    let prior = pending.get(setId) || read(`pending:${setId}`);
    if (prior && (prior.setId !== setId || typeof prior.idempotencyKey !== "string" || intent(prior) !== intent(desired))) return { ok: false, code: "uncertain" };
    const body = prior || { ...desired, idempotencyKey: newKey() };
    pending.set(setId, body); write(`pending:${setId}`, body);
    busy.add(setId); notify();
    try {
      let result;
      try { result = await client.chooseButtons(roomId, body); } catch { result = { ok: false, status: 0, code: "unreachable" }; }
      if (stopped) return { ok: false, code: "stopped" };
      if (result.ok) {
        pending.delete(setId); write(`pending:${setId}`, null);
        if (Array.isArray(body.options)) { votes.set(setId, [...body.options]); write(`mine:${setId}`, body.options); }
        await refresh();
      } else if (result.status >= 400 && result.status < 500) {
        // A definitive refusal may be retried as a new intent. Unknown outcomes retain the SAME key and payload.
        pending.delete(setId); write(`pending:${setId}`, null);
      }
      return result;
    } finally { busy.delete(setId); notify(); }
  }
  function vote(setId, options) {
    const b = view(setId);
    if (!b?.poll || !indexes(options) || options.some(i => i >= b.labels.length) || !b.poll.multi && options.length !== 1) return Promise.resolve({ ok: false, code: "invalid" });
    return post(setId, { options: [...options].sort((a, b) => a - b) });
  }
  return {
    clickButton(setId, index) {
      const b = view(setId);
      if (!b || !Number.isInteger(index) || index < 0 || index >= b.labels.length) return Promise.resolve({ ok: false, code: "invalid" });
      if (!b.poll) return post(setId, { index });
      const before = mine(setId), next = b.poll.multi ? (before.includes(index) ? before.filter(i => i !== index) : [...before, index]) : [index];
      return vote(setId, next);
    },
    vote,
    busy: setId => busy.has(setId),
    mine,
    stop() { stopped = true; busy.clear(); },
  };
}
