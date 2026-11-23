// M-3533 R1 (docs/design/hub-office-visit.md §2): a group room's office — the room page's Office tab. The dashboard's
// own Office drawing (fleet-office.js, loaded with import() only: the Hub serves it as HUB_OFFICE_MODULES), fed the
// room's office state (GET /hub/v1/rooms/:id/office/state, share-shaped) every POLL_MS while shown, and nothing else:
// no stream of this page's own (on the Fleet dashboard that is the fleet's), no editing, no sharing, no levels, no
// skin packs, no words. Each agent says what the room's member list says (hub-room-presence.js), "answering in this
// room" the more specific form of 處理中; its card the agent's owner and introduction from the room's members.
import { html, useEffect, useMemo, useState } from "/assets/app-html.js";
import { createLease } from "/assets/app-ctx.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { hroom } from "./hub-room-strings.js";
import { presenceView } from "./hub-room-presence.js";

/** How often a shown office is read again (the share page's POLL_MS). */
export const ROOM_OFFICE_POLL_MS = 5000;
const STORAGE_PREFIX = "agend_hub_room_office:";

/** The Office drawing, loaded once on first use (the Hub serves it; a fleet page has it already). */
let drawing = null;
export const loadDrawing = () => (drawing ??= Promise.all([import("./fleet-office.js"), import("./fleet-org.js")])
  .then(([office, org]) => ({ Office: office.Office, buildOrgView: org.buildOrgView }))
  .catch((e) => { drawing = null; throw e; }));

/** The state's agents as the app store's status frame (office-share-page.js appFromState): the drawing's input. */
export function officeApp(d) {
  const instances = Array.isArray(d && d.instances) ? d.instances.filter((i) => i && typeof i.name === "string") : [];
  const exec = {};
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
 * it): a room's agents are named by what members see — the room assistant by the room's word for it, two agents of one
 * name told apart with (2) — and keep their member id as `member` (their card and words read it).
 */
export function named(d) {
  const taken = new Set(), rename = new Map();
  const instances = (Array.isArray(d && d.instances) ? d.instances : []).filter((i) => i && typeof i.name === "string").map((i) => {
    const base = i.assistant ? hroom("roomAssistant") : String(i.display_name || "").trim() || "?";
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base} (${n})`;
    taken.add(label); rename.set(i.name, label);
    return { ...i, name: label, display_name: label, member: i.name };
  });
  const offices = d && d.offices && Array.isArray(d.offices.offices)
    ? { ...d.offices, offices: d.offices.offices.map((o) => ({ ...o, members: (Array.isArray(o.members) ? o.members : []).map((m) => rename.get(m) ?? m) })) } : d?.offices;
  return { ...d, instances, offices };
}

export function RoomOffice({ client, roomId, members, timers = globalThis, pollMs = ROOM_OFFICE_POLL_MS }) {
  const [phase, setPhase] = useState("loading");      // loading | live | failed | off
  const [d, setD] = useState(null);
  const [kit, setKit] = useState(null);
  const [attempt, setAttempt] = useState(0);
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
    loadDrawing().then((k) => { if (!stopped) setKit(k); }, () => { if (!stopped) setPhase("failed"); });
    const read = async () => {
      const r = await client.roomOfficeState(roomId);
      if (stopped || !lease.current()) return;
      if (r && r.ok) { const next = named(r); holder.d = next; setD(next); setPhase("live"); return; }
      if (r && r.status === 409 && r.code === "office-off") { setPhase("off"); return; }
      // A read that fails while the office is shown keeps the last picture; only a first read that fails says so.
      setPhase((p) => (p === "live" ? p : "failed"));
    };
    void read();
    const h = lease.interval(() => { if (!stopped && !globalThis.document?.hidden) void read(); }, pollMs);
    return () => { stopped = true; lease.clear(h); };
  }, [lease, attempt]);
  const view = useMemo(() => (kit && d ? kit.buildOrgView(d.org, officeApp(d)) : null), [kit, d]);
  if (phase === "off") return html`<div class="hub-room-office hub-room-office-note"><p class="note" role="status">${hroom("officeOff")}</p></div>`;
  if (phase === "failed" && !view) return html`<div class="hub-room-office hub-room-office-note">
    <${ErrorState} message=${hroom("officeFailed")} onRetry=${() => { setPhase("loading"); setAttempt((n) => n + 1); }} /></div>`;
  if (!view) return html`<div class="hub-room-office hub-room-office-loading"><${Skeleton} variant="cards" lines=${3} label=${hroom("officeLoading")} /></div>`;
  const { Office } = kit;
  return html`<div class="hub-room-office" data-trust="panel-content">
    <${Office} view=${view} traffic=${[]} lease=${lease} opening="room" talk=${{ now: Date.now(), items: [] }}
      oneOffice=${true} readOnly=${true} stream=${false} storage=${storage} words=${(node) => officeWords(node, members)}
      cardRows=${(name) => officeCardRows(members, d.instances.find((i) => i.name === name)?.member)} />
  </div>`;
}
