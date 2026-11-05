// Settings → Shared agent settings (the section id stays `agent-defaults`; its address and every `#g-…` anchor are unchanged):
// the page's parts. The form, its draft and its staging stay in General (panel-settings.js) — ClassicBot's defaults share
// them — and this file draws the fleet's half and does the arithmetic behind it:
// - which agents set a field themselves (the "N/M in use" pill and its list), from fleet.yaml's instances;
// - what saving an edited field costs, in words, from the schema (`impactOf`), shown under the field only once it is
//   edited and gone again when it is put back — never as a badge that is always there;
// - the same costs added up for the Save bar.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import "./settings-strings.js";
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
/** An agent has set the dashboard features itself: any of the three kept under `dashboard`, or either of the two kept beside it. */
export function ownsDashboard(inst) {
  const dash = inst && inst.dashboard;
  return Object.values(SEPARATE_FEATURE_KEYS).some((k) => hasOwn(inst, k))
    || (!!dash && typeof dash === "object" && !Array.isArray(dash) && DASHBOARD_FEATURES.some((f) => hasOwn(dash, f)));
}

/**
 * One entry per field the page draws, by the form key it is called in General's form:
 * `keys` — the form keys it edits (it is "edited" while one differs from what is saved);
 * `path` — its entry in the impact schema (what saving it costs);
 * `own` — the agent setting that overrides it (an agent that has it is not affected by an edit here); none: agents cannot;
 * `agentGroup` — it is one of the "Shared agent settings" (individual agents may override it), else of "System & channels";
 * `confirm` — saving it asks for someone's OK first.
 */
export const FIELDS = Object.freeze({
  backend: { keys: ["backend"], path: "defaults.backend", own: ["backend"], agentGroup: true },
  model: { keys: ["model"], path: "defaults.model", own: ["model"], agentGroup: true },
  auto: { keys: ["auto"], path: "defaults.auto_pause_after", own: ["auto_pause_after"], agentGroup: true },
  tool_progress: { keys: ["tool_progress"], path: "defaults.tool_progress", own: ["tool_progress"], agentGroup: true },
  visibility: { keys: ["visibility"], path: "defaults.cross_instance_visibility", own: ["cross_instance_visibility"], agentGroup: true },
  reply: { keys: ["reply"], path: "defaults.reply_completion_guard", own: ["reply_completion_guard"], agentGroup: true },
  replyTriggers: { keys: ["replyTriggers"], path: "defaults.reply_triggers", own: ["reply_triggers"], agentGroup: true },
  tool_set: { keys: ["tool_set"], path: "defaults.tool_set", own: ["tool_set"], agentGroup: true },
  agent_mode: { keys: ["agent_mode"], path: "defaults.agent_mode", own: ["agent_mode"], agentGroup: true },
  log_level: { keys: ["log_level"], path: "defaults.log_level", own: ["log_level"], agentGroup: true },
  dash: { keys: DASHBOARD_FEATURES.map((k) => `dash_${k}`), path: "defaults.dashboard", agentGroup: true, owns: ownsDashboard },
  locale: { keys: ["locale"], path: "defaults.locale" },
  tips: { keys: ["tips"], path: "defaults.tips" },
  roots: { keys: ["roots"], path: "fleet.project_roots", confirm: "noteConfirmAdmin" },
  hang: { keys: ["hangOn", "hang"], path: "defaults.hang_detector", own: ["hang_detector"] },
  concurrency: { keys: ["concurrency"], path: "fleet.spawn_concurrency" },
  stagger: { keys: ["stagger"], path: "fleet.spawn_stagger_ms" },
});
/** How many fields the Advanced drawer holds (the title says so). */
export const ADVANCED_COUNT = 10;

/** The agents that set a field themselves, and how many there are. Fields agents cannot override have none. */
export function usageOf(fleet, field) {
  const spec = FIELDS[field], agents = agentsOf(fleet);
  const sets = (inst) => (spec.owns ? spec.owns(inst) : (spec.own || []).some((k) => hasOwn(inst, k)));
  const owners = agents.filter(([, inst]) => sets(inst)).map(([name, inst]) => ({ name, label: shortName(name, inst) }));
  return { total: agents.length, owners, names: agents.map(([name]) => name) };
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
 * an invalid one has none yet.
 */
export function sharedNotes({ schema, fleet, f, base, errors = {} }) {
  const fields = {}, hit = new Set(), bar = { defaults: [], roots: [] };
  let fleetRestart = false;
  const add = (list, text) => { if (!list.includes(text)) list.push(text); };
  for (const [field, spec] of Object.entries(FIELDS)) {
    if (!edited(f, base, field) || errors[field]) continue;
    const notes = [], kind = impactOf(schema, spec.path);
    if (kind === "fleet") { notes.push({ text: tn("noteRestartFleet") }); fleetRestart = true; }
    else if (kind === "instance") {
      const u = usageOf(fleet, field), skipped = u.owners.map((o) => o.label), skippedNames = new Set(u.owners.map((o) => o.name));
      const reached = u.names.filter((n) => !skippedNames.has(n));
      for (const n of reached) hit.add(n);
      notes.push({ text: u.total === 0 ? tn("noteNoAgents") : !reached.length ? tn("noteAllOverride")
        : skipped.length ? tn("noteRestartAgentsSkip", reached.length, nameList(skipped)) : tn("noteRestartAgents", reached.length) });
    }
    if (spec.confirm) { notes.push({ text: tn(spec.confirm) }); add(field === "roots" ? bar.roots : bar.defaults, tn(spec.confirm)); }
    // Ticking a dashboard feature on is confirmed first (unticking applies at once): only a feature newly ticked asks.
    if (field === "dash" && DASHBOARD_FEATURES.some((k) => f[`dash_${k}`] === true && base[`dash_${k}`] !== true)) {
      notes.push({ text: tn("noteConfirmTick") }); add(bar.defaults, tn("noteConfirmTick"));
    }
    if (notes.length) fields[field] = notes;
  }
  if (hit.size) bar.defaults.unshift(tn("barRestartAgents", hit.size));
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
/** "6/7 in use · artist custom" at a field's right: how many agents use this page's value; hover lists the ones that set their own. */
export function UsageBadge({ usage }) {
  if (!usage || !usage.total) return null;
  const { total, owners } = usage;
  const text = `${tn("usageCount", total - owners.length, total)}${owners.length ? ` · ${tn("usageOwn", owners.length === 1 ? owners[0].label : tn("usageMany", owners.length))}` : ""}`;
  return html`<${Tip} text=${owners.length ? tn("usageTipOwners", nameList(owners.map((o) => o.label))) : tn("usageTipAll")} cls="s-use" ariaLabel=${text}>${text}</${Tip}>`;
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
  const mark = (...ks) => (ks.every((k) => unset[k] && sameValue(f[k], base[k])) ? html`<${DefaultMark} />` : null);
  const u = (field) => usageOf(fleet, field);
  const note = (field) => html`<${Notes} notes=${notes.fields[field]} />`;
  const head = (field, id, text, tip, extra = {}) => html`<${FieldHead} id=${id} text=${text} tip=${tip} usage=${FIELDS[field].agentGroup ? u(field) : null} ...${extra} />`;
  const seg = (kind, values) => values.map((v) => ({ value: v, label: tn(`seg_${kind}_${v}`) }));
  const toolSetUnset = { value: "", label: tn("toolSetUnset", toolSetDefault({}, {}), toolSetDefault({}, { general_topic: true })) };

  const agentMain = html`
    <div class=${fc("field", "backend")}>${head("backend", "g-be", tn("defaultBackend"), tn("tipBackend"), { mark: mark("backend"), host: true })}
      <${BackendSelect} id="g-be" value=${f.backend} onChange=${set("backend")} hostOnly /><${Info}>${tn("backendInfo")}</${Info}>${note("backend")}</div>
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
      ${f.roots.length ? null : html`<${InEffect} text=${tn("projectRootsAnywhere")} />`}${note("roots")}</div></div>`;

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
      <${Feedback} error=${errors.concurrency} warning=${warnings.concurrency} />${f.concurrency.trim() === "" ? html`<${InEffect} text=${tn("concurrencyAuto")} />` : null}${note("concurrency")}</div>
    <div class=${fc("field", "stagger")}>${head("stagger", "g-stag", `${tn("staggerDelay")} (ms)`, tn("tipStagger"), { mark: mark("stagger") })}
      <input id="g-stag" type="number" min="0" max="30000" step="100" class=${errors.stagger ? "invalid" : ""} value=${f.stagger} onInput=${(e) => set("stagger")(e.target.value)} />
      <${Feedback} error=${errors.stagger} warning=${warnings.stagger} />${note("stagger")}</div>`;

  const card = (title, sub, body, extra) => html`<section class="card s-group"><div><h3>${title}</h3><p class="note">${sub}</p></div><div class="grid2">${body}</div>${extra || null}</section>`;
  return html`<div class="s-shared">
    <p class="s-lead">${tn("sharedLead")}</p>
    ${card(tn("sharedGroupAgents"), tn("sharedGroupAgentsSub"), agentMain)}
    ${card(tn("sharedGroupSystem"), tn("sharedGroupSystemSub"), systemMain)}
    <${Drawer} title=${tn("advancedCount", ADVANCED_COUNT)}>
      ${card(tn("sharedGroupAgents"), tn("sharedGroupAgentsSub"), agentAdvanced)}
      ${card(tn("sharedGroupSystem"), tn("sharedGroupSystemSub"), systemAdvanced, html`<${Info}>${primary ? tn("accessMovedHint", primary.id || chLabel(0)) : tn("noBots")}</${Info}>`)}
    </${Drawer}>
  </div>`;
}
