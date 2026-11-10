// AGEND-161: one agent's "Details & settings" page — the Details tab with its settings beside the read-only facts.
// Categories on the left (a tab row in the middle, a list on a phone), each one a group of the agent's settings, with the
// read-only Overview first. The fields are the ones the Settings dialogs always had (settings-dialogs.js: useAgentForm /
// AgentFields; native-instance-settings.js; useClassicForm / ClassicFields) — this file adds only where they live:
// - the categories and their nav (the shared Settings `.s-nav`, with an icon in front of every item you can open);
// - the staging: an edit is staged at once (the Settings page's own "N changes pending" bar and its confirmations),
//   and the Apply is the app's runner (settings-apply.js) — nothing here writes by itself;
// - one read of the configuration the first time a settings category is opened (#1374: nothing recurring).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { navigate, setLeaveGuard } from "/assets/app-nav.js";
import { detailsPath } from "/assets/app-route.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { PageHead } from "/assets/page-head.js";
import "./settings-strings.js";
import "./settings-shared-strings.js";
import "./settings-restart-strings.js";
import "./agent-page-strings.js";
import { pt } from "./agent-page-strings.js";
import { operationActive, startOperation, takeLeftover } from "./settings-apply.js";
import { batchImpact, impactOf, shortName } from "./settings-model.js";
import { AGENT_CATEGORIES, AgentFields, CLASSIC_CATEGORIES, ClassicFields, ask, useAgentForm, useClassicForm } from "./settings-dialogs.js";
import { NATIVE_CATEGORIES, NativeFields, useNativeForm } from "./native-instance-settings.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);

/** The icon in front of each category you can open — the project's own set (ui-icons.js). */
export const CATEGORY_ICONS = { overview: "eye", basic: "idcard", runtime: "bot", work: "view", channel: "chat", adv: "code" };
/** Which kind of page this is: a ClassicBot room (classicBot.yaml), a Windows native agent, or a fleet agent. */
export const agentKind = (d, inst) => (d && d.kind === "classic" ? "classic" : inst && inst.runtime === "windows" ? "native" : "fleet");
/** The categories of a kind, Overview first. A native agent has no channel binding or idle settings; a ClassicBot room has no basic info or workspace. */
export const categoriesOf = (kind) => ["overview", ...(kind === "classic" ? CLASSIC_CATEGORIES : kind === "native" ? NATIVE_CATEGORIES : AGENT_CATEGORIES)];
export const categoryLabel = (kind, cat) => pt(kind === "classic" && cat === "channel" ? "cat_classicChannel" : `cat_${cat}`);
/** The category the address names (`?cat=`), or "" for none — the phone's list, and Overview on a wide screen. */
export function categoryFromSearch(kind, search = typeof location !== "undefined" ? location.search : "") {
  const cat = new URLSearchParams(search).get("cat") || "";
  if (categoriesOf(kind).includes(cat)) return cat;
  // A category this kind has no page for (the sidebar's ⚙ always names Basic info) goes to its first one.
  return Object.keys(CATEGORY_ICONS).includes(cat) ? categoriesOf(kind)[1] : "";
}
export const categoryPath = (name, cat) => (cat ? `${detailsPath(name)}?cat=${cat}` : detailsPath(name));

/** Which category each key of a patch belongs to (a dot on the nav says "this one has changes"). */
const AGENT_KEYS = {
  basic: ["display_name", "description", "tags"],
  runtime: ["backend", "model", "model_failover", "backend_options"],
  work: ["working_directory", "auto_pause_after", "hang_detector", "agent_mode", "tool_set", "reply_completion_guard", "lightweight"],
  channel: ["channel_id", "general_topic", "tool_progress", "cross_instance_visibility", "status_emojis"],
  adv: ["systemPrompt", "log_level", "resume_interrupted_work", "mcp_proxy_reply", "board_cards_at_once", "dashboard", "office_access", "office_pack_access"],
};
const NATIVE_KEYS = { basic: ["display_name", "description", "tags"], runtime: ["model"], work: ["native_sandbox"], adv: ["systemPrompt"] };
const CLASSIC_KEYS = { runtime: ["backend", "model", "auto_pause_after"], channel: ["tool_progress", "reply_completion_guard", "reply_triggers", "collab", "web_echo", "context_lines"] };
export function dirtyCategories(kind, patch) {
  const map = kind === "classic" ? CLASSIC_KEYS : kind === "native" ? NATIVE_KEYS : AGENT_KEYS;
  const keys = Object.keys(patch || {});
  return new Set(Object.entries(map).filter(([, list]) => keys.some((k) => list.includes(k))).map(([cat]) => cat));
}

/** What one agent's edit costs and where it is sent — the same request the dialog's Done stages (panel-settings.js makeCtx). */
export function changeFor(ctx, kind, name, inst, room, patch) {
  const { schema } = ctx;
  if (kind === "classic") {
    const hotOnly = Object.keys(patch).every((k) => impactOf(schema, `classic.${k}`) === "now");
    return { label: tn("updateAgent", room.name || room.instanceName), impact: hotOnly ? "now" : "instance",
      request: { method: "PATCH", url: `/api/settings/classic/channels/${encodeURIComponent(room.key)}`, body: patch } };
  }
  const native = inst.runtime === "windows";
  return { label: tn("updateAgent", shortName(name, { ...inst, ...patch })),
    impact: native ? "now" : batchImpact(schema, Object.keys(patch), (k) => impactOf(schema, `instance.${k}`)),
    request: { method: "PATCH", url: native ? `/ui/instances/${encodeURIComponent(name)}` : `/api/settings/fleet/instances/${encodeURIComponent(name)}`, body: patch } };
}

// ── The staging: this page's, with the Settings page's rules ──

let settingsModule = null;
/** panel-settings.js — its reader of the configuration, its context and its pending bar — loaded when a settings category first opens. */
const loadSettingsModule = () => (settingsModule ||= import("./panel-settings.js"));

/**
 * The configuration of this page (read the first time `enabled`), the changes staged against it, and the Apply. Staged
 * changes wait for the Apply bar (one runner: the app's, settings-apply.js); leaving the page with some asks first.
 */
export function useAgentSettings({ name, lease, enabled, navKey }) {
  const [mod, setMod] = useState(null);
  const [data, setData] = useState(null);
  const [staged, setStaged] = useState(() => new Map());
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const [epoch, setEpoch] = useState(0);              // moves after a Discard and after a Save: the forms start again from what is saved
  const gen = useRef(0);
  const { settingsOp: op } = useStore(appStore);
  const started = useRef(false);
  const nameRef = useRef(name);
  nameRef.current = name;
  const submitted = useRef(new Map());     // the changes as they were when a Save began (what comes back after a failure keeps its confirms)

  const reload = async () => {
    const m = await loadSettingsModule();
    const mine = ++gen.current;
    const next = await m.loadAll(lease);
    if (!next || mine !== gen.current || !lease.current()) return;
    setMod(m);
    // A read that fails after a failed Save keeps what was read before: the forms (and the draft in them) stay.
    setData((prev) => (next.error && prev && !prev.error ? prev : next));
  };
  useEffect(() => { if (enabled && !started.current) { started.current = true; reload(); } }, [enabled]);

  const stage = (key, change, quiet = true) => {
    setStaged((s) => { const m = new Map(s); m.set(key, { ...change, stageKey: key }); return m; });
    if (!quiet) toast(tn("queued", change.label));
    return true;
  };
  const unstage = (key) => setStaged((s) => { if (!s.has(key)) return s; const m = new Map(s); m.delete(key); return m; });
  const discard = () => { setStaged(new Map()); setEpoch((n) => n + 1); reload(); };

  // Leaving the page with staged changes asks first (the Settings page's question); the same agent's other categories are not leaving.
  useEffect(() => {
    let asking = false;
    lease.hold(setLeaveGuard((to, path) => {
      const n = stagedRef.current.size;
      if (!n || (to && to.panel === "details" && to.instance === nameRef.current)) return true;
      if (!asking) {
        asking = true;
        ask(tn("discardOnLeave", n), { confirmLabel: tn("discard"), danger: true }).then((yes) => {
          asking = false;
          if (!yes || !lease.current()) return;
          stagedRef.current = new Map();
          navigate(path, { force: true });
        });
      }
      return false;
    }));
    lease.on(window, "beforeunload", (e) => { if (stagedRef.current.size) { e.preventDefault(); e.returnValue = ""; } });
  }, [lease]);

  // Changes a failed Apply did not land come back to be staged again.
  useEffect(() => {
    if (!op || !op.leftover || !op.leftover.length) return;
    const back = takeLeftover();
    if (!back.length) return;
    setStaged((s) => { const m = new Map(s); for (const c of back) { const k = c.stageKey || c.key; if (k && !m.has(k)) m.set(k, { ...(submitted.current.get(k) || {}), ...c, stageKey: k }); } return m; });
  }, [op && op.leftover]);

  // An Apply that finished changed the configuration: read it again, and draw the forms from it.
  const lastPhase = useRef(op ? op.phase : null);
  useEffect(() => {
    const phase = op ? op.phase : null;
    if (lastPhase.current !== phase && (phase === "done" || phase === "failed") && started.current) {
      reload().finally(() => { if (phase === "done") setEpoch((n) => n + 1); });
    }
    lastPhase.current = phase;
  }, [op && op.phase]);

  const applying = useRef(false);
  const apply = async () => {
    if (applying.current || operationActive() || !stagedRef.current.size) return;
    if ([...stagedRef.current.values()].some((c) => c.invalid)) return;
    applying.current = true;
    try {
      for (const c of [...stagedRef.current.values()]) {
        for (const k of c.confirms || []) {
          const yes = await ask(k.includes(".") ? t(k) : tn(k));
          if (!lease.current()) return;
          if (!yes) { toast(tn("accessChangeCancelled"), false); return; }
        }
      }
    } finally { applying.current = false; }
    if (!lease.current() || operationActive()) return;
    const list = [...stagedRef.current.values()].map(({ label, impact, request, stageKey, key }) => ({ label, impact, request, stageKey, key }));
    if (startOperation(list)) { submitted.current = new Map(stagedRef.current); setStaged(new Map()); }
  };

  const ctx = mod && data && !data.error
    ? mod.makeCtx(data, setData, stage, unstage, reload, reload, () => lease.current(), { drafts: new Map(), draftEpoch: epoch, staged, savingDrafts: () => null, savingStaged: () => null })
    : null;
  return { mod, data, ctx, staged, stage, unstage, discard, apply, op, epoch, reload };
}

// ── The nav ──

/** The categories in the shared Settings `.s-nav`: "Status" (Overview) and "Settings" (the rest), an icon in front of every item. */
export function AgentCategoryNav({ name, kind, cat, dirty }) {
  const cats = categoriesOf(kind);
  const item = (id) => html`<a key=${id} href=${categoryPath(name, id)} class=${`seg-item${cat === id ? " active" : ""}`} aria-current=${cat === id ? "page" : undefined}>
    <${Icon} name=${CATEGORY_ICONS[id]} size=${16} /><span>${categoryLabel(kind, id)}</span>${dirty && dirty.has(id) ? html`<span class="count" role="img" aria-label=${pt("unsavedDot")} title=${pt("unsavedDot")}>●</span>` : null}</a>`;
  return html`<nav data-trust="panel-navigation" class="seg s-nav" aria-label=${pt("title")}><div class="s-nav-groups">
    <div class="s-nav-group" role="group" aria-labelledby="ap-grp-status"><span class="s-nav-head" id="ap-grp-status">${pt("groupStatus")}</span>${item("overview")}</div>
    <div class="s-nav-group" role="group" aria-labelledby="ap-grp-settings"><span class="s-nav-head" id="ap-grp-settings">${pt("groupSettings")}</span>${cats.slice(1).map(item)}</div></div></nav>`;
}

/** The page's heading: the category's name, who it affects, and a line on what it is. */
export function AgentPageHead({ name, kind, cat, inst }) {
  return html`<${PageHead} title=${categoryLabel(kind, cat)} scope=${pt("onlyThis", inst ? shortName(name, inst) : name)} lead=${cat === "overview" ? pt("leadOverview") : pt("leadSection")} />`;
}

// ── The forms ──

/**
 * Every category's fields, drawn once the configuration is in and kept mounted (hidden when not current), so moving between
 * categories never drops a draft. Each edit is staged as it is made; an edit put back leaves nothing staged.
 */
function AgentForms({ name, kind, cat, sess, inst, room, onDirty, onDelete, deleting }) {
  const { ctx } = sess;
  const key = kind === "classic" ? `classic:${room.key}` : `agent:${name}`;
  const form = kind === "classic" ? useClassicForm({ room, ctx }) : kind === "native" ? useNativeForm({ name, inst, ctx }) : useAgentForm({ name, inst, ctx });
  const patch = form.pending();
  const patchJson = JSON.stringify(patch);
  const ready = form.ready;
  useEffect(() => {
    onDirty(dirtyCategories(kind, patch));
    if (deleting) return;
    if (!Object.keys(patch).length) { sess.unstage(key); return; }
    const change = changeFor(ctx, kind, name, inst, room, patch);
    // Turning the MCP proxy reply on is asked about first (it can post raw screen text to a channel): the Save asks.
    const confirms = patch.mcp_proxy_reply === true ? ["agentPage.confirmMcpProxy"] : undefined;
    sess.stage(key, { ...change, ...(confirms ? { confirms } : {}), ...(ready ? {} : { invalid: true }) });
  }, [patchJson, ready, deleting]);
  const cats = categoriesOf(kind).slice(1);
  const Fields = kind === "classic" ? ClassicFields : kind === "native" ? NativeFields : AgentFields;
  return cats.map((c) => html`<div key=${c} class="ap-panel" id=${`ap-panel-${c}`} hidden=${c !== cat}>
    <${Fields} m=${form} cat=${c} onDelete=${kind === "fleet" && c === "adv" ? onDelete : undefined} /></div>`);
}

/** The settings categories' bodies: a read of the configuration first, then the forms. */
export function AgentSettingsPanels({ name, kind, cat, sess, onDirty }) {
  const { data, ctx, staged, stage } = sess;
  const del = staged.get(kind === "classic" ? "" : `agent:${name}`);
  const deleting = !!del && del.request && del.request.method === "DELETE";
  if (!data) return html`<${Skeleton} lines=${6} label=${pt("loading")} />`;
  if (data.error || !ctx) return html`<${ErrorState} message=${pt("loadFailed")} onRetry=${sess.reload} />`;
  const insts = (ctx.fleet && ctx.fleet.instances) || {};
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  let inst = null, room = null;
  if (kind === "classic") {
    const rooms = (ctx.classic && ctx.classic.channels) || {};
    const k = Object.keys(rooms).find((x) => own(rooms, x) && rooms[x] && rooms[x].instanceName === name);
    if (k) room = { key: k, ...rooms[k] };
  } else if (own(insts, name)) inst = insts[name];
  if (!inst && !room) return html`<p class="note">${pt("notConfigured")}</p>`;
  // A deletion is staged on the same key as this agent's edits: say so, and stop staging edits over it.
  const onDelete = async () => {
    if (!(await ask(tn("deleteAgent", name), { confirmLabel: tn("deleteAgentMenu"), danger: true }))) return;
    const native = inst.runtime === "windows";
    stage(`agent:${name}`, { label: tn("deleteAgentLabel", name), impact: native ? "now" : impactOf(ctx.schema, "instance.delete"),
      request: { method: "DELETE", url: native ? `/ui/instances/${encodeURIComponent(name)}` : `/api/settings/fleet/instances/${encodeURIComponent(name)}` } }, false);
  };
  return html`${kind === "classic" ? html`<p class="s-info"><span aria-hidden="true">ⓘ</span><span>${pt("classicNote")}</span></p>` : null}
    ${deleting ? html`<p class="feedback warning" role="status">${tn("deleteAgentLabel", name)}</p>` : null}
    <${AgentForms} key=${sess.epoch} name=${name} kind=${kind} cat=${cat} sess=${sess} inst=${inst} room=${room} onDirty=${onDirty} onDelete=${onDelete} deleting=${deleting} />`;
}
