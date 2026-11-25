// M-3533 R1 (docs/design/hub-office-visit.md §2): a group room's office — the room page's Office tab. The dashboard's
// own Office drawing (fleet-office.js, loaded with import() only: the Hub serves it as HUB_OFFICE_MODULES), fed the
// room's office state (GET /hub/v1/rooms/:id/office/state, share-shaped) every POLL_MS while shown, and nothing else:
// no stream of this page's own (on the Fleet dashboard that is the fleet's), no editing, no sharing, no levels, no
// skin packs, no words. Each agent says what the room's member list says (hub-room-presence.js), "answering in this
// room" the more specific form of 處理中; its card the agent's owner and introduction from the room's members.
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { lang } from "/assets/app-i18n.js";
import { createLease } from "/assets/app-ctx.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { hroom } from "./hub-room-strings.js";
import { agentCharacterSrc, agentPictureSrc, presenceView } from "./hub-room-presence.js";

/** How often a shown office is read again (the share page's POLL_MS). */
export const ROOM_OFFICE_POLL_MS = 5000;
/** Reads in a row that fail while the office is shown before it says the picture may be old (one or two misses: silent). */
export const ROOM_OFFICE_STALE_AFTER = 3;
/** A label longer than this (an agent's name with its owner's) takes the owner's first word instead. */
const LABEL_MAX = 24;
/**
 * A figure's name is also its key in the drawing's office (fleet-office-model.js nameList keeps names of at most 200 code
 * units): an agent's name (up to 256 on the Hub) is cut to NAME_MAX characters, a label with its owner to KEY_MAX, with
 * "…" — a name that long cannot be read on the scene anyway; the member list still says it in full.
 */
const NAME_MAX = 48, KEY_MAX = 64;
/**
 * A name the drawing reads as something else — "team:…" (a team, or NOBODY), an Object.prototype key ("__proto__",
 * "constructor"…), a control character (LOBBY) — keyed with an invisible word joiner in front: the same to read, never
 * the same key (#4355 review).
 */
const RESERVED = (name) => name.startsWith("team:") || Object.prototype.hasOwnProperty.call(Object.prototype, name) || /[\u0000-\u001f]/.test(name);
const safeKey = (name) => (RESERVED(name) ? `\u2060${name}` : name);
const clip = (text, n) => { const c = [...text]; return c.length > n ? `${c.slice(0, n - 1).join("")}…` : text; };
const STORAGE_PREFIX = "agend_hub_room_office:";

/**
 * M-3533 R2c: an agent's own character in a room office is fitted into the built-in figure's box (fleet-office-skin.js
 * charBox: 48 × 66), kept in proportion, never larger — one scale for everyone in the room (Lumen's choice, B, over the
 * pack's own scale: at 64 × 96 a robot stood twice a figure's height and crossed its area's edge and name). Its feet stay
 * on the seat, as a figure's. Drawn unsmoothed, as the Fleet office draws every strip.
 */
export const CHARACTER_FIT = { w: 48, h: 66 };
/**
 * An agent's character as the drawing takes it (a checked pack's strips, fleet-office-pack.js), its pictures at `src(pose,
 * hash)`, each fitted into CHARACTER_FIT; null when it has none or a strip is not a well-formed one.
 */
export function characterSet(character, src) {
  if (!character || typeof character !== "object") return null;
  const out = {};
  for (const [pose, st] of Object.entries(character)) {
    const url = st && src(pose, st.sha256);
    const nums = st && ["frames", "w", "h", "fps", "ax", "ay", "dw", "dh"].every((k) => typeof st[k] === "number" && Number.isFinite(st[k]));
    if (!url || !nums || !(st.frames >= 1 && st.dw > 0 && st.dh > 0)) return null;
    const k = Math.min(1, CHARACTER_FIT.w / st.dw, CHARACTER_FIT.h / st.dh);
    out[pose] = { src: url, frames: st.frames, w: st.w, h: st.h, fps: st.fps, ax: st.ax, ay: st.ay, dw: st.dw * k, dh: st.dh * k,
      ...(Array.isArray(st.durations) ? { durations: st.durations } : {}), ...(st.once === true ? { once: true } : {}), ...(typeof st.loopFrom === "number" ? { loopFrom: st.loopFrom } : {}) };
  }
  return Object.keys(out).length ? out : null;
}
/** A picture loaded for the drawing (an Image once it has loaded; null if it fails). */
const loadImage = (url) => new Promise((resolve) => {
  if (typeof Image !== "function") { resolve(null); return; }
  const im = new Image();
  im.onload = () => resolve(im); im.onerror = () => resolve(null);
  im.src = url;
});

/**
 * M-3533 R2c: the room's agents' own characters, each drawn only once all its pictures have loaded (an agent is drawn wholly
 * with its set or wholly as the figure). `instances` the drawing's (named), `load` an image loader (tests).
 */
export function useCharacters(roomId, instances, load = loadImage) {
  const [images, setImages] = useState(() => new Map());
  const wanted = useMemo(() => {
    const sets = new Map();
    for (const i of Array.isArray(instances) ? instances : []) {
      const set = i && i.member ? characterSet(i.character, (pose, hash) => agentCharacterSrc(roomId, i.member, pose, hash)) : null;
      if (set) sets.set(i.name, set);
    }
    return sets;
  }, [roomId, instances]);
  const urls = useMemo(() => [...new Set([...wanted.values()].flatMap((set) => Object.values(set).map((st) => st.src)))].sort(), [wanted]);
  useEffect(() => {
    let live = true;
    const missing = urls.filter((u) => !images.has(u));
    for (const u of missing) load(u).then((im) => { if (live) setImages((m) => new Map(m).set(u, im)); });
    return () => { live = false; };
  }, [urls.join("\n")]);
  // Each read of the room makes new objects: the drawing gets a new skin only when the characters themselves change.
  const sig = JSON.stringify([...wanted]);
  return useMemo(() => {
    const sets = Object.create(null), ready = new Map();
    for (const [name, set] of wanted) {
      const strips = Object.values(set);
      if (!strips.every((st) => images.get(st.src))) continue;
      sets[name] = set;
      for (const st of strips) ready.set(st.src, images.get(st.src));
    }
    return Object.keys(sets).length ? { sets, images: ready } : null;
  }, [sig, images]);
}

/** The Office drawing, loaded once on first use (the Hub serves it; a fleet page has it already). */
let drawing = null;
export const loadDrawing = () => (drawing ??= Promise.all([import("./fleet-office.js"), import("./fleet-org.js")])
  .then(([office, org]) => ({ Office: office.Office, buildOrgView: org.buildOrgView }))
  .catch((e) => { drawing = null; throw e; }));

/** The state's agents as the app store's status frame (office-share-page.js appFromState): the drawing's input. */
export function officeApp(d) {
  const instances = Array.isArray(d && d.instances) ? d.instances.filter((i) => i && typeof i.name === "string") : [];
  const exec = Object.create(null);
  for (const i of instances) exec[i.name] = i.execution_state ?? null;
  return { ready: true, instances, exec, awaiting: {}, needs: [], connection: "polling" };
}

/**
 * The drawing's reads, answered here from the room's state (`now()`): its one office, no acts, no skin packs; anything
 * else (levels, a pack, a save) is not this page's to answer.
 */
export function officeReads(now) {
  const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  return (path, opts = {}) => {
    const p = String(path), method = String(opts.method || "GET").toUpperCase();
    if (method !== "GET") return Promise.resolve(new Response("", { status: 404 }));
    if (p === "/ui/offices") return json(now()?.offices ?? { rev: 0, readable: true, offices: [] });
    if (p === "/ui/office-acts") return json({ acts: [], now: Date.now() });
    if (p === "/ui/office-skins") return json({ rev: "", packs: [] });
    return Promise.resolve(new Response("", { status: 404 }));
  };
}

/** This browser's choices for rooms' offices (zoom, the checkboxes), apart from the Fleet office's. */
export function roomOfficeStorage(base = (() => { try { return globalThis.localStorage || null; } catch { return null; } })()) {
  if (!base) return undefined;
  return {
    getItem: (k) => { try { return base.getItem(STORAGE_PREFIX + k); } catch { return null; } },
    setItem: (k, v) => { try { base.setItem(STORAGE_PREFIX + k, v); } catch { /* this page only */ } },
    removeItem: (k) => { try { base.removeItem(STORAGE_PREFIX + k); } catch { /* this page only */ } },
  };
}

/**
 * An agent's state in the member list's own words (presenceView: its reason too, while the list says the same presence),
 * and "answering in this room" as what it is doing now.
 */
export function officeWords(node, members) {
  const i = node && node.i;
  if (!i) return { state: hroom("stOffline"), now: "" };
  const kind = i.assistant ? "assistant" : "agent", presence = i.presence || "offline";
  const listed = (Array.isArray(members) ? members : []).find((m) => m && (kind === "assistant" ? m.kind === "assistant" : m.kind === "agent" && m.id === i.member));
  const v = presenceView(listed && listed.presence === presence ? listed : { kind, presence });
  // Answering here is the more specific 處理中: the member list's working word, and what it is doing now.
  return { state: hroom(i.answering ? "stWorking" : v.word), now: i.answering ? hroom("answeringHere") : "" };
}

/** A card's rows: the agent's owner and introduction, from the room's members (the assistant: provided by the Hub). */
export function officeCardRows(members, id) {
  if (id === "assistant") return [{ key: "owner", label: hroom("cardOwner"), value: hroom("providedByHub") }];
  const m = (Array.isArray(members) ? members : []).find((x) => x && x.kind === "agent" && x.id === id);
  if (!m) return [];
  return [{ key: "owner", label: hroom("cardOwner"), value: String(m.owner?.name || "") }, { key: "intro", label: hroom("cardIntro"), value: String(m.intro || "") }];
}

/**
 * The drawing names people by their instance name (and shows it beside a display name, or first when the viewer prefers
 * it): a room's agents are named by what members see — the room assistant by the room's word for it; agents sharing a
 * name told apart by their owner, as the member list's second line does (「Atlas（Alex Sample）」, the owner's first word
 * when that is too long) — and keep their member id as `member` (their card and words read it).
 */
export function named(d, members = []) {
  const list = (Array.isArray(d && d.instances) ? d.instances : []).filter((i) => i && typeof i.name === "string");
  const base = (i) => clip(i.assistant ? hroom("roomAssistant") : String(i.display_name || "").trim() || "?", NAME_MAX);
  const count = new Map();
  for (const i of list) count.set(base(i), (count.get(base(i)) || 0) + 1);
  const owners = new Map((Array.isArray(members) ? members : []).filter((m) => m && m.kind === "agent").map((m) => [m.id, String(m.owner?.name || "").trim()]));
  const [open, close] = lang() === "zh-TW" ? ["（", "）"] : [" (", ")"];
  const taken = new Set(), rename = new Map();
  const instances = list.map((i) => {
    const b = base(i), owner = owners.get(i.name) || "";
    let label = b, fit = i.assistant ? { short: hroom("roomAssistantTag") } : null;
    if (count.get(b) > 1 && owner) {
      label = `${b}${open}${owner}${close}`;
      if ([...label].length > LABEL_MAX) label = `${b}${open}${owner.split(/\s+/)[0]}${close}`;
      label = clip(label, KEY_MAX);
      // The owner part, for the drawing's tag: too narrow for both, it keeps the owner and cuts the name — the owner is
      // what tells the two agents apart (fleet-office-skin.js fitText, #4379 review). The room assistant's tag has a
      // shorter word for a narrow tag ("Assistant").
      const who = label.endsWith(close) ? label.slice(b.length + open.length, -close.length) : "";
      if (who && label === `${b}${open}${who}${close}`) fit = { owner: [open, who, close] };
    }
    label = safeKey(label);
    for (let n = 2, at = label; taken.has(label); n++) label = `${at} ${n}`;
    taken.add(label); rename.set(i.name, label);
    return { ...i, name: label, display_name: label, member: i.name, plain: b, ...(fit ? { tag_fit: fit } : {}) };
  });
  const offices = d && d.offices && Array.isArray(d.offices.offices)
    ? { ...d.offices, offices: d.offices.offices.map((o) => ({ ...o, members: (Array.isArray(o.members) ? o.members : []).map((m) => rename.get(m) ?? m) })) } : d?.offices;
  return { ...d, instances, offices };
}

/**
 * `members` the room's (its detail's: owner, introduction, the list's states); `onMention(member)` the card's "@ it" (the
 * page switches to Chat with the mention in the box); `more` / `onMore` a phone's options sheet, opened from the room's ⋯.
 */
export function RoomOffice({ client, roomId, members, onMention = null, onOpenChat = null, more = false, onMore = null, timers = globalThis, pollMs = ROOM_OFFICE_POLL_MS, load = loadDrawing }) {
  const [phase, setPhase] = useState("loading");      // loading | live | failed | off
  const [d, setD] = useState(null);
  const [kit, setKit] = useState(null);
  const [attempt, setAttempt] = useState(0);
  // The drawing's modules failing to load is not the room's state failing to read: a good read must not hide it.
  const [kitFailed, setKitFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const misses = useRef(0);
  const holder = useMemo(() => ({ d: null }), [roomId]);
  const lease = useMemo(() => {
    const reads = officeReads(() => holder.d);
    return createLease({
      setTimeout: (...a) => timers.setTimeout(...a), clearTimeout: (h) => timers.clearTimeout(h),
      setInterval: (...a) => timers.setInterval(...a), clearInterval: (h) => timers.clearInterval(h),
      fetch: (path, opts) => reads(path, opts),
    });
  }, [roomId, holder]);
  useEffect(() => () => lease.dispose(), [lease]);
  const storage = useMemo(() => roomOfficeStorage(), []);
  useEffect(() => {
    let stopped = false;
    if (!kit) load().then((k) => { if (!stopped) { setKit(k); setKitFailed(false); } }, () => { if (!stopped) setKitFailed(true); });
    const read = async () => {
      const r = await client.roomOfficeState(roomId);
      if (stopped || !lease.current()) return;
      if (r && r.ok) { misses.current = 0; setStale(false); setD(r); setPhase("live"); return; }
      if (r && r.status === 409 && r.code === "office-off") { setPhase("off"); return; }
      // A read that fails while the office is shown keeps the last picture; ROOM_OFFICE_STALE_AFTER in a row say it may
      // be old (people shown 處理中 minutes ago). A first read that fails says so at once.
      if (++misses.current >= ROOM_OFFICE_STALE_AFTER) setStale(true);
      setPhase((p) => (p === "live" ? p : "failed"));
    };
    void read();
    const h = lease.interval(() => { if (!stopped && !globalThis.document?.hidden) void read(); }, pollMs);
    return () => { stopped = true; lease.clear(h); };
  }, [lease, attempt]);
  const shown = useMemo(() => (d ? named(d, members) : null), [d, members]);
  holder.d = shown;
  const characters = useCharacters(roomId, shown?.instances);
  const view = useMemo(() => (kit && shown ? kit.buildOrgView(shown.org, officeApp(shown)) : null), [kit, shown]);
  const memberOf = (name) => {
    const id = shown?.instances.find((i) => i.name === name)?.member;
    return (Array.isArray(members) ? members : []).find((m) => m && (id === "assistant" ? m.kind === "assistant" : m.kind === "agent" && m.id === id)) || null;
  };
  if (phase === "off") return html`<div class="hub-room-office hub-room-office-note"><p class="note" role="status">${hroom("officeOff")}</p></div>`;
  if ((phase === "failed" || kitFailed) && !view) return html`<div class="hub-room-office hub-room-office-note">
    <${ErrorState} message=${hroom("officeFailed")} onRetry=${() => { setPhase("loading"); setKitFailed(false); setAttempt((n) => n + 1); }} /></div>`;
  if (!view) return html`<div class="hub-room-office hub-room-office-loading"><${Skeleton} variant="cards" lines=${3} label=${hroom("officeLoading")} /></div>`;
  const { Office } = kit;
  return html`<div class="hub-room-office" data-trust="panel-content">
    ${stale ? html`<p class="note hub-room-office-stale" role="status">${hroom("officeStale")}</p>` : null}
    <${Office} view=${view} traffic=${[]} lease=${lease} opening="room" talk=${{ now: Date.now(), items: [] }}
      oneOffice=${true} readOnly=${true} stream=${false} storage=${storage} words=${(node) => officeWords(node, members)}
      cardRows=${(name) => officeCardRows(members, shown.instances.find((i) => i.name === name)?.member)}
      cardName=${(name) => shown.instances.find((i) => i.name === name)?.plain || ""}
      cardAction=${onMention || onOpenChat ? (name) => { const m = memberOf(name); if (!m) return null;
        // M-3565: the member card's 「和它一對一對話」 too, when this viewer may ask the agent (as there: canAsk).
        const acts = [...(onMention ? [{ label: hroom("mentionIt"), title: hroom("mentionItTitle", name), run: () => onMention(m) }] : []),
          // The card's row beside "Find in office" and "@ it" is narrow: a short label; the whole words its title and name.
          ...(onOpenChat && m.canAsk === true ? [{ label: hroom("chatOneToOneShort"), title: hroom("chatOneToOne"), run: () => onOpenChat(m) }] : [])];
        return acts.length > 1 ? acts : acts[0] || null; } : null}
      cardPhoto=${(name) => { const i = shown.instances.find((x) => x.name === name); return i?.member ? agentPictureSrc(roomId, i.member, "portrait", i.picture?.portrait) : null; }}
      foldBar=${true} more=${more} onMore=${onMore} characters=${characters} officesKey=${`${shown.offices?.offices?.[0]?.skin ?? ""}\n${shown.offices?.offices?.[0]?.members?.join("\n") ?? ""}`} />
  </div>`;
}
