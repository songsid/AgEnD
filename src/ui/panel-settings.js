// #1408 step 3: the Settings panel (/settings[/<section>]) — agents, connections, ClassicBot rooms, general defaults,
// the developer YAML. Behind the session gate (/ui/js/), loaded the first time it is opened.
//
// What it owns (§5):
// - The configuration it shows: read when it mounts (a person's navigation, so it counts as use, #1374), dropped when
//   it goes. Nothing recurring. A section change is the same panel and keeps everything.
// - The staged changes: data, kept across sections. Leaving the panel with any asks "Discard N pending changes?" (the
//   router's leave guard; the browser's own prompt for a reload or another site).
// - Not the Apply: confirming hands the staged changes to the app's runner (settings-apply.js) before the first write.
//   This panel renders that operation from the store, and finds it again when it mounts.
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { setLeaveGuard } from "/assets/app-nav.js";
import { settingsPath, SETTINGS_SECTIONS } from "/assets/app-route.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { toast } from "/assets/ui-toast.js";
import "./settings-strings.js";
import { api, attach, confirmedWrite, newKey } from "./settings-confirm.js";
import { dismissOperation, operationActive, restartFleet, startOperation, takeLeftover } from "./settings-apply.js";
import {
  ACCESS_MODES, AGENT_MODES, DEFAULT_SCHEMA, LOG_LEVELS, TOOL_PROGRESS, TOOL_SETS, VISIBILITY_MODES, batchImpact,
  changedFields, channelId, channelsOf, chLabel, effectiveSummary, fleetModel, fromYaml, fullModelRequests, groupAgents,
  hasOwn, impactOf, localeOptions, defaultsImpact, requestImpact, nonNegative, positive, replyGuardSupported, shortName, STATUS_ORDER, toYaml,
  visibilityDefault, worstImpact,
} from "./settings-model.js";
import {
  AgentDialog, BackendSelect, BotDialog, ChipList, ClassicDialog, Drawer, Feedback, Impact, Label, NewBotDialog, Override,
  Select, ask, impactText,
} from "./settings-dialogs.js";
import { SetupWizard } from "./settings-wizard.js";
import { CreateInstanceDialog } from "./panel-fleet.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const ICONS = { agents: "bot", bots: "plug", classic: "room", general: "sliders", advanced: "code" };
const RELEASES = "https://github.com/songsid/AgEnD/releases";

/** GET under the panel's lease → { ok, status, body }. */
async function read(lease, path) {
  const r = await lease.fetch(path);
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

let loads = 0;
/** Everything the panel shows, in the order the old page read it. Returns null if the lease ended meanwhile. */
async function loadAll(lease) {
  const out = { schema: DEFAULT_SCHEMA };
  const schema = await read(lease, "/api/settings/schema");
  if (!lease.current()) return null;
  if (schema.ok && schema.body) out.schema = schema.body;
  // Forms edit the user-authored config, not defaults-expanded runtime values.
  const fleet = await read(lease, "/api/settings/fleet/raw");
  if (!lease.current()) return null;
  if (!fleet.ok) return { error: true };
  out.fleet = fleet.body || {};
  const classic = await read(lease, "/api/settings/classic");
  if (!lease.current()) return null;
  out.classic = classic.body || {};
  const connections = await read(lease, "/api/settings/connections");
  if (!lease.current()) return null;
  out.connections = connections.ok && Array.isArray(connections.body) ? connections.body : [];
  const secrets = await read(lease, "/api/settings/provider-secrets");
  if (!lease.current()) return null;
  out.providerOk = secrets.ok;
  out.providerSecrets = secrets.ok && Array.isArray(secrets.body) ? secrets.body : [];
  const live = await loadLive(lease);
  if (!live) return null;
  return { ...out, ...live, loadedAt: ++loads };
}
async function loadLive(lease) {
  const f = await read(lease, "/api/fleet");
  if (!lease.current()) return null;
  const live = {}, classicLive = {};
  if (f.ok && f.body && Array.isArray(f.body.instances)) for (const i of f.body.instances) {
    live[i.name] = { status: i.status, state: i.state, backend: i.backend, model: i.model, model_display: i.model_display, effort: i.effort, effort_supported: i.effort_supported };
    if (i.classic) classicLive[i.name] = { status: i.status, state: i.state };
  }
  // /api/fleet carries live state for ClassicBot rooms; the profiles are the fallback for one not listed there yet.
  const pr = await read(lease, "/api/profiles");
  if (!lease.current()) return null;
  const classicStatus = {};
  if (pr.ok && Array.isArray(pr.body)) for (const r of pr.body) classicStatus[r.instance_name] = r.status;
  return { live, classicLive, classicStatus, fleetUp: f.ok, version: (f.ok && f.body && f.body.version) || "" };
}

export function SettingsPanel({ route, navKey }) {
  const section = SETTINGS_SECTIONS.includes(route.section) ? route.section : "agents";
  const mount = useLease("settings");                 // the panel's life on screen: its data, its guard
  const [data, setData] = useState(null);
  const [staged, setStaged] = useState(() => new Map());
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const [dialog, setDialog] = useState(null);         // { kind, ...props, key: navKey }
  const [search, setSearch] = useState("");
  const { settingsOp: op, pendingChanges } = useStore(appStore);
  const gen = useRef(0);

  useEffect(() => { setTitle(`${tn("title")} · ${tn(`sec_${section}`)}`); }, [section, navKey]);

  const reload = async () => {
    const mine = ++gen.current;
    const next = await loadAll(mount);
    if (!next || mine !== gen.current || !mount.current()) return;
    setData(next);
  };
  const reloadLive = async () => {
    const mine = gen.current;
    const live = await loadLive(mount);
    if (!live || mine !== gen.current || !mount.current()) return;
    setData((d) => (d && !d.error ? { ...d, ...live } : d));
  };

  // Mount: the data; requests still waiting for an admin from before a reload; the leave guard; the browser's prompt.
  useEffect(() => {
    reload();
    attach();
    mount.hold(setLeaveGuard((to) => {
      const n = stagedRef.current.size;
      if (!n || (to && to.panel === "settings")) return true;
      if (!ask(tn("discardOnLeave", n))) return false;
      dropSecrets(stagedRef.current);
      return true;
    }));
    mount.on(window, "beforeunload", (e) => { if (stagedRef.current.size) { e.preventDefault(); e.returnValue = ""; } });
  }, [mount]);

  // Changes a failed Apply did not land come back to be staged again (secrets excepted: they are entered again).
  useEffect(() => {
    if (!op || !op.leftover || !op.leftover.length) return;
    const back = takeLeftover();
    if (!back.length) return;
    setStaged((s) => { const m = new Map(s); for (const c of back) m.set(c.stageKey || newKey("left"), c); return m; });
  }, [op && op.leftover]);

  // An Apply that finished, or a confirmed request that applied, changed the configuration: read it again.
  const lastPhase = useRef(op ? op.phase : null);
  useEffect(() => {
    const phase = op ? op.phase : null;
    if (lastPhase.current !== phase && (phase === "done" || phase === "failed")) reload();
    lastPhase.current = phase;
  }, [op && op.phase]);
  const applied = (pendingChanges || []).filter((p) => p.state === "applied").map((p) => p.id).join(",");
  useEffect(() => { if (applied) reload(); }, [applied]);

  const stage = (key, change) => {
    setStaged((s) => {
      const m = new Map(s);
      const prev = m.get(key);
      // Two edits of the same object before Apply: one change, the later values on top of the earlier ones.
      if (prev && prev.request && change.request && prev.request.method === "PATCH" && change.request.method === "PATCH") {
        change = { ...change, request: { ...change.request, body: { ...prev.request.body, ...change.request.body } } };
      }
      m.set(key, { ...change, stageKey: key });
      return m;
    });
    toast(tn("queued", change.label));
  };
  const unstage = (key) => setStaged((s) => { if (!s.has(key)) return s; const m = new Map(s); m.delete(key); return m; });
  const discard = () => { dropSecrets(staged); setStaged(new Map()); reload(); };
  const apply = () => {
    if (operationActive() || !staged.size) return;
    // Every confirmation before the first write: a cancelled one must not leave earlier changes applied and later
    // ones pending (a surprising partial apply).
    for (const c of staged.values()) {
      for (const k of c.confirms || []) if (!ask(tn(k))) { toast(tn("accessChangeCancelled"), false); return; }
    }
    const list = [...staged.values()].map(({ label, impact, request, connectionSecret, stageKey }) => ({ label, impact, request, connectionSecret, stageKey }));
    if (startOperation(list)) setStaged(new Map());
  };

  const ctx = data && !data.error ? makeCtx(data, setData, stage, unstage, reload, reloadLive) : null;
  const sectionBody = !data ? html`<${Skeleton} lines=${6} />`
    : data.error ? html`<${ErrorState} message=${tn("configLoadFailed")} onRetry=${reload} />`
    : section === "agents" ? html`<${Agents} ctx=${ctx} search=${search} openDialog=${(d) => setDialog({ ...d, key: navKey })} />`
    : section === "bots" ? html`<${Bots} ctx=${ctx} search=${search} openDialog=${(d) => setDialog({ ...d, key: navKey })} lease=${mount} />`
    : section === "classic" ? html`<${Classic} ctx=${ctx} search=${search} openDialog=${(d) => setDialog({ ...d, key: navKey })} />`
    : section === "general" ? html`<${General} key=${data.loadedAt} ctx=${ctx} staged=${staged} />`
    : html`<${Developer} ctx=${ctx} />`;
  // A dialog belongs to the navigation that opened it (its draft names one object, never another).
  const open = dialog && dialog.key === navKey ? dialog : null;
  const close = () => setDialog(null);
  const searchable = section === "agents" || section === "bots" || section === "classic";
  return html`<div class="panel p-settings">
    <${PanelHeader} title=${tn("title")} sub=${data && data.version ? html`<a class="pill ver" href=${data.version.includes("-") ? `${RELEASES}/latest` : `${RELEASES}/tag/v${data.version}`} target="_blank" rel="noopener">v${data.version}</a>` : null}>
      <button type="button" class="btn btn-ghost btn-sm" disabled=${!ctx} onClick=${() => setDialog({ kind: "wizard", key: navKey })}><${Icon} name="wand" size=${16} /><span class="hide-narrow">${tn("wizardButton")}</span></button>
      <button type="button" class="icon-btn" aria-label=${tn("helpButton")} title=${tn("helpButton")} onClick=${() => setDialog({ kind: "help", key: navKey })}><${Icon} name="info" /></button>
    </${PanelHeader}>
    <nav class="seg" aria-label=${tn("title")}>${SETTINGS_SECTIONS.map((k) => html`<a key=${k} href=${settingsPath(k)} class=${`seg-item${k === section ? " active" : ""}`}
      aria-current=${k === section ? "page" : undefined}><${Icon} name=${ICONS[k]} size=${16} /><span>${tn(`sec_${k}`)}</span></a>`)}</nav>
    <div class="panel-body"><div class="col">
      ${searchable ? html`<div class="s-toolbar"><label class="s-search"><${Icon} name="search" size=${14} /><span class="sr-only">${tn("searchAll")}</span>
        <input type="search" value=${search} placeholder=${tn("searchAll")} onInput=${(e) => setSearch(e.target.value)} /></label></div>` : null}
      ${op ? html`<${OperationCard} op=${op} schema=${data && data.schema} />` : null}
      ${sectionBody}
    </div></div>
    ${staged.size ? html`<${PendingBar} staged=${staged} busy=${!!op && ["writing", "posting", "watching"].includes(op.phase)} onApply=${apply} onDiscard=${discard} />` : null}
    ${open && ctx ? renderDialog(open, ctx, close) : null}
    ${open && open.kind === "help" ? html`<${HelpDialog} onClose=${close} />` : null}
  </div>`;
}

function dropSecrets(staged) { for (const c of staged.values()) if (c.connectionSecret) c.connectionSecret.secret = ""; }

function renderDialog(d, ctx, close) {
  if (d.kind === "agent") return html`<${AgentDialog} name=${d.name} inst=${d.inst} ctx=${ctx} onClose=${close} />`;
  if (d.kind === "bot") return html`<${BotDialog} index=${d.index} ctx=${ctx} onClose=${close} />`;
  if (d.kind === "newBot") return html`<${NewBotDialog} ctx=${ctx} onClose=${close} />`;
  if (d.kind === "classic") return html`<${ClassicDialog} room=${d.room} ctx=${ctx} onClose=${close} />`;
  if (d.kind === "create") return html`<${CreateInstanceDialog} onClose=${() => { close(); ctx.reload(); }} />`;
  if (d.kind === "wizard") return html`<${SetupWizard} ctx=${ctx} onClose=${close} />`;
  return null;
}

/** What the sections and dialogs work with: the data, and the ways to change it (staging, or a direct write). */
function makeCtx(data, setData, stage, unstage, reload, reloadLive) {
  const { fleet, classic, schema } = data;
  const chs = channelsOf(fleet);
  const edit = (fn) => setData((d) => { const next = structuredClone(d); fn(next); return next; });
  return {
    ...data, reload, reloadLive, stage, unstage, shortName,
    channelType: (id) => { const ch = chs.find((c, i) => channelId(c, i) === id); return ch ? ch.type : undefined; },
    classicRuntime: (instanceName) => {
      const live = data.classicLive[instanceName] || {};
      const status = live.status || data.classicStatus[instanceName] || "stopped";
      return { status, execution: status === "paused" ? "paused" : (live.state || status) };
    },
    stageAgent(name, inst, patch) {
      edit((d) => {
        const next = { ...inst, ...patch };
        for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
        if (patch.hang_detector && patch.hang_detector.timeout_minutes === null) {
          next.hang_detector = { ...(inst.hang_detector || {}) };
          delete next.hang_detector.timeout_minutes;
        }
        d.fleet.instances[name] = next;
      });
      stage(`agent:${name}`, {
        label: tn("updateAgent", shortName(name, { ...inst, ...patch })),
        impact: batchImpact(schema, Object.keys(patch), (k) => impactOf(schema, `instance.${k}`)),
        request: { method: "PATCH", url: `/api/settings/fleet/instances/${encodeURIComponent(name)}`, body: patch },
      });
    },
    deleteAgent(name) {
      if (!ask(tn("deleteAgent", name))) return;
      edit((d) => { delete d.fleet.instances[name]; });
      stage(`agent:${name}`, { label: tn("deleteAgentLabel", name), impact: impactOf(schema, "instance.delete"),
        request: { method: "DELETE", url: `/api/settings/fleet/instances/${encodeURIComponent(name)}` } });
    },
    stageChannels(key, nextChannels, meta) {
      edit((d) => { d.fleet.channels = nextChannels; delete d.fleet.channel; });
      stage(key, { ...meta, request: { method: "PUT", url: "/api/settings/fleet/channels", body: nextChannels } });
    },
    stageClassic(c, patch) {
      edit((d) => {
        const room = { ...d.classic.channels[c.key], ...patch };
        for (const k of ["model", "auto_pause_after", "tool_progress", "reply_completion_guard"]) if (patch[k] === null) delete room[k];
        d.classic.channels[c.key] = room;
      });
      const hotOnly = Object.keys(patch).every((k) => impactOf(schema, `classic.${k}`) === "now");
      stage(`classic:${c.key}`, { label: tn("updateAgent", c.name || c.instanceName), impact: hotOnly ? "now" : "instance",
        request: { method: "PATCH", url: `/api/settings/classic/channels/${encodeURIComponent(c.key)}`, body: patch } });
    },
    async pauseWake(name, action) {
      const res = await api(`/api/settings/instances/${encodeURIComponent(name)}/${action}`, { method: "POST" }).catch(() => ({ ok: false, body: {} }));
      if (!res.ok) toast((res.body && res.body.error) || tn("actionFailed", action), false);
      await reloadLive();
    },
    async startStop(name, running) {
      const res = await api(running ? `/stop/${encodeURIComponent(name)}` : `/api/instance/${encodeURIComponent(name)}/start`, { method: "POST" }).catch(() => ({ ok: false, body: {} }));
      if (!res.ok) toast(`${tn("actionFailed", running ? tn("stop") : tn("start"))}: ${(res.body && res.body.error) || res.status || ""}`, false);
      await new Promise((r) => setTimeout(r, 800));
      await reloadLive();
    },
    classic: classic || {},
  };
}

// ── Sections ──

const STATUS_KEY = { running: "stRunning", paused: "stPaused", crashed: "stCrashed", stopped: "stStopped" };
const dotClass = (st) => `dot ${st === "running" || st === "idle" ? "ok" : st === "crashed" || st === "stuck" ? "bad" : st === "working" ? "busy" : "off"}`;

function agentChannelLabel(inst, chs) {
  if (inst.general_topic) return "general";
  if (!inst.channel_id) return "";
  const idx = chs.findIndex((c, i) => channelId(c, i) === inst.channel_id);
  return idx >= 0 ? `${chs[idx].type} (${chLabel(idx)})` : inst.channel_id;
}

function Agents({ ctx, search, openDialog }) {
  const insts = ctx.fleet.instances || {};
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [busy, setBusy] = useState(() => new Map());     // name → the action under way
  const chs = channelsOf(ctx.fleet);
  const groups = groupAgents(insts, ctx.live, search);
  // One action per agent at a time: the whole row is off (Settings and ⋯ too), and the pressed button says it is working.
  const run = async (name, action, work) => {
    if (busy.has(name)) return;
    setBusy((b) => new Map(b).set(name, action));
    try { await work(); } finally { setBusy((b) => { const n = new Map(b); n.delete(name); return n; }); }
  };
  const head = html`<div class="list-head"><span>${tn("countAgents", Object.keys(insts).length)}</span>
    <button type="button" class="btn btn-primary" onClick=${() => openDialog({ kind: "create" })}><${Icon} name="plus" size=${16} />${tn("newAgent")}</button></div>`;
  if (!Object.keys(insts).length) return html`${head}<${Empty} icon="bot" title=${tn("noAgents")} />`;
  if (!groups.length) return html`${head}<${Empty} icon="search" title=${tn("noAgentMatch", search.trim())} />`;
  return html`${head}<div class="s-list">${groups.map(({ group, names }) => {
    const folded = collapsed.has(group) && !search.trim();      // searching opens every group
    return html`<section key=${group} class="s-group">
      <button type="button" class="s-group-head" aria-expanded=${folded ? "false" : "true"}
        onClick=${() => setCollapsed((c) => { const n = new Set(c); n.has(group) ? n.delete(group) : n.add(group); return n; })}>
        <${Icon} name="chevron" size=${14} cls=${folded ? "caret folded" : "caret"} /><span class="grow">${group}</span><span class="count">${names.length}</span></button>
      ${folded ? null : names.map((name) => {
        const inst = insts[name];
        const st = (ctx.live[name] && ctx.live[name].status) || "stopped";
        const sum = effectiveSummary(ctx.live[name] || {}, inst, ctx.fleet.defaults || {});
        const ch = agentChannelLabel(inst, chs);
        const working = busy.has(name), doing = busy.get(name);
        const label = (action, text) => (doing === action ? tn("working") : text);
        return html`<div key=${name} class="s-row">
          <span class=${dotClass(st)} title=${tn(STATUS_KEY[st] || "stStopped")} aria-hidden="true"></span>
          <span class="s-name" title=${name}>${shortName(name, inst)}</span>
          <span class="s-meta" title=${sum.backend}>${sum.model}</span>
          <span class="tag">${tn("effortTag", sum.effort)}</span>
          ${ch ? html`<span class=${`tag${ch.includes("persona") ? " persona" : ""}`}>${ch}</span>` : null}
          <span class="sr-only">${tn(STATUS_KEY[st] || "stStopped")}</span>
          <span class="s-actions">
            <button type="button" class="btn btn-sm" disabled=${working} onClick=${() => openDialog({ kind: "agent", name, inst })}>${tn("settingsButton")}</button>
            ${st === "running" ? html`<button type="button" class="btn btn-sm" disabled=${working} onClick=${() => run(name, "pause", () => ctx.pauseWake(name, "pause"))}>${label("pause", tn("pause"))}</button>` : null}
            ${st === "paused" ? html`<button type="button" class="btn btn-sm" disabled=${working} onClick=${() => run(name, "wake", () => ctx.pauseWake(name, "wake"))}>${label("wake", tn("wake"))}</button>` : null}
            ${st !== "paused" ? html`<button type="button" class="btn btn-sm" disabled=${working} onClick=${() => run(name, "startStop", () => ctx.startStop(name, st === "running"))}>${label("startStop", st === "running" ? tn("stop") : tn("start"))}</button>` : null}
            <${Menu} label=${t("app.more")} items=${[{ key: "delete", label: tn("deleteAgentMenu"), icon: "trash", danger: true, disabled: working, onSelect: () => ctx.deleteAgent(name) }]} />
          </span>
        </div>`;
      })}
    </section>`;
  })}</div>`;
}

function Bots({ ctx, search, openDialog, lease }) {
  const all = channelsOf(ctx.fleet);
  const needle = search.trim().toLowerCase();
  const rows = all.map((ch, i) => ({ ch, i })).filter(({ ch }) => !needle || [ch.id, ch.type, ch.group_id, ch.bot_token_env].some((v) => String(v ?? "").toLowerCase().includes(needle)));
  const head = html`<div class="list-head"><span>${tn("countBots", all.length)}</span>
    <button type="button" class="btn btn-primary" onClick=${() => openDialog({ kind: "newBot" })}><${Icon} name="plus" size=${16} />${tn("newBot")}</button></div>`;
  return html`${head}
    ${!rows.length ? html`<${Empty} icon="plug" title=${needle ? tn("noAgentMatch", search.trim()) : tn("noBots")} />` : html`<div class="s-list">${rows.map(({ ch, i }) => {
      const users = (ch.access && ch.access.allowed_users) || [];
      const token = (ctx.connections.find((c, j) => channelId(c, j) === channelId(ch, i)) || {}).token_present;
      return html`<div key=${channelId(ch, i)} class="s-row">
        <span class=${`dot ${ctx.fleetUp ? "ok" : "bad"}`} title=${ctx.fleetUp ? tn("connected") : tn("problem")} aria-hidden="true"></span>
        <span class="s-name">${ch.type === "telegram" ? "Telegram" : "Discord"}</span>
        <span class=${`tag${i === 0 ? "" : " persona"}`}>${ch.id || chLabel(i)}</span>
        <span class="s-meta">${ch.bot_token_env || tn("noTokenEnv")}</span>
        ${ch.group_id ? html`<span class="tag">${ch.type === "telegram" ? tn("groupTag", ch.group_id) : tn("guildTag", ch.group_id)}</span>` : null}
        <span class="tag">${tn("accessTag", (ch.access && ch.access.mode) || "locked")}</span>
        <span class="s-meta">${users.length ? `${users.slice(0, 3).join(", ")}${users.length > 3 ? ` +${users.length - 3}` : ""}` : tn("noAllowedUsers")}</span>
        <span class="s-actions">
          <span class=${`tag${token ? "" : " warn"}`}>${token ? tn("tokenConfigured") : tn("tokenMissing")}</span>
          <span class=${`s-state ${ctx.fleetUp ? "ok" : "bad"}`}>${ctx.fleetUp ? tn("connected") : tn("problem")}</span>
          <button type="button" class="btn btn-sm" onClick=${() => openDialog({ kind: "bot", index: i })}>${tn("settingsButton")}</button></span>
      </div>`;
    })}</div>`}
    ${ctx.providerOk ? html`<${ProviderKeys} ctx=${ctx} lease=${lease} />` : null}`;
}

/**
 * Provider API keys: verified by AgEnD, then applied (it may need an admin's confirmation, #1423). A provider whose
 * key cannot be positively verified gets no input at all — never an "unverified" write.
 */
function ProviderKeys({ ctx, lease }) {
  const [keys, setKeys] = useState({});
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(null);
  const say = (id, note) => { if (lease.current()) setNotes((n) => ({ ...n, [id]: note })); };
  const go = async (spec) => {
    const secret = keys[spec.id] || "";
    if (!secret) { say(spec.id, { error: tn("enterKeyFirst") }); return; }
    setBusy(spec.id);
    setKeys((k) => ({ ...k, [spec.id]: "" }));                 // out of the form at once; only this request holds it
    say(spec.id, { text: tn("verifying") });
    const key = newKey("provider");
    const base = `/api/settings/secrets/${encodeURIComponent(spec.id)}`;
    try {
      const verified = await api(`${base}/verify`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ secret, idempotency_key: key }) });
      if (!verified.ok) { say(spec.id, { error: (verified.body && verified.body.error) || tn("verifyFailed") }); return; }
      say(spec.id, { text: tn("applyingKey") });
      const result = await confirmedWrite(`${base}/apply`, { method: "POST", key, label: tn("providerKeyLabel", spec.display_name),
        body: { verification_id: verified.body && verified.body.verification_id, idempotency_key: key } });
      let body = result.body || {};
      for (let n = 0; result.ok && body.job_id && body.result === "applying" && n < 60; n++) {
        await new Promise((r) => setTimeout(r, 250));
        const status = await api(`${base}/apply/${encodeURIComponent(body.job_id)}`).catch(() => null);
        if (status && status.ok) body = status.body || body;
      }
      const labels = { applied_next_use: "keyAppliedNextUse", reloaded: "keyApplied", rolled_back: "keyRolledBack", rollback_failed: "keyRollbackFailed" };
      const ok = body.result === "applied_next_use" || body.result === "reloaded";
      say(spec.id, ok ? { text: tn(labels[body.result]) } : { error: labels[body.result] ? tn(labels[body.result]) : (body.error || tn("applyFailed")) });
      if (ok) ctx.reload();
    } catch { say(spec.id, { error: tn("failed") }); }
    finally { if (lease.current()) setBusy(null); }
  };
  return html`<section class="card"><h3>${tn("providerKeys")}</h3>
    ${!ctx.providerSecrets.length ? html`<p class="note">${tn("noProviderVerifiers")}</p>` : ctx.providerSecrets.map((spec) => html`<div key=${spec.id} class="s-key">
      <div class="s-key-row"><strong>${spec.display_name}</strong><span class="tag">${spec.token_present ? tn("keyConfigured") : tn("keyNotConfigured")}</span>
        ${spec.verifier === "available" ? html`<input type="password" autocomplete="new-password" aria-label=${tn("providerKeyInput", spec.display_name)}
            placeholder=${spec.token_present ? tn("keyConfigured") : tn("keyNotConfigured")} value=${keys[spec.id] || ""} onInput=${(e) => setKeys((k) => ({ ...k, [spec.id]: e.target.value }))} />
          <button type="button" class="btn btn-sm btn-primary" disabled=${busy === spec.id} onClick=${() => go(spec)}>${tn("verifyApply")}</button>`
          : html`<span class="tag">${tn("unsupportedVerifier")}</span>`}</div>
      ${spec.verifier === "available" ? null : html`<p class="note">${tn("unsupportedVerifierHint")}</p>`}
      ${notes[spec.id] ? html`<p class=${`feedback${notes[spec.id].error ? " error" : ""}`} role="status">${notes[spec.id].error || notes[spec.id].text}</p>` : null}
    </div>`)}
  </section>`;
}

function Classic({ ctx, search, openDialog }) {
  const rooms = Object.entries((ctx.classic && ctx.classic.channels) || {}).map(([key, ch]) => ({ key, ...ch }));
  if (!rooms.length) return html`<${Empty} icon="room" title=${tn("noClassic")} />`;
  const needle = search.trim().toLowerCase();
  const list = rooms.filter((c) => !needle || String(c.name || "").toLowerCase().includes(needle) || String(c.instanceName || "").toLowerCase().includes(needle))
    .sort((a, b) => ((STATUS_ORDER[ctx.classicRuntime(a.instanceName).status] ?? 9) - (STATUS_ORDER[ctx.classicRuntime(b.instanceName).status] ?? 9))
      || String(a.name || "").localeCompare(String(b.name || "")));
  if (!list.length) return html`<${Empty} icon="search" title=${tn("noAgentMatch", search.trim())} />`;
  return html`<div class="list-head"><span>${tn("countRooms", rooms.length)}</span></div><div class="s-list">${list.map((c) => {
    const rt = ctx.classicRuntime(c.instanceName);
    const sum = effectiveSummary(ctx.live[c.instanceName] || {}, c, ctx.fleet.defaults || {}, (ctx.classic && ctx.classic.defaults) || {});
    const adapter = c.adapterId || "discord";
    return html`<div key=${c.key} class="s-row">
      <span class=${dotClass(rt.execution)} title=${tn(`exec_${rt.execution}`)} aria-hidden="true"></span>
      <span class="s-name" title=${c.instanceName || ""}>${shortName(c.name || c.instanceName || "?", { display_name: c.display_name })}</span>
      <span class="s-meta" title=${sum.backend}>${sum.model}</span>
      <span class="tag">${tn("effortTag", sum.effort)}</span>
      <span class=${`tag${adapter !== "discord" ? " persona" : ""}`}>${adapter}</span>
      ${c.collab ? html`<span class="tag">collab</span>` : null}
      <span class="tag">${tn(`exec_${rt.execution}`)}</span>
      <span class="s-actions">
        <button type="button" class="btn btn-sm" onClick=${() => openDialog({ kind: "classic", room: c })}>${tn("settingsButton")}</button>
        ${rt.status === "running" ? html`<button type="button" class="btn btn-sm" onClick=${() => ctx.pauseWake(c.instanceName, "pause")}>${tn("pause")}</button>` : null}
        ${rt.status === "paused" ? html`<button type="button" class="btn btn-sm" onClick=${() => ctx.pauseWake(c.instanceName, "wake")}>${tn("wake")}</button>` : null}
      </span>
    </div>`;
  })}</div>`;
}

/**
 * General: the fleet's defaults, ClassicBot's, web chat. "Review changes" stages up to three changes (defaults,
 * ClassicBot defaults, web) — each only with what differs from what this form showed, so changing one hot default
 * never also stages untouched settings as a fleet restart.
 */
function General({ ctx, staged }) {
  const { schema } = ctx;
  const d = ctx.fleet.defaults || {}, c = (ctx.classic && ctx.classic.defaults) || {};
  const hang = d.hang_detector || {}, startup = d.startup || {};
  const primary = channelsOf(ctx.fleet)[0];
  const web = ctx.fleet.web || {};
  const originalPublic = useMemo(() => ({ allow_public: (web.public_link && web.public_link.allow_public) ?? true, ttl_minutes: (web.public_link && web.public_link.ttl_minutes) ?? 120, protocol: (web.public_link && web.public_link.protocol) ?? "http2" }), []);
  const originalEcho = web.echo_to_channel ?? true;
  const original = useMemo(() => ({ c: structuredClone(c), web: structuredClone(ctx.fleet.web) }), []);
  const [f, setF] = useState(() => ({
    echo: originalEcho, pub: originalPublic.allow_public, ttl: String(originalPublic.ttl_minutes), protocol: originalPublic.protocol,
    backend: d.backend || "claude-code", model: d.model || "", locale: d.locale || "", auto: String(d.auto_pause_after ?? 0),
    agent_mode: d.agent_mode || "mcp", tool_set: d.tool_set || "full", tool_progress: d.tool_progress ?? "off",
    visibility: visibilityDefault(d), reply: d.reply_completion_guard ?? true, log_level: d.log_level || "info",
    hangOn: hang.enabled !== false, hang: String(hang.timeout_minutes ?? 15),
    concurrency: String(startup.concurrency ?? 10), stagger: String(startup.stagger_delay_ms ?? 500),
    classicBackend: c.backend || d.backend || "claude-code",
    classicToolProgress: c.tool_progress ?? d.tool_progress ?? "off", classicToolProgressInherit: !hasOwn(c, "tool_progress"),
    classicReply: c.reply_completion_guard ?? d.reply_completion_guard ?? true, classicReplyInherit: !hasOwn(c, "reply_completion_guard"),
    admins: [...(c.admin_users || [])], guilds: [...(c.allowed_guilds || [])],
  }));
  const [msg, setMsg] = useState(null);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const num = (v) => Number(v);
  const errors = {
    auto: nonNegative(f.auto), hang: positive(f.hang),
    concurrency: !Number.isInteger(num(f.concurrency)) || num(f.concurrency) < 1 || num(f.concurrency) > 20 ? "concurrencyRange" : "",
    stagger: !Number.isFinite(num(f.stagger)) || f.stagger.trim() === "" || num(f.stagger) < 0 || num(f.stagger) > 30000 ? "staggerRange" : "",
    ttl: !Number.isInteger(num(f.ttl)) || num(f.ttl) < 1 || num(f.ttl) > 480 ? "publicTtl" : "",
  };
  const warnings = { concurrency: num(f.concurrency) > 4 ? "concurrencyWarning" : "", stagger: num(f.stagger) < 100 ? "staggerWarning" : "" };
  const ready = !Object.values(errors).some(Boolean);
  const review = () => {
    if (!ready) return;
    const defaultsPatch = changedFields({
      backend: f.backend, model: f.model || undefined, locale: f.locale || null, auto_pause_after: num(f.auto),
      agent_mode: f.agent_mode, tool_set: f.tool_set, tool_progress: f.tool_progress, cross_instance_visibility: f.visibility,
      reply_completion_guard: f.reply, log_level: f.log_level,
      hang_detector: { enabled: f.hangOn, timeout_minutes: num(f.hang) },
      startup: { concurrency: num(f.concurrency), stagger_delay_ms: num(f.stagger) },
    }, {
      backend: d.backend || "claude-code", model: d.model || undefined, locale: d.locale || null, auto_pause_after: d.auto_pause_after ?? 0,
      agent_mode: d.agent_mode || "mcp", tool_set: d.tool_set || "full", tool_progress: d.tool_progress ?? "off",
      cross_instance_visibility: visibilityDefault(d), reply_completion_guard: d.reply_completion_guard ?? true, log_level: d.log_level || "info",
      hang_detector: { enabled: hang.enabled !== false, timeout_minutes: hang.timeout_minutes ?? 15 },
      startup: { concurrency: startup.concurrency ?? 10, stagger_delay_ms: startup.stagger_delay_ms ?? 500 },
    });
    const oc = original.c;
    const classicPatch = changedFields({
      backend: f.classicBackend,
      tool_progress: f.classicToolProgressInherit ? null : f.classicToolProgress,
      reply_completion_guard: f.classicReplyInherit ? null : f.classicReply,
      admin_users: f.admins, allowed_guilds: f.guilds,
    }, {
      backend: oc.backend || d.backend || "claude-code",
      tool_progress: hasOwn(oc, "tool_progress") ? oc.tool_progress : null,
      reply_completion_guard: hasOwn(oc, "reply_completion_guard") ? oc.reply_completion_guard : null,
      admin_users: oc.admin_users || [], allowed_guilds: oc.allowed_guilds || [],
    });
    if (Object.keys(defaultsPatch).length) {
      ctx.stage("defaults:fleet", { label: tn("updateDefaults"), impact: batchImpact(schema, Object.keys(defaultsPatch), (k) => defaultsImpact(schema, k)),
        request: { method: "PUT", url: "/api/settings/fleet/defaults", body: defaultsPatch } });
    }
    if (Object.keys(classicPatch).length) {
      const hotOnly = Object.keys(classicPatch).every((k) => impactOf(schema, `classic_defaults.${k}`) === "now");
      ctx.stage("defaults:classic", { label: tn("updateClassicDefaults"), impact: hotOnly ? "now" : "fleet",
        request: { method: "PUT", url: "/api/settings/classic/defaults", body: classicPatch } });
    }
    const publicPatch = changedFields({ allow_public: f.pub, ttl_minutes: num(f.ttl), protocol: f.protocol }, originalPublic);
    const webPatch = { ...(f.echo !== originalEcho ? { echo_to_channel: f.echo } : {}), ...(Object.keys(publicPatch).length ? { public_link: publicPatch } : {}) };
    if (Object.keys(webPatch).length) {
      ctx.stage("web:echo", { label: tn("publicLink"),
        impact: batchImpact(schema, [...(webPatch.echo_to_channel !== undefined ? ["web.echo_to_channel"] : []), ...Object.keys(publicPatch).map((k) => `web.public_link.${k}`)], (k) => impactOf(schema, k)),
        request: { method: "PUT", url: "/api/settings/fleet/web", body: webPatch } });
    } else if (staged.has("web:echo")) ctx.unstage("web:echo");
    setMsg(tn("readyApply"));
  };
  const L = (text, field, id) => html`<${Label} text=${text} schema=${schema} field=${field} htmlFor=${id} />`;
  const fleetReply = replyGuardSupported(f.backend, f.agent_mode, d.kiro_ui) ? tn("replyGuardSupported") : tn("replyGuardUnsupported", f.backend, f.agent_mode);
  const classicReply = replyGuardSupported(f.classicBackend, f.agent_mode, d.kiro_ui) ? tn("replyGuardSupported") : tn("replyGuardUnsupported", f.classicBackend, f.agent_mode);
  return html`<div class="form s-general">
    <section class="card"><h3>${tn("webChat")}</h3>
      <label class="check"><input id="webEchoToChannel" type="checkbox" checked=${f.echo} onChange=${(e) => set("echo")(e.target.checked)} /><span>${tn("webEcho")}</span><${Impact} schema=${schema} field="web.echo_to_channel" /></label>
      <p class="note">${tn("webEchoHint")}</p>
      <label class="check"><input id="publicWebLink" type="checkbox" checked=${f.pub} onChange=${(e) => set("pub")(e.target.checked)} /><span>${tn("publicLink")}</span><${Impact} schema=${schema} field="web.public_link.allow_public" /></label>
      <p class="note">${tn("publicLinkHint")}</p>
      <div class="grid2">
        <div class="field"><label for="publicWebTtl">${tn("publicTtl")}</label><input id="publicWebTtl" type="number" min="1" max="480" class=${errors.ttl ? "invalid" : ""} value=${f.ttl} onInput=${(e) => set("ttl")(e.target.value)} /><${Feedback} error=${errors.ttl} /></div>
        <div class="field"><label for="publicWebProtocol">${tn("publicProtocol")}</label><${Select} id="publicWebProtocol" value=${f.protocol} onChange=${set("protocol")} options=${["http2", "quic", "auto"]} /></div>
      </div>
    </section>
    <section class="card"><h3>${tn("defaultsTitle")}</h3>
      <div class="grid2">
        <div class="field">${L(tn("language"), "defaults.locale", "g-locale")}<${Select} id="g-locale" value=${f.locale} onChange=${set("locale")}
          options=${localeOptions(f.locale).map((o) => (o.auto ? { value: "", label: tn("localeAuto") } : o))} /></div>
        <div class="field">${L(tn("defaultBackend"), "defaults.backend", "g-be")}<${BackendSelect} id="g-be" value=${f.backend} onChange=${set("backend")} /></div>
        <div class="field">${L(tn("defaultModel"), "defaults.model", "g-model")}<input id="g-model" type="text" placeholder="e.g. claude-opus-4-8" value=${f.model} onInput=${(e) => set("model")(e.target.value)} /></div>
        <div class="field">${L(`${tn("autoPause")} (${tn("minutes")})`, "defaults.auto_pause_after", "g-auto")}<input id="g-auto" type="number" min="0" step="1" class=${errors.auto ? "invalid" : ""} value=${f.auto} onInput=${(e) => set("auto")(e.target.value)} /><${Feedback} error=${errors.auto} /></div>
        <div class="field">${L(tn("toolProgress"), "defaults.tool_progress", "g-tp")}<${Select} id="g-tp" value=${f.tool_progress} onChange=${set("tool_progress")} options=${TOOL_PROGRESS} /></div>
        <div class="field">${L(tn("crossInstanceVisibility"), "defaults.cross_instance_visibility", "g-vis")}<${Select} id="g-vis" value=${f.visibility} onChange=${set("visibility")} options=${VISIBILITY_MODES} />
          <p class="note">${tn("crossInstanceVisibilityHint")}</p></div>
        <div class="field"><label class="check"><input type="checkbox" checked=${f.reply} onChange=${(e) => set("reply")(e.target.checked)} /><span>${tn("replyCompletionGuard")}</span><${Impact} schema=${schema} field="defaults.reply_completion_guard" /></label>
          <p class="note">${fleetReply}</p></div>
      </div>
    </section>
    <section class="card"><h3>ClassicBot</h3>
      <div class="grid2">
        <div class="field">${L(tn("classicBackend"), "classic_defaults.backend", "g-cbe")}<${BackendSelect} id="g-cbe" value=${f.classicBackend} onChange=${set("classicBackend")} /></div>
        <div class="field">${L(tn("toolProgress"), "classic_defaults.tool_progress", "g-ctp")}
          <${Override} inherit=${f.classicToolProgressInherit} onInherit=${set("classicToolProgressInherit")}>
            <${Select} id="g-ctp" disabled=${f.classicToolProgressInherit} value=${f.classicToolProgressInherit ? (d.tool_progress ?? "off") : f.classicToolProgress} onChange=${set("classicToolProgress")} options=${TOOL_PROGRESS} /></${Override}></div>
        <div class="field">${L(tn("replyCompletionGuard"), "classic_defaults.reply_completion_guard")}
          <${Override} inherit=${f.classicReplyInherit} onInherit=${set("classicReplyInherit")}>
            <label class="check"><input type="checkbox" disabled=${f.classicReplyInherit} checked=${f.classicReplyInherit ? (d.reply_completion_guard ?? true) : f.classicReply} onChange=${(e) => set("classicReply")(e.target.checked)} /><span>${tn("replyCompletionGuard")}</span></label></${Override}>
          <p class="note">${classicReply}</p></div>
      </div>
      <h4>${tn("whoUsesClassic")}</h4>
      <div class="grid2">
        <div class="field">${L(tn("classicAdmins"), "classic.admin_users")}<${ChipList} items=${f.admins} onChange=${set("admins")} placeholder=${tn("userIdPlaceholder")} label=${tn("classicAdmins")} /></div>
        <div class="field">${L(tn("allowedGuilds"), "classic.allowed_guilds")}<${ChipList} items=${f.guilds} onChange=${set("guilds")} placeholder=${tn("guildIdPlaceholder")} label=${tn("allowedGuilds")} /></div>
      </div>
    </section>
    <${Drawer} title=${tn("advancedSection")}>
      <section class="card"><h3>${tn("runtimeResources")}</h3><div class="grid2">
        <div class="field">${L(tn("toolSet"), "defaults.tool_set", "g-ts")}<${Select} id="g-ts" value=${f.tool_set} onChange=${set("tool_set")} options=${TOOL_SETS} /></div>
        <div class="field">${L(tn("logLevel"), "defaults.log_level", "g-ll")}<${Select} id="g-ll" value=${f.log_level} onChange=${set("log_level")} options=${LOG_LEVELS} /></div>
        <div class="field">${L(tn("agentMode"), "defaults.agent_mode", "g-am")}<${Select} id="g-am" value=${f.agent_mode} onChange=${set("agent_mode")} options=${AGENT_MODES} /></div>
      </div></section>
      <section class="card"><h3>${tn("detection")}</h3><div class="grid2">
        <label class="check"><input type="checkbox" checked=${f.hangOn} onChange=${(e) => set("hangOn")(e.target.checked)} /><span>${tn("hangEnabled")}</span><${Impact} schema=${schema} field="defaults.hang_detector" /></label>
        <div class="field">${L(`${tn("hangTimeout")} (${tn("minutes")})`, "defaults.hang_detector", "g-hang")}<input id="g-hang" type="number" min="0.1" step="0.5" class=${errors.hang ? "invalid" : ""} value=${f.hang} onInput=${(e) => set("hang")(e.target.value)} /><${Feedback} error=${errors.hang} /></div>
      </div></section>
      <section class="card"><h3>${tn("startup")}</h3><div class="grid2">
        <div class="field">${L(tn("concurrency"), "fleet.spawn_concurrency", "g-conc")}<input id="g-conc" type="number" min="1" max="20" step="1" class=${errors.concurrency ? "invalid" : ""} value=${f.concurrency} onInput=${(e) => set("concurrency")(e.target.value)} /><${Feedback} error=${errors.concurrency} warning=${warnings.concurrency} /></div>
        <div class="field">${L(`${tn("staggerDelay")} (ms)`, "fleet.spawn_stagger_ms", "g-stag")}<input id="g-stag" type="number" min="0" max="30000" step="100" class=${errors.stagger ? "invalid" : ""} value=${f.stagger} onInput=${(e) => set("stagger")(e.target.value)} /><${Feedback} error=${errors.stagger} warning=${warnings.stagger} /></div>
      </div></section>
      <section class="card"><h3>${tn("accessTitle")}</h3>
        <p class="note">${primary ? tn("accessMovedHint", primary.id || chLabel(0)) : tn("noBots")}</p></section>
    </${Drawer}>
    <div class="save-row"><button type="button" class="btn btn-primary" disabled=${!ready} onClick=${review}>${tn("reviewChanges")}</button>
      ${msg ? html`<span class="note" role="status">${msg}</span>` : null}</div>
  </div>`;
}

/** Developer: the fleet model as YAML or JSON, to read, copy, download — or edit and apply as one operation. */
function Developer({ ctx }) {
  const [fmt, setFmt] = useState("yaml");
  const [editing, setEditing] = useState(false);
  const model = fleetModel(ctx.fleet);
  const text = fmt === "yaml" ? toYaml(model) : JSON.stringify(model, null, 2);
  const [draft, setDraft] = useState(text);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (!editing) setDraft(text); }, [text, editing]);
  const copy = () => { try { navigator.clipboard.writeText(text).then(() => setMsg({ text: tn("copied") }), () => setMsg({ error: tn("failed") })); } catch { setMsg({ error: tn("failed") }); } };
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([toYaml(fleetModel(ctx.fleet))], { type: "text/plain" }));
    a.download = "fleet.yaml"; a.click(); URL.revokeObjectURL(a.href);
  };
  const save = () => {
    let parsed;
    try { parsed = fmt === "yaml" ? fromYaml(draft) : JSON.parse(draft || "{}"); } catch (e) { setMsg({ error: e.message }); return; }
    if (!parsed || typeof parsed !== "object") { setMsg({ error: tn("expectedMapping") }); return; }
    const requests = fullModelRequests(parsed, ctx.fleet.instances || {});
    if (!requests.length) { setMsg({ text: tn("noChanges") }); return; }
    if (operationActive()) { setMsg({ error: tn("applyBusyLocal") }); return; }
    // The whole edit is one operation: its writes in order, then the apply — the same runner as every Apply.
    if (startOperation(requests.map((r) => ({ label: `${r.method} ${decodeURIComponent(r.url.replace("/api/settings/", ""))}`, impact: requestImpact(ctx.schema, r), request: r })))) {
      setEditing(false); setMsg(null);
    }
  };
  return html`<section class="card s-dev">
    <div class="s-dev-bar">
      <div class="seg-inline" role="group" aria-label=${tn("format")}>
        ${["yaml", "json"].map((k) => html`<button key=${k} type="button" class=${`btn btn-sm${fmt === k ? " on" : ""}`} aria-pressed=${fmt === k ? "true" : "false"} onClick=${() => setFmt(k)}>${k.toUpperCase()}</button>`)}</div>
      <button type="button" class="btn btn-sm" onClick=${() => setEditing(!editing)}>${editing ? tn("viewMode") : tn("editMode")}</button>
      <button type="button" class="btn btn-sm" onClick=${copy}><${Icon} name="copy" size=${14} />${tn("copy")}</button>
      <button type="button" class="btn btn-sm" onClick=${download}><${Icon} name="download" size=${14} />fleet.yaml</button>
    </div>
    ${editing ? html`<textarea class="s-yaml" aria-label=${tn("devEditor")} spellcheck="false" value=${draft} onInput=${(e) => setDraft(e.target.value)}></textarea>
        <div class="save-row"><button type="button" class="btn btn-primary" onClick=${save}>${tn("devApply")}</button><span class="note">${tn("devApplyHint")}</span></div>`
      : html`<pre class="s-yaml">${text}</pre>`}
    ${msg ? html`<p class=${`feedback${msg.error ? " error" : ""}`} role="status">${msg.error || msg.text}</p>` : null}
  </section>`;
}

/** Staged, not applied: the count, what it will cost, Discard and Apply. */
function PendingBar({ staged, busy, onApply, onDiscard }) {
  const kinds = [...new Set([...staged.values()].map((c) => c.impact))];
  return html`<div class="s-pending" role="region" aria-label=${tn("pendingRegion")}>
    <strong>${tn("changesPending", staged.size)}</strong>
    <span class="note">${kinds.map(impactText).join(" · ")}</span>
    <span class="grow"></span>
    <button type="button" class="btn" onClick=${onDiscard} disabled=${busy}>${tn("discard")}</button>
    <button type="button" class="btn btn-primary" onClick=${onApply} disabled=${busy} title=${busy ? tn("applyBusyLocal") : undefined}>${tn("applyChanges")}</button>
  </div>`;
}

/** The Apply in hand (the app's, settings-apply.js): its writes, its job, and a restart when one is needed. */
function OperationCard({ op, schema }) {
  const [restarting, setRestarting] = useState(false);
  const busy = ["writing", "posting", "watching"].includes(op.phase);
  const job = op.job;
  const rows = (job && job.targets) || [];
  const fleetRestarting = job && job.status === "running" && rows.some((r) => r.target === "fleet" && r.status === "running");
  const needsRestart = rows.some((r) => r.status === "restart-required");
  const failedRows = rows.some((r) => r.status === "failed");
  const mismatch = schema && schema.fleet_signature_mismatch;
  const title = op.phase === "failed" ? tn("applyPartial") : fleetRestarting ? tn("restartFleetTitle") : busy ? tn("applying")
    : failedRows ? tn("applyPartial") : needsRestart ? tn("applyRestartNeeded") : tn("applyDone");
  const note = op.phase === "failed" ? (op.error === "busy" ? tn("applyBusy") : op.error ? tn("applyStepFailed", op.error) : "")
    : fleetRestarting ? tn("restartFleetWaiting") : op.lostJob ? tn("applyLostJob")
    : job && job.overdue ? tn("applyStillWorking", Math.round((job.elapsed_ms || 0) / 1000))
    : mismatch && needsRestart ? tn("signatureMismatch", mismatch.join(", ")) : needsRestart ? tn("applyRestartHint") : "";
  const restart = async () => {
    if (!ask(tn("restartFleetConfirm"))) return;
    setRestarting(true);
    const res = await restartFleet();
    setRestarting(false);
    if (!res.ok) {
      const secs = res.body && res.body.retry_after_seconds;
      toast(secs ? tn("restartFleetRateLimited", (res.body && res.body.error) || "", Math.ceil(secs / 60)) : tn("restartFleetRefused", (res.body && res.body.error) || tn("applyFailed")), false);
    }
  };
  const icon = (s) => (s === "done" ? "check" : s === "failed" ? "alert" : s === "waiting" ? "clock" : s === "running" ? "restart" : null);
  return html`<section class=${`card s-op ${op.phase}`} role="status" aria-live="polite">
    <div class="s-op-head"><strong>${title}</strong><span class="grow"></span>
      ${busy ? null : html`<button type="button" class="icon-btn" aria-label=${t("app.close")} title=${t("app.close")} onClick=${dismissOperation}><${Icon} name="close" size=${16} /></button>`}</div>
    ${note ? html`<p class="note">${note}</p>` : null}
    ${op.steps.length ? html`<ul class="s-op-steps">${op.steps.map((s, i) => html`<li key=${i} class=${`s-step ${s.status}`}>
      <span class="s-step-icon" aria-hidden="true">${icon(s.status) ? html`<${Icon} name=${icon(s.status)} size=${14} />` : "·"}</span>
      <span class="grow">${s.label}</span>
      <span class="note">${s.status === "waiting" ? tn("stepWaiting") : s.status === "skipped" ? tn("stepSkipped") : s.status === "failed" ? (s.error || tn("applyFailed")) : impactText(s.impact)}</span></li>`)}</ul>` : null}
    ${rows.length ? html`<ul class="s-op-steps">${rows.map((r) => html`<li key=${r.target} class=${`s-step ${r.status}`}>
      <span class="s-step-icon" aria-hidden="true">${r.status === "done" ? html`<${Icon} name="check" size=${14} />` : r.status === "failed" ? html`<${Icon} name="alert" size=${14} />` : r.status === "restart-required" ? html`<${Icon} name="restart" size=${14} />` : "·"}</span>
      <span class="grow">${r.target === "fleet" ? "AgEnD" : shortName(r.target, {})}</span>
      <span class="note">${r.target === "fleet" && r.status === "running" ? tn("restartFleetTitle") : r.status === "restart-required" ? tn("applyRestartNeeded")
        : r.settled_by === "no-change" ? tn("applyNoChange") : r.settled_by === "fleet-restart" ? tn("viaRestart") : r.kind === "hot" ? tn("impactNow") : tn("impactAgent")}</span>
      ${r.error ? html`<span class="feedback error">${r.error}</span>` : null}</li>`)}</ul>` : null}
    ${job && job.error ? html`<p class="feedback error">${job.error}</p>` : null}
    ${needsRestart && !mismatch && !busy ? html`<div class="save-row"><button type="button" class="btn btn-primary" disabled=${restarting || op.restart === "busy"} onClick=${restart}>
      ${restarting || op.restart === "busy" ? tn("restartFleetBusy") : tn("restartFleetButton")}</button></div>` : null}
  </section>`;
}

function HelpDialog({ onClose }) {
  return html`<${Dialog} title=${tn("helpTitle")} onClose=${onClose} actions=${html`<button type="button" class="btn btn-primary" onClick=${onClose}>${tn("close")}</button>`}>
    <ul class="help-list">${["help1", "help2", "help3", "help4", "help5", "help6"].map((k) => html`<li key=${k}>${tn(k)}</li>`)}</ul>
  </${Dialog}>`;
}

export { worstImpact, ACCESS_MODES };
