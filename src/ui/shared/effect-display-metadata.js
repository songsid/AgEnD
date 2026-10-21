/** #1629: closed host display metadata. Neither this object nor its token grants a trial read. */
const KEYS = ["v", "offer", "id", "title", "expiresAt"], ID = /^[0-9a-f]{32}$/;
const FORBIDDEN = /(?!\u200d)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const VISIBLE = /[^\p{M}\p{C}\p{Z}\u115f\u1160\u3164\uffa0\u2800]/u;
let graphemes = null;
export function checkEffectTrialOffer(value) {
  try {
    if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== KEYS.length || keys.some(k => typeof k !== "string" || !KEYS.includes(k))) return null;
    const x = Object.create(null);
    for (const key of KEYS) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !("value" in d) || !d.enumerable) return null;
      x[key] = d.value;
    }
    if (x.v !== 1 || typeof x.offer !== "string" || !ID.test(x.offer) || typeof x.id !== "string" || !ID.test(x.id)
      || typeof x.title !== "string" || x.title.length > 400 || x.title.normalize("NFC") !== x.title || x.title.trim() !== x.title
      || FORBIDDEN.test(x.title) || !VISIBLE.test(x.title) || !Number.isSafeInteger(x.expiresAt) || x.expiresAt < 0) return null;
    graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let count = 0; for (const _part of graphemes.segment(x.title)) if (++count > 40) return null;
    if (count < 1) return null;
    return Object.freeze({ v: 1, offer: x.offer, id: x.id, title: x.title, expiresAt: x.expiresAt });
  } catch { return null; }
}
/** Role and sender are host fields, never inferred from a message's text. Start must separately authorize. */
export function effectTrialMessage(message) {
  if (!message || message.role !== "status" || message.sender !== "agend" || typeof message.instance !== "string"
    || message.instance.length < 1 || message.instance.length > 128) return null;
  return checkEffectTrialOffer(message.effectTrial);
}

export function chatEffectIdentity(host) {
  try {
    const b = host.document.body.dataset, x = JSON.parse(host.document.documentElement.getAttribute("data-prefs") || "null");
    if (b.mode !== "full" || b.tier === "guest" || b.publicLink === "1" || b.webTransport === "poll" || !["person", "operator"].includes(x?.ownerScope) || x.unreadable === true || typeof x.ownerEpoch !== "string" || !/^[a-f0-9]{16}$/.test(x.ownerEpoch)) return null;
    return Object.freeze({ epoch: x.ownerEpoch, scope: x.ownerScope });
  } catch { return null; }
}
