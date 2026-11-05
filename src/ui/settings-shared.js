// Settings → Shared agent settings (the section id stays `agent-defaults`; its address and every `#g-…` anchor are unchanged):
// the page's parts. The form, its draft and its staging stay in General (panel-settings.js) — ClassicBot's defaults share
// them — and this file draws the fleet's half and does the arithmetic behind it:
// - which agents set a field themselves (the "N/M in use" pill and its list), from fleet.yaml's instances — item by item for
//   a field of several items (the dashboard's features), so an agent that sets only some of them is "partly custom";
// - what saving an edited field costs, in words, from the schema (`impactOf`), shown under the field only once it is
//   edited and gone again when it is put back — never as a badge that is always there. The agents are fleet.yaml's
//   instances; the ClassicBot rooms that follow the value are counted beside them (the fleet restarts those too);
// - the same costs added up for the Save bar.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { settingsPath } from "/assets/app-route.js";
import "./settings-strings.js";
import "./settings-shared-strings.js";   // the words this page added: a tab that already ran an older settings-strings.js has none of them (#3087)
import {
  AGENT_MODES, DASHBOARD_FEATURES, LOG_LEVELS, SEPARATE_FEATURE_KEYS, TOOL_PROGRESS, TOOL_SETS, VISIBILITY_MODES,
  channelsOf, chLabel, hasOwn, impactOf, localeOptions, sameValue, shortName, toolSetDefault,
} from "./settings-model.js";
import { BackendSelect, ChipList, DefaultMark, Drawer, Feedback, InEffect, ModelSelect, Select } from "./settings-dialogs.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const label = (kind, v) => { const key = `opt_${kind}_${v}`; const s = tn(key); return s === key ? v : s; };   // t() hands back the key for a string it lacks

/** Option objects for a fixed list, each with its plain-words label (settings.opt_<kind>_<value>); an unknown value stays as it is. */
export const plainOptions = (kind, values) => values.map((v) => ({ value: v, label: label(kind, v) }));

// ── Which agents set a field themselves ──
/** The agents of a fleet's configuration: [name, its own settings]. General and every other instance count — each one inherits like any other. */
export const agentsOf = (fleet) => Object.entries((fleet && fleet.instances) || {});
/** A key with a value: `null` / `undefined` is the same as no key (the agent follows the default). */
const given = (obj, key) => hasOwn(obj, key) && obj[key] != null;
/**
 * An agent has set one dashboard feature itself: its own key beside `dashboard` (office, office packs), or the feature under
 * `dashboard` (where the older files kept all five), with a value. The fleet merges the features one by one
 * (dashboard-permissions.ts dashboardFeaturesOffIn), so setting one leaves the others following the defaults.
 */
export function ownsDashboardFeature(inst, feature) {
  const key = hasOwn(SEPARATE_FEATURE_KEYS, feature) ? SEPARATE_FEATURE_KEYS[feature] : null;
  const dash = inst && inst.dashboard;
  return (!!key && given(inst, key)) || (!!dash && typeof dash === "object" && !Array.isArray(dash) && given(dash, feature));
}
/** An agent's own `a` or `a.b`, with a value (the hang detector's two settings are merged one by one: setting the timeout leaves `enabled` inherited). */
const ownsPath = (inst, path) => {
  const [a, b] = path.split(".");
  return b ? given((inst && inst[a]) || {}, b) : given(inst, a);
};

/**
 * One entry per field the page draws, by the form key it is called in General's form:
 * `keys` — the form keys it edits (it is "edited" while one differs from what is saved);
 * `path` — its entry in the impact schema (what saving it costs);
 * `own` — the agent setting that overrides it (an agent that has it is not affected by an edit here); none: agents cannot;
 * `parts` — a field of several settings that agents override one by one: each part's keys and own settings (an edit to one part
 *   reaches the agents that do not set that part, however the other parts stand); `label` names a part where it is listed;
 * `room` — the ClassicBot setting that follows this one: a room restarts for an edit here when neither the room nor
 *   ClassicBot's defaults set it (ClassicChannelManager's own → defaults → fleet chain), only for the settings the fleet's
 *   reconciliation compares (backend, model, auto-pause: `Classic cold config changed`; the rest is hot or read at the next start);
 * `agentGroup` — it is one of the "Shared agent settings" (individual agents may override it), else of "System & channels";
 * `confirm` — saving it asks for someone's OK first.
 */
export const FIELDS = Object.freeze({
  backend: { keys: ["backend"], path: "defaults.backend", own: ["backend"], room: "backend", agentGroup: true },
  model: { keys: ["model"], path: "defaults.model", own: ["model"], room: "model", agentGroup: true },
  auto: { keys: ["auto"], path: "defaults.auto_pause_after", own: ["auto_pause_after"], room: "auto_pause_after", agentGroup: true },
  tool_progress: { keys: ["tool_progress"], path: "defaults.tool_progress", own: ["tool_progress"], agentGroup: true },
  visibility: { keys: ["visibility"], path: "defaults.cross_instance_visibility", own: ["cross_instance_visibility"], agentGroup: true },
  reply: { keys: ["reply"], path: "defaults.reply_completion_guard", own: ["reply_completion_guard"], agentGroup: true },
  replyTriggers: { keys: ["replyTriggers"], path: "defaults.reply_triggers", own: ["reply_triggers"], agentGroup: true },
  tool_set: { keys: ["tool_set"], path: "defaults.tool_set", own: ["tool_set"], agentGroup: true },
  agent_mode: { keys: ["agent_mode"], path: "defaults.agent_mode", own: ["agent_mode"], agentGroup: true },
  log_level: { keys: ["log_level"], path: "defaults.log_level", own: ["log_level"], agentGroup: true },
  // One part per feature: an agent that sets the office switch still follows the others (a change to the appearance reaches it).
  dash: { keys: DASHBOARD_FEATURES.map((k) => `dash_${k}`), path: "defaults.dashboard", agentGroup: true,
    parts: DASHBOARD_FEATURES.map((k) => ({ keys: [`dash_${k}`], owns: (inst) => ownsDashboardFeature(inst, k), label: `dashboardShort_${k}` })) },
  locale: { keys: ["locale"], path: "defaults.locale" },
  tips: { keys: ["tips"], path: "defaults.tips" },
  roots: { keys: ["roots"], path: "fleet.project_roots", confirm: "noteConfirmAdmin" },
  hang: { keys: ["hangOn", "hang"], path: "defaults.hang_detector",
    parts: [{ keys: ["hangOn"], own: ["hang_detector.enabled"] }, { keys: ["hang"], own: ["hang_detector.timeout_minutes"] }] },
  concurrency: { keys: ["concurrency"], path: "fleet.spawn_concurrency" },
  stagger: { keys: ["stagger"], path: "fleet.spawn_stagger_ms" },
});
/** How many fields the Advanced drawer holds (the title says so). */
export const ADVANCED_COUNT = 10;

/** The parts of a field that agents override one by one (one part: the field itself). */
const partsOf = (spec) => spec.parts || [{ keys: spec.keys, own: spec.own, owns: spec.owns }];
const ownsPart = (part, inst) => (part.owns ? part.owns(inst) : (part.own || []).some((path) => ownsPath(inst, path)));
/**
 * The agents that set a field themselves, and how many there are. Fields agents cannot override have none. `parts`: only
 * these parts count — an agent is left out of an edit only when it sets every one of them (default: all of the field's).
 * A field of several parts also says who sets only some of them (`partial`: they follow this page for the rest) and who
 * sets each part (`byPart`, for the list under the pill).
 */
export function usageOf(fleet, field, parts = partsOf(FIELDS[field])) {
  const agents = agentsOf(fleet);
  const who = (name, inst) => ({ name, label: shortName(name, inst) });
  const owners = agents.filter(([, inst]) => parts.every((part) => ownsPart(part, inst))).map(([name, inst]) => who(name, inst));
  const partial = parts.length > 1 ? agents.filter(([, inst]) => parts.some((part) => ownsPart(part, inst)) && !parts.every((part) => ownsPart(part, inst))).map(([name, inst]) => who(name, inst)) : [];
  const byPart = parts.length > 1 ? parts.map((part) => ({ label: part.label, owners: agents.filter(([, inst]) => ownsPart(part, inst)).map(([name, inst]) => who(name, inst)) })) : [];
  return { total: agents.length, owners, partial, byPart, names: agents.map(([name]) => name) };
}
// ── Which ClassicBot rooms follow a field ──
/** The ClassicBot rooms of classicBot.yaml: [key, room]. */
export const roomsOf = (classic) => Object.entries((classic && classic.channels) || {}).filter(([, room]) => room && typeof room === "object");
/** ClassicChannelManager reads a room's backend and model with `||` (an empty value follows), its auto-pause with `??`. */
const roomGiven = (obj, key) => (key === "auto_pause_after" ? obj != null && obj[key] != null : !!obj && !!obj[key]);
/**
 * The rooms that take this page's value for `field`: those that neither set it themselves nor have it in ClassicBot's
 * defaults (room → ClassicBot defaults → the fleet's: ClassicChannelManager.getBackend / getModel / getAutoPauseAfter).
 * Fields the fleet's reconciliation leaves alone (it compares only backend, model and auto-pause) have none.
 */
export function roomsFollowing(classic, field) {
  const key = FIELDS[field].room;
  if (!key) return [];
  const defaults = (classic && classic.defaults) || {};
  if (roomGiven(defaults, key)) return [];
  return roomsOf(classic).filter(([, room]) => !roomGiven(room, key)).map(([k, room]) => ({ key: k, instanceName: room.instanceName }));
}
const NAMES_SHOWN = 5;
/** A list of agent names for a sentence: the first few, then how many more. */
export const nameList = (names) => (names.length > NAMES_SHOWN ? `${names.slice(0, NAMES_SHOWN).join(", ")} +${names.length - NAMES_SHOWN}` : names.join(", "));

// ── What an edit costs ──
const edited = (f, base, field) => FIELDS[field].keys.some((k) => !sameValue(f[k], base[k]));
/**
 * What saving the edited fields costs, as notes: `fields` — per field, its notes (`{ text }` each); `bar` — the same added
 * up for the Save bar, one line per kind of cost (an agent restarted by two fields counted once), for the write of the
 * defaults (`bar.defaults`) and for the project folders' own (`bar.roots`). A field that applies at once has no note;
 * an invalid one has none yet. Besides the agents of fleet.yaml, the ClassicBot rooms that follow the value (`classic`: what
 * classicBot.yaml says; `classicStatus(instanceName)`: a room's status) are named — the fleet restarts a running one too.
 */
export function sharedNotes({ schema, fleet, classic, classicStatus = () => "stopped", live = {}, fleetUp = true, f, base, errors = {} }) {
  const fields = {}, hit = new Set(), hitRooms = new Map(), bar = { defaults: [], roots: [] };
  // Whether an agent restarts when a setting that is not hot changes: one that is running, and one that crashed (the fleet
  // restarts a crash-looping daemon too); a paused or stopped one just takes the value at its next start. When the page
  // could not read the agents' state (the fleet did not answer, or listed none) it cannot tell: every agent counts as restarting.
  const known = fleetUp !== false && !!live && Object.keys(live).length > 0;
  // A Windows agent that runs one command at a time (not a persistent terminal) has no process of its own: it takes a changed default at its next run.
  const oneShot = (name) => { const inst = fleet && fleet.instances && fleet.instances[name]; return !!inst && inst.runtime === "windows" && inst.native_adapter !== "pane"; };
  const restarts = (name) => !oneShot(name) && (!known || (!!live[name] && (live[name].status === "running" || live[name].status === "crashed")));
  // A ClassicBot room restarts on the same terms (the reconciliation restarts the ones that have a daemon). A room of the older
  // classicBot.yaml format (its key is the channel id) has no `instanceName` in the file — the manager makes one up when it loads —
  // so its state cannot be looked up here: like an unreadable state, it counts as restarting.
  const roomRestarts = (room) => !known || !room.instanceName || ["running", "crashed"].includes(classicStatus(room.instanceName));
  const roomsText = (rooms, kind) => { const n = rooms.filter(roomRestarts).length; return n === rooms.length ? tn(`${kind}RestartRooms`, rooms.length) : n ? tn(`${kind}ApplyRooms`, rooms.length, n) : tn(`${kind}IdleRooms`, rooms.length); };
  let fleetRestart = false;
  const add = (list, text) => { if (!list.includes(text)) list.push(text); };
  for (const [field, spec] of Object.entries(FIELDS)) {
    if (!edited(f, base, field) || errors[field]) continue;
    const notes = [], kind = impactOf(schema, spec.path);
    // The ClassicBot rooms that follow it. A room has its own idea of "hot" (a ClassicBot channel takes tool progress and the reply
    // guard at once, nothing else): auto-pause applies at once to an agent but restarts a room, so this does not depend on `kind`.
    // A fleet restart (`kind` "fleet") restarts them with everything else.
    const rooms = kind !== "fleet" && spec.room && impactOf(schema, `classic.${spec.room}`) === "instance" ? roomsFollowing(classic, field) : [];
    for (const room of rooms) hitRooms.set(room.key, room);
    if (kind === "fleet") { notes.push({ text: tn("noteRestartFleet") }); fleetRestart = true; }
    else if (kind === "instance") {
      // Only the parts that were edited count: an agent is left alone when it sets all of them itself.
      const u = usageOf(fleet, field, partsOf(spec).filter((part) => part.keys.some((k) => !sameValue(f[k], base[k]))));
      const skipped = u.owners.map((o) => o.label), skippedNames = new Set(u.owners.map((o) => o.name));
      const reached = u.names.filter((n) => !skippedNames.has(n));
      for (const n of reached) hit.add(n);
      // Every agent without its own value takes the new one (a stopped agent at its next start), but only a running one restarts.
      const restarting = reached.filter(restarts).length;
      const main = restarting === reached.length ? tn("noteRestartAgents", reached.length)
        : restarting ? tn("noteApplyAgents", reached.length, restarting) : tn("noteApplyIdle", reached.length);
      // With only rooms, "No agents yet — agents you create later start with this value" would read as if nothing is affected.
      if (!(u.total === 0 && rooms.length)) notes.push({ text: u.total === 0 ? tn("noteNoAgents") : !reached.length ? tn("noteAllOverride") : `${main}${skipped.length ? tn("noteSkip", nameList(skipped)) : ""}` });
    }
    if (rooms.length) notes.push({ text: roomsText(rooms, "note") });
    if (spec.confirm) { notes.push({ text: tn(spec.confirm) }); add(field === "roots" ? bar.roots : bar.defaults, tn(spec.confirm)); }
    // Ticking a dashboard feature on is confirmed first (unticking applies at once): only a feature newly ticked asks.
    if (field === "dash" && DASHBOARD_FEATURES.some((k) => f[`dash_${k}`] === true && base[`dash_${k}`] !== true)) {
      notes.push({ text: tn("noteConfirmTick") }); add(bar.defaults, tn("noteConfirmTick"));
    }
    if (notes.length) fields[field] = notes;
  }
  const lead = [];
  if (hit.size) {
    const restarting = [...hit].filter(restarts).length;
    lead.push(restarting === hit.size ? tn("barRestartAgents", hit.size) : restarting ? tn("barApplyAgents", hit.size, restarting) : tn("barApplyIdle", hit.size));
  }
  if (hitRooms.size) lead.push(roomsText([...hitRooms.values()], "bar"));
  bar.defaults.unshift(...lead);
  if (fleetRestart) add(bar.defaults, tn("barRestartFleet"));
  return { fields, bar };
}

// ── Pieces ──
let tipSeq = 0;
const TIP_WIDTH = 290;
/**
 * Words for a hover, a focus or a tap, on a small button. They sit under the button (over the line above it when the
 * button is low in the window), pushed sideways to stay inside the window, and are always in the page for a screen reader
 * (the button describes itself by them).
 */
export function Tip({ text, cls = "", ariaLabel, children }) {
  const [at, setAt] = useState(null);
  const [pinned, setPinned] = useState(false);
  const idRef = useRef(null);
  const btn = useRef(null);
  const body = useRef(null);
  if (!idRef.current) idRef.current = `s-tip-${++tipSeq}`;
  const show = () => {
    const r = btn.current && btn.current.getBoundingClientRect ? btn.current.getBoundingClientRect() : null;
    const w = (typeof window !== "undefined" && window.innerWidth) || 0, hgt = (typeof window !== "undefined" && window.innerHeight) || 0;
    // How far sideways it must move to stay inside the window (a custom property: the page allows no style attribute).
    const dx = r && w ? Math.max(8 - r.left, Math.min(0, w - TIP_WIDTH - 12 - r.left)) : 0;
    if (body.current && body.current.style) body.current.style.setProperty("--tip-dx", `${Math.round(dx)}px`);
    setAt({ above: !!(r && hgt && r.bottom + 150 > hgt) });
  };
  const hide = () => { setAt(null); setPinned(false); };
  useEffect(() => {
    if (!at) return undefined;
    const esc = (e) => { if (e.key === "Escape") hide(); };
    const away = (e) => { if (btn.current && !btn.current.contains(e.target)) hide(); };
    document.addEventListener("keydown", esc); document.addEventListener("click", away);
    return () => { document.removeEventListener("keydown", esc); document.removeEventListener("click", away); };
  }, [!!at]);
  return html`<span class=${`s-tipwrap ${cls}`.trim()}><button type="button" class="s-tipbtn" ref=${btn} aria-label=${ariaLabel} aria-describedby=${idRef.current}
      onMouseEnter=${show} onMouseLeave=${() => { if (!pinned) hide(); }} onFocus=${show} onBlur=${hide}
      onClick=${(e) => { e.stopPropagation(); if (pinned) hide(); else { show(); setPinned(true); } }}>${children}</button>
    <span id=${idRef.current} ref=${body} class=${`s-tipbody${at && at.above ? " above" : ""}`} role="tooltip" hidden=${!at}>${text}</span></span>`;
}
/** The ⓘ beside a label: what the field is for, when it matters, what its default means. */
export function InfoTip({ text, name }) {
  return html`<${Tip} text=${text} cls="s-i" ariaLabel=${tn("tipLabel", name)}>i</${Tip}>`;
}
/**
 * "6/7 in use · artist custom" at a field's right: how many agents use this page's value; hover lists the ones that set their own.
 * A field of several items (the dashboard's features) says "partly custom" for an agent that sets only some of them — it still
 * follows this page for the rest — and the hover lists who sets which item. The count is agents only: the ClassicBot rooms that
 * follow the value are named in the hover (`rooms`), not counted.
 */
export function UsageBadge({ usage }) {
  if (!usage || !usage.total) return null;
  const { total, owners, partial = [], byPart = [], rooms = 0 } = usage;
  const who = (list, key) => tn(key, list.length === 1 ? list[0].label : tn("usageMany", list.length));
  const text = [tn("usageCount", total - owners.length, total), owners.length ? who(owners, "usageOwn") : "", partial.length ? who(partial, "usagePartly") : ""].filter(Boolean).join(" · ");
  const parts = byPart.filter((p) => p.owners.length).map((p) => `${tn(p.label)}: ${nameList(p.owners.map((o) => o.label))}`);
  const tip = parts.length ? tn("usageTipParts", parts.join("; "))
    : owners.length ? tn("usageTipOwners", nameList(owners.map((o) => o.label))) : tn("usageTipAll");
  return html`<${Tip} text=${rooms ? `${tip} ${tn("usageRooms", rooms)}` : tip} cls="s-use" ariaLabel=${text}>${text}</${Tip}>`;
}
/** A field's header: its name, where it applies ("this host"), "default" when nobody set it, the ⓘ and the usage pill. */
export function FieldHead({ id, text, tip, mark, host, usage, bare }) {
  return html`<div class="s-lab">${bare ? html`<span id=${`${id}-l`} class="s-lab-text">${text}</span>` : html`<label for=${id}>${text}</label>`}
    ${host ? html`<span class="tag s-host">${tn("hostTag")}</span>` : null}${mark}<${InfoTip} text=${tip} name=${text} />${usage ? html`<${UsageBadge} usage=${usage} />` : null}</div>`;
}
/** A segmented choice (radio group underneath: arrow keys move through it). */
export function Seg({ id, value, options, onChange, labelledBy }) {
  return html`<div id=${id} class="s-seg" role="radiogroup" aria-labelledby=${labelledBy}>${options.map((o) => html`<label key=${o.value} class=${`s-seg-opt${o.value === value ? " on" : ""}`}>
    <input type="radio" name=${id} value=${o.value} checked=${o.value === value} onChange=${() => onChange(o.value)} /><span>${o.label}</span></label>`)}</div>`;
}
/** An on/off switch (a checkbox with the role of one: the same events, the same focus), with its state in words. */
export function Switch({ id, checked, onChange, name }) {
  return html`<label class="s-switch"><input id=${id} type="checkbox" role="switch" checked=${checked} aria-label=${name} onChange=${(e) => onChange(e.target.checked)} />
    <span class="s-track" aria-hidden="true"></span><span class="s-switch-text">${tn(checked ? "switchOn" : "switchOff")}</span></label>`;
}
/** What an edit costs, under its field — only while the field is edited. */
export function Notes({ notes }) {
  return notes && notes.length ? html`<div class="s-note" role="status">${notes.map((n, i) => html`<p key=${i}>${n.text}</p>`)}</div>` : null;
}
/** A quiet line of explanation (grey — never a warning). */
export function Info({ children }) {
  return html`<p class="s-info"><span aria-hidden="true">ⓘ</span> <span>${children}</span></p>`;
}

// ── The page ──
/**
 * The fleet's half of General: two cards — what individual agents may override, and what the whole fleet shares — each
 * with its rarer settings under Advanced. `form` is General's: `f` (the draft), `set`, `base` (what is saved), `errors`,
 * `warnings`, `unset` (what fleet.yaml leaves out), `fc` (a row's class), and `notes` (sharedNotes).
 */
export function SharedAgentSettings({ ctx, form }) {
  const { f, set, base, errors, warnings, unset, fc, notes, replyNote } = form;
  const fleet = ctx.fleet;
  const primary = channelsOf(fleet)[0];
  const defaultTip = tn("defaultMarkTip");
  const mark = (...ks) => (ks.every((k) => unset[k] && sameValue(f[k], base[k])) ? html`<${DefaultMark} tip=${defaultTip} />` : null);
  const u = (field) => ({ ...usageOf(fleet, field), rooms: roomsFollowing(ctx.classic, field).length });
  const note = (field) => html`<${Notes} notes=${notes.fields[field]} />`;
  const head = (field, id, text, tip, extra = {}) => html`<${FieldHead} id=${id} text=${text} tip=${tip} usage=${FIELDS[field].agentGroup ? u(field) : null} ...${extra} />`;
  const seg = (kind, values) => values.map((v) => ({ value: v, label: tn(`seg_${kind}_${v}`) }));
  const toolSetUnset = { value: "", label: tn("toolSetUnset", toolSetDefault({}, {}), toolSetDefault({}, { general_topic: true })) };

  const agentMain = html`
    <div class=${fc("field", "backend")}>${head("backend", "g-be", tn("defaultBackend"), tn("tipBackend"), { mark: mark("backend"), host: true })}
      <${BackendSelect} id="g-be" value=${f.backend} onChange=${set("backend")} hostOnly /><${Info}>${tn("backendInfo")} <a href=${settingsPath("runtimes")}>${tn("backendInfoLink")}<span aria-hidden="true"> →</span></a></${Info}>${note("backend")}</div>
    <div class=${fc("field", "model")}>${head("model", "g-model", tn("defaultModel"), tn("tipModel"), { mark: mark("model") })}
      <${ModelSelect} id="g-model" value=${f.model} onChange=${set("model")} backend=${f.backend || "claude-code"} inherit=${tn("modelCliDefault")} />${note("model")}</div>
    <div class=${fc("field", "auto")}>${head("auto", "g-auto", `${tn("autoPause")} (${tn("minutes")})`, tn("tipAutoPause"), { mark: mark("auto") })}
      <input id="g-auto" type="number" min="0" step="1" class=${errors.auto ? "invalid" : ""} value=${f.auto} onInput=${(e) => set("auto")(e.target.value)} /><${Feedback} error=${errors.auto} />${note("auto")}</div>
    <div class=${fc("field", "tool_progress")}>${head("tool_progress", "g-tp", tn("toolProgress"), tn("tipToolProgress"), { mark: mark("tool_progress"), bare: true })}
      <${Seg} id="g-tp" labelledBy="g-tp-l" value=${f.tool_progress} onChange=${set("tool_progress")} options=${seg("tool_progress", TOOL_PROGRESS)} />${note("tool_progress")}</div>`;

  const systemMain = html`
    <div class=${fc("field", "locale")}>${head("locale", "g-locale", tn("language"), tn("tipLocale"), { mark: mark("locale") })}
      <${Select} id="g-locale" value=${f.locale} onChange=${set("locale")} options=${localeOptions(f.locale).map((o) => (o.auto ? { value: "", label: tn("localeAuto") } : o))} />${note("locale")}</div>
    <div class=${fc("field", "tips")}>${head("tips", "g-tips", tn("dailyTips"), tn("dailyTipsHint"), { mark: mark("tips") })}
      <${Switch} id="g-tips" name=${tn("dailyTips")} checked=${f.tips === "true"} onChange=${(on) => set("tips")(String(on))} />${note("tips")}</div>
    <div id="project-roots" class="s-wide"><div id="g-roots" class=${fc("field", "roots")}>${head("roots", "g-roots-c", tn("projectRootsTitle"), tn("projectRootsHint"), { bare: true })}
      <${ChipList} items=${f.roots} onChange=${set("roots")} placeholder="/path/to/projects" label=${tn("projectRootsTitle")} />
      ${f.roots.length ? null : html`<${InEffect} text=${tn("projectRootsAnywhere")} tip=${defaultTip} />`}${note("roots")}</div></div>`;

  const agentAdvanced = html`
    <div class=${fc("field", "visibility")}>${head("visibility", "g-vis", tn("crossInstanceVisibility"), tn("crossInstanceVisibilityHint"), { mark: mark("visibility"), bare: true })}
      <${Seg} id="g-vis" labelledBy="g-vis-l" value=${f.visibility} onChange=${set("visibility")} options=${seg("visibility", VISIBILITY_MODES)} />${note("visibility")}</div>
    <div class=${fc("field", "reply")}>${head("reply", "g-reply", tn("replyCompletionGuard"), tn("tipReplyGuard"), { mark: mark("reply") })}
      <${Switch} id="g-reply" name=${tn("replyCompletionGuard")} checked=${f.reply} onChange=${set("reply")} /><${Info}>${replyNote}</${Info}>${note("reply")}</div>
    <div class=${fc("field", "tool_set")}>${head("tool_set", "g-ts", tn("toolSet"), tn("tipToolSet"), { mark: mark("tool_set") })}
      <${Select} id="g-ts" value=${f.tool_set} onChange=${set("tool_set")} options=${[toolSetUnset, ...plainOptions("tool_set", TOOL_SETS)]} />${note("tool_set")}</div>
    <div class=${fc("field", "agent_mode")}>${head("agent_mode", "g-am", tn("agentMode"), tn("tipAgentMode"), { mark: mark("agent_mode"), bare: true })}
      <${Seg} id="g-am" labelledBy="g-am-l" value=${f.agent_mode} onChange=${set("agent_mode")} options=${seg("agent_mode", AGENT_MODES)} />${note("agent_mode")}</div>
    <div class=${fc("field", "log_level")}>${head("log_level", "g-ll", tn("logLevel"), tn("tipLogLevel"), { mark: mark("log_level") })}
      <${Select} id="g-ll" value=${f.log_level} onChange=${set("log_level")} options=${plainOptions("log_level", LOG_LEVELS)} />${note("log_level")}</div>
    <div class=${fc("field", "replyTriggers")}>${head("replyTriggers", "g-reply-triggers", tn("replyTriggers"), tn("replyTriggersHint"), { mark: mark("replyTriggers") })}
      <${Switch} id="g-reply-triggers" name=${tn("replyTriggers")} checked=${f.replyTriggers} onChange=${set("replyTriggers")} />${note("replyTriggers")}</div>
    <div id="g-dash" role="group" aria-labelledby="g-dash-l" class=${fc("field s-wide dash-perms", ...FIELDS.dash.keys)}>${head("dash", "g-dash", tn("dashboardAccess"), tn("dashboardDefaultsHint"), { bare: true })}
      <div class="s-checks">${DASHBOARD_FEATURES.map((k) => html`<label key=${k} class="check"><input type="checkbox" checked=${f[`dash_${k}`]}
        onChange=${(e) => set(`dash_${k}`)(e.target.checked)} /><span>${tn(`dashboard_${k}`)}</span></label>`)}</div>${note("dash")}</div>`;

  const systemAdvanced = html`
    <div class=${fc("field s-hang", "hangOn", "hang")}>${head("hang", "g-hang-on", tn("hangEnabled"), tn("tipHang"), { mark: mark("hangOn", "hang"), bare: true })}
      <div class="s-hang-row"><${Switch} id="g-hang-on" name=${tn("hangEnabled")} checked=${f.hangOn} onChange=${set("hangOn")} />
        <input id="g-hang" type="number" min="0.1" step="0.5" class=${errors.hang ? "invalid" : ""} aria-label=${tn("hangTimeout")} value=${f.hang} onInput=${(e) => set("hang")(e.target.value)} />
        <span class="s-unit">${tn("hangUnit")}</span></div><${Feedback} error=${errors.hang} />${note("hang")}</div>
    <div class=${fc("field", "concurrency")}>${head("concurrency", "g-conc", tn("concurrency"), tn("tipConcurrency"), { mark: mark("concurrency") })}
      <input id="g-conc" type="number" min="1" max="20" step="1" class=${errors.concurrency ? "invalid" : ""} value=${f.concurrency} onInput=${(e) => set("concurrency")(e.target.value)} />
      <${Feedback} error=${errors.concurrency} warning=${warnings.concurrency} />${f.concurrency.trim() === "" ? html`<${InEffect} text=${tn("concurrencyAuto")} tip=${defaultTip} />` : null}${note("concurrency")}</div>
    <div class=${fc("field", "stagger")}>${head("stagger", "g-stag", `${tn("staggerDelay")} (ms)`, tn("tipStagger"), { mark: mark("stagger") })}
      <input id="g-stag" type="number" min="0" max="30000" step="100" class=${errors.stagger ? "invalid" : ""} value=${f.stagger} onInput=${(e) => set("stagger")(e.target.value)} />
      <${Feedback} error=${errors.stagger} warning=${warnings.stagger} />${note("stagger")}</div>`;

  const card = (title, sub, body, extra) => html`<section class="card s-group"><div><h3>${title}</h3><p class="note">${sub}</p></div><div class="grid2">${body}</div>${extra || null}</section>`;
  return html`<div class="s-shared">
    ${card(tn("sharedGroupAgents"), tn("sharedGroupAgentsSub"), agentMain)}
    ${card(tn("sharedGroupSystem"), tn("sharedGroupSystemSub"), systemMain)}
    <${Drawer} title=${tn("advancedCount", ADVANCED_COUNT)}>
      ${card(tn("sharedGroupAgents"), tn("sharedGroupAgentsSub"), agentAdvanced)}
      ${card(tn("sharedGroupSystem"), tn("sharedGroupSystemAdvancedSub"), systemAdvanced, html`<${Info}>${primary ? tn("accessMovedHint", primary.id || chLabel(0)) : tn("noBots")}</${Info}>`)}
    </${Drawer}>
  </div>`;
}
