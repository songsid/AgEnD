// #1408 step 3: Settings' form pieces and its edit dialogs. One dialog edits one object, and closing it with "Stage
// change" stages — it never writes (the panel's Apply does, through the app's runner, settings-apply.js). The writes
// that were direct on the old page stay direct (a connection's new binding, a new connection, removing one, a
// provider key): each goes through confirmedWrite, so a change an admin must confirm waits for it (#1423).
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { api, confirmedWrite, newKey } from "./settings-confirm.js";
import { botHandle, TokenEnvNote, TokenField, verifyBotToken } from "./settings-token.js";
import { startOperation } from "./settings-apply.js";
import {
  ACCESS_MODES, AGENT_FIELDS, AGENT_MODES, BOT_FIELDS, CH_TYPES, CLASSIC_FIELDS, LOG_LEVELS, TOOL_PROGRESS, TOOL_SETS,
  VISIBILITY_MODES, accessConfirmations, agentForm, agentPatch, backendOptions, changedFields, channelId, channelsOf,
  chLabel, hasOwn, impactOf, nonNegative, nonNegativeInteger, positive, replyGuardSupported, sameValue, visibilityDefault,
  webEchoIsGroup, worstImpact,
} from "./settings-model.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
export const impactText = (kind) => tn(kind === "now" ? "impactNow" : kind === "fleet" ? "impactFleet" : "impactAgent");
/** Ask in the app's own dialog (#1408 step 5): resolves true for the confirm button, false otherwise. */
export const ask = (message, opts = {}) => confirmDialog({ message, ...opts });

// ── Form pieces ──

export function Select({ value, options, onChange, disabled, id, label }) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return html`<select id=${id} value=${value} disabled=${disabled} aria-label=${label} onChange=${(e) => onChange(e.target.value)}>
    ${opts.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}</select>`;
}
export function BackendSelect({ value, onChange, disabled, id }) {
  return html`<${Select} id=${id} value=${value} disabled=${disabled} onChange=${onChange}
    options=${backendOptions(value).map((o) => (o.unavailable ? { value: o.value, label: tn("backendUnavailable", o.value) } : o))} />`;
}
export function Impact({ schema, field }) { return html`<span class="impact">${impactText(impactOf(schema, field))}</span>`; }
export function Label({ text, schema, field, htmlFor }) {
  return html`<label for=${htmlFor}>${text}${field ? html` <${Impact} schema=${schema} field=${field} />` : null}</label>`;
}
export function Feedback({ error, warning }) {
  if (!error && !warning) return null;
  return html`<p class=${`feedback${error ? " error" : " warning"}`} role=${error ? "alert" : undefined}>${error ? tn(error) : tn(warning)}</p>`;
}
/** An override of a default: the control, and "Inherit from defaults" beside it (on: the control shows the default). */
export function Override({ inherit, onInherit, schema, field, children }) {
  return html`<div class="override">${children}
    <label class="check inherit-row"><input type="checkbox" checked=${inherit} onChange=${(e) => onInherit(e.target.checked)} /><span>${tn("inheritDefault")}</span>
      ${field ? html`<${Impact} schema=${schema} field=${field} />` : null}</label></div>`;
}
export function Drawer({ title, children, open = false }) {
  return html`<details class="drawer" open=${open}><summary>${title}</summary><div class="drawer-body">${children}</div></details>`;
}
/** A list of values (user ids, tags): chips with ×, and an input that adds on Enter or Add. Numbers stay numbers. */
export function ChipList({ items, onChange, placeholder, label }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, /^-?\d+$/.test(v) ? Number(v) : v]);
    setDraft("");
  };
  return html`<div class="chips-box">
    ${items.length ? html`<div class="chips">${items.map((v, i) => html`<span key=${`${i}:${v}`} class="chip">${String(v)}
      <button type="button" class="chip-x" aria-label=${tn("removeItem", String(v))} title=${tn("removeItem", String(v))}
        onClick=${() => onChange(items.filter((_, j) => j !== i))}><${Icon} name="close" size=${12} /></button></span>`)}</div>` : null}
    <div class="field-row"><input type="text" value=${draft} placeholder=${placeholder} aria-label=${label || placeholder}
      onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      <button type="button" class="btn btn-sm" onClick=${add}><${Icon} name="plus" size=${14} />${tn("add")}</button></div>
  </div>`;
}

const replyHint = (backend, mode, kiroUi) => (replyGuardSupported(backend, mode, kiroUi) ? tn("replyGuardSupported") : tn("replyGuardUnsupported", backend, mode));

/** The dialog every editor uses: Cancel / Stage change; the footer says what the whole dialog will cost. */
function EditDialog({ title, subtitle, onClose, onStage, impacts, schema, children, ready = true, wide = true }) {
  const kinds = [...new Set((impacts || []).map((f) => impactOf(schema, f)))];
  return html`<${Dialog} title=${title} label=${subtitle ? `${title} — ${subtitle}` : title} onClose=${onClose} wide=${wide}
    actions=${html`${kinds.length ? html`<span class="note dlg-impact">${kinds.map(impactText).join(" · ")}</span>` : null}
      <button type="button" class="btn" onClick=${onClose}>${tn("cancel")}</button>
      <button type="button" class="btn btn-primary" disabled=${!ready} onClick=${onStage}>${tn("modalDone")}</button>`}>
    ${subtitle ? html`<p class="note">${subtitle}</p>` : null}
    <div class="form">${children}</div></${Dialog}>`;
}

// ── Status emojis (#1005): the preview is resolved by AgEnD exactly as the bots react ──

let catalog = null;
async function loadCatalog() {
  if (catalog) return catalog;
  const r = await api("/api/settings/status-emojis").catch(() => null);
  catalog = r && r.ok && r.body ? r.body : { keys: [], builtins: {}, telegram_allowed: [], suggestions: [] };
  return catalog;
}
const guildLists = new Map();
function guildEmojis(channel, refresh) {
  if (refresh || !guildLists.has(channel)) {
    guildLists.set(channel, api(`/api/settings/status-emojis/guild-emojis?channel=${encodeURIComponent(channel)}${refresh ? "&refresh=1" : ""}`)
      .then((r) => (r.ok ? r.body : { error: (r.body && r.body.error) || `HTTP ${r.status}` }), () => ({ error: "network" })));
  }
  return guildLists.get(channel);
}
/** Keys in catalog order, blanks dropped — so an unchanged map compares equal. */
export function orderedStatusMap(map, keys) {
  const out = {};
  for (const key of keys) { const v = map && map[key]; if (typeof v === "string" && v.trim()) out[key] = v.trim(); }
  return Object.keys(out).length ? out : null;
}
// no-referrer: nothing here should tell a third-party image host where it was loaded from.
const EmojiImg = ({ url, alt }) => html`<img src=${url} alt=${alt} referrerpolicy="no-referrer" loading="lazy" />`;

/**
 * One status_emojis map. `platform` and `channel` say where it applies; `previewBody(map)` is what the preview resolves.
 * `onChange({ value, baseline })` reports the map (null when empty) and what it was.
 */
export function StatusEmojiEditor({ own, platform, channel, previewBody, onChange }) {
  const lease = useLease("status-emojis");
  const [cat, setCat] = useState(catalog);
  const [values, setValues] = useState({ ...(own || {}) });
  const [preview, setPreview] = useState(null);
  const [picker, setPicker] = useState(null);
  const seq = useRef(0), timer = useRef(null);
  useEffect(() => { (async () => { const c = await loadCatalog(); if (lease.current()) setCat(c); })(); }, [lease]);
  const keys = cat ? cat.keys : [];
  useEffect(() => { if (cat) onChange({ value: orderedStatusMap(values, keys), baseline: orderedStatusMap(own, keys) }); }, [cat, values]);
  useEffect(() => {
    if (!cat) return;
    lease.clear(timer.current);
    timer.current = lease.timeout(async () => {
      const mine = ++seq.current;
      let r;
      try { r = await api("/api/settings/status-emojis/preview", { method: "POST", body: JSON.stringify(previewBody(orderedStatusMap(values, keys) || {})) }); }
      catch { r = { ok: false, body: { error: "network" } }; }
      if (!lease.current() || mine !== seq.current) return;
      setPreview(r.ok ? { entries: r.body.entries || [], problems: r.body.problems || [] } : { error: (r.body && r.body.error) || "preview failed" });
    }, 150);
  }, [cat, values, platform, channel]);
  if (!cat) return html`<p class="note">…</p>`;
  const builtins = cat.builtins[platform === "telegram" ? "telegram" : "discord"] || {};
  const set = (key, v) => setValues((x) => ({ ...x, [key]: v }));
  return html`<div class="se">
    <div class="se-preview">${preview && preview.entries ? preview.entries.map((e) => html`<span key=${e.key} class="se-item" title=${`${e.key}: ${e.value}`}>
        <span class="se-glyph">${e.image_url ? html`<${EmojiImg} url=${e.image_url} alt=${e.display} />` : e.value}</span>
        <span>${tn(`se_${e.key}`)}</span><span class=${`tag${e.source === "builtin" ? " se-default" : ""}`}>${tn(`se_src_${e.source}`)}</span></span>`) : html`<span class="note">…</span>`}</div>
    ${preview && preview.error ? html`<p class="feedback error">${preview.error}</p>` : null}
    ${preview && preview.problems && preview.problems.length ? html`<p class="feedback error">${preview.problems.map((p) => `${tn(`se_${p.key}`)}: ${p.problem} — ${tn("se_fallback")}`).join("  ")}</p>` : null}
    <div class="se-rows">${keys.map((key) => html`<div key=${key} class="se-row">
      <label for=${`se-${key}`}>${tn(`se_${key}`)}</label>
      <input id=${`se-${key}`} type="text" autocomplete="off" value=${values[key] || ""} placeholder=${builtins[key] || ""} onInput=${(e) => set(key, e.target.value)} />
      <button type="button" class="btn btn-sm" onClick=${() => setPicker(picker === key ? null : key)} aria-expanded=${picker === key ? "true" : "false"}>${tn("se_pick")}</button>
      <button type="button" class="icon-btn" aria-label=${tn("se_useDefault")} title=${tn("se_useDefault")} onClick=${() => set(key, "")}><${Icon} name="close" size=${14} /></button>
      ${picker === key ? html`<${EmojiPicker} cat=${cat} keyName=${key} platform=${platform} channel=${channel}
        onPick=${(v) => { set(key, v); setPicker(null); }} onClose=${() => setPicker(null)} />` : null}
    </div>`)}</div>
    <p class="note">${tn("se_hint")}</p>
  </div>`;
}

function EmojiPicker({ cat, keyName, platform, channel, onPick, onClose }) {
  const lease = useLease(`picker:${keyName}`);
  const [list, setList] = useState(null);
  // progress_prefix is message text, so Telegram's reaction set does not bind it.
  const telegramOnly = platform === "telegram" && keyName !== "progress_prefix";
  const load = async (refresh) => {
    setList(null);
    const l = await guildEmojis(channel, refresh);
    if (lease.current()) setList(l);
  };
  useEffect(() => { if (platform === "discord" && channel) load(false); }, [lease]);
  return html`<div class="se-picker">
    <p class="note">${telegramOnly ? tn("se_telegramOnly") : tn("se_unicode")}</p>
    <div class="se-grid">${(telegramOnly ? cat.telegram_allowed : cat.suggestions).map((e) => html`<button key=${e} type="button" class="btn btn-sm" title=${e} onClick=${() => onPick(e)}>${e}</button>`)}</div>
    ${platform === "discord" && channel ? html`<div class="se-guilds">
      <p class="note u-row">${tn("se_serverEmojis")} <button type="button" class="icon-btn" aria-label=${tn("refresh")} title=${tn("refresh")} onClick=${() => load(true)}><${Icon} name="restart" size=${14} /></button></p>
      ${!list ? html`<p class="note">…</p>` : list.error ? html`<p class="feedback error">${list.error}</p>` : html`
        ${list.guilds.length > 1 ? html`<p class="note">${tn("se_externalEmojiHint")}</p>` : null}
        ${list.guilds.map((g) => html`<div key=${g.id}>
          ${list.guilds.length > 1 ? html`<p class="note se-guild">${g.name || g.id}${g.primary ? html` <span class="tag">${tn("se_primaryServer")}</span>` : null}</p>` : null}
          ${g.error ? html`<p class="feedback error">${g.error}</p>` : !g.emojis.length ? html`<p class="note">${tn("se_noServerEmojis")}</p>`
            // An unavailable emoji (the server lost the Boost tier it needs) cannot be reacted with: shown, not pickable.
            : html`<div class="se-grid">${g.emojis.map((e) => html`<button key=${e.value} type="button" class=${`btn btn-sm${e.available ? "" : " off"}`} disabled=${!e.available}
                title=${`:${e.name}:${e.available ? "" : ` (${tn("se_unavailable")})`}`} onClick=${() => { if (e.available) onPick(e.value); }}><${EmojiImg} url=${e.image_url} alt=${`:${e.name}:`} /></button>`)}</div>`}
        </div>`)}`}
    </div>` : null}
    <div class="dlg-inline-actions"><button type="button" class="btn btn-sm btn-ghost" onClick=${onClose}>${tn("close")}</button></div>
  </div>`;
}

// ── Agent ──

export function AgentDialog({ name, inst, ctx, onClose }) {
  const { fleet, schema } = ctx;
  const defaults = fleet.defaults || {};
  const [f, setF] = useState(() => agentForm(inst, defaults));
  const [emojis, setEmojis] = useState({ value: inst.status_emojis || null, baseline: inst.status_emojis || null });
  // #1302: the baseline is what the picker shows before anyone touches it.
  const visibilityBaseline = useMemo(() => (hasOwn(inst, "cross_instance_visibility") ? (VISIBILITY_MODES.includes(inst.cross_instance_visibility) ? inst.cross_instance_visibility : VISIBILITY_MODES[0]) : null), []);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const setInherit = (k) => (on) => setF((x) => ({ ...x, inherit: { ...x.inherit, [k]: on } }));
  const ids = channelsOf(fleet).map(channelId);
  const kiroUi = inst.kiro_ui ?? defaults.kiro_ui ?? "legacy";
  const errors = {
    auto: f.inherit.auto_pause_after ? "" : nonNegative(f.auto_pause_after),
    hang: f.inherit.hang ? "" : positive(f.hang),
  };
  const failoverWarn = !f.inherit.model_failover && !f.model_failover.trim() ? "failoverEmpty" : "";
  const ready = !errors.auto && !errors.hang;
  const stage = () => {
    if (!ready) return;
    const patch = agentPatch({ ...f, status_emojis: emojis.value }, inst, defaults, visibilityBaseline, emojis.baseline);
    if (Object.keys(patch).length) ctx.stageAgent(name, inst, patch);
    onClose();
  };
  // What an override shows while it inherits: the default.
  const shown = (k, own, dflt) => (f.inherit[k] ? dflt : own);
  const L = (text, field, id) => html`<${Label} text=${text} schema=${schema} field=${field} htmlFor=${id} />`;
  return html`<${EditDialog} title=${ctx.shortName(name, inst)} subtitle=${`ID: ${name}`} onClose=${onClose} onStage=${stage} ready=${ready} impacts=${AGENT_FIELDS} schema=${schema}>
    <div class="grid2">
      <div class="field">${L(tn("displayName"), "instance.display_name", "ag-dn")}
        <${Override} inherit=${f.inherit.display_name} onInherit=${setInherit("display_name")}>
          <input id="ag-dn" type="text" placeholder=${name} disabled=${f.inherit.display_name} value=${shown("display_name", f.display_name, defaults.display_name || "")} onInput=${(e) => set("display_name")(e.target.value)} /></${Override}></div>
      <div class="field">${L(tn("description"), "instance.description", "ag-desc")}<input id="ag-desc" type="text" value=${f.description} onInput=${(e) => set("description")(e.target.value)} /></div>
      <div class="field">${L(tn("backend"), "instance.backend", "ag-be")}<${BackendSelect} id="ag-be" value=${f.backend} onChange=${set("backend")} /></div>
      <div class="field">${L(tn("model"), "instance.model", "ag-model")}<input id="ag-model" type="text" placeholder=${tn("inheritPlaceholder")} value=${f.model} onInput=${(e) => set("model")(e.target.value)} /></div>
    </div>
    <div class="field">${L(tn("workingDir"), "instance.working_directory", "ag-wd")}<input id="ag-wd" type="text" value=${f.working_directory} onInput=${(e) => set("working_directory")(e.target.value)} /></div>
    <div class="field">${L(`${tn("autoPause")} (${tn("minutes")})`, "instance.auto_pause_after", "ag-auto")}
      <${Override} inherit=${f.inherit.auto_pause_after} onInherit=${setInherit("auto_pause_after")}>
        <input id="ag-auto" type="number" min="0" step="1" placeholder=${tn("zeroDisabled")} class=${errors.auto ? "invalid" : ""} disabled=${f.inherit.auto_pause_after}
          value=${shown("auto_pause_after", f.auto_pause_after, String(defaults.auto_pause_after ?? 0))} onInput=${(e) => set("auto_pause_after")(e.target.value)} /></${Override}>
      <${Feedback} error=${errors.auto} /></div>
    <${Drawer} title=${tn("advancedSection")}>
      <div class="grid2">
        <div class="field">${L(tn("channelBinding"), "instance.topic_id", "ag-ch")}<${Select} id="ag-ch" value=${f.channel_id} onChange=${set("channel_id")} options=${["", ...ids]} /></div>
        <div class="field">${L(`${tn("hangTimeout")} (${tn("minutes")})`, "instance.hang_detector", "ag-hang")}
          <${Override} inherit=${f.inherit.hang} onInherit=${setInherit("hang")}>
            <input id="ag-hang" type="number" min="0.1" step="0.5" class=${errors.hang ? "invalid" : ""} disabled=${f.inherit.hang}
              value=${shown("hang", f.hang, String((defaults.hang_detector && defaults.hang_detector.timeout_minutes) ?? 15))} onInput=${(e) => set("hang")(e.target.value)} /></${Override}>
          <${Feedback} error=${errors.hang} /></div>
        ${[["agent_mode", "agentMode", AGENT_MODES, defaults.agent_mode || "mcp"], ["tool_set", "toolSet", TOOL_SETS, defaults.tool_set || "full"],
          ["tool_progress", "toolProgress", TOOL_PROGRESS, defaults.tool_progress ?? "off"],
          ["cross_instance_visibility", "crossInstanceVisibility", VISIBILITY_MODES, visibilityDefault(defaults)],
          ["log_level", "logLevel", LOG_LEVELS, defaults.log_level || "info"]].map(([k, label, opts, dflt]) => html`<div key=${k} class="field">
          ${L(tn(label), `instance.${k}`, `ag-${k}`)}
          <${Override} inherit=${f.inherit[k]} onInherit=${setInherit(k)}>
            <${Select} id=${`ag-${k}`} value=${shown(k, f[k], dflt)} disabled=${f.inherit[k]} onChange=${set(k)}
              options=${opts.includes(f[k]) || k === "cross_instance_visibility" ? opts : [f[k], ...opts]} /></${Override}>
          ${k === "cross_instance_visibility" ? html`<p class="note">${tn("crossInstanceVisibilityHint")}</p>` : null}</div>`)}
        <div class="field">${L(tn("replyCompletionGuard"), "instance.reply_completion_guard")}
          <${Override} inherit=${f.inherit.reply_completion_guard} onInherit=${setInherit("reply_completion_guard")}>
            <label class="check"><input type="checkbox" disabled=${f.inherit.reply_completion_guard} checked=${shown("reply_completion_guard", f.reply_completion_guard, defaults.reply_completion_guard ?? true)}
              onChange=${(e) => set("reply_completion_guard")(e.target.checked)} /><span>${tn("replyCompletionGuard")}</span></label></${Override}>
          <p class="note">${replyHint(f.backend, f.inherit.agent_mode ? defaults.agent_mode || "mcp" : f.agent_mode, kiroUi)}</p></div>
        <div class="field">${L(tn("lightweight"), "instance.lightweight")}
          <${Override} inherit=${f.inherit.lightweight} onInherit=${setInherit("lightweight")}>
            <label class="check"><input type="checkbox" disabled=${f.inherit.lightweight} checked=${shown("lightweight", f.lightweight, defaults.lightweight ?? false)}
              onChange=${(e) => set("lightweight")(e.target.checked)} /><span>${tn("lightweight")}</span></label></${Override}></div>
        <div class="field">${L(tn("modelFailover"), "instance.model_failover", "ag-fo")}
          <${Override} inherit=${f.inherit.model_failover} onInherit=${setInherit("model_failover")}>
            <input id="ag-fo" type="text" placeholder="e.g. sonnet" disabled=${f.inherit.model_failover}
              value=${shown("model_failover", f.model_failover, (defaults.model_failover && defaults.model_failover[0]) || "")} onInput=${(e) => set("model_failover")(e.target.value)} /></${Override}>
          <${Feedback} warning=${failoverWarn} /></div>
      </div>
      <div class="field">${L(tn("systemPrompt"), "instance.systemPrompt", "ag-sys")}<input id="ag-sys" type="text" placeholder="e.g. file:prompts/dev.md" value=${f.systemPrompt} onInput=${(e) => set("systemPrompt")(e.target.value)} /></div>
      <div class="field">${L(tn("tags"), "instance.tags")}<${ChipList} items=${f.tags} onChange=${set("tags")} placeholder=${tn("tagPlaceholder")} label=${tn("tags")} /></div>
      <label class="check"><input type="checkbox" checked=${f.general_topic} onChange=${(e) => set("general_topic")(e.target.checked)} /><span>${tn("generalTopicField")}</span>
        <${Impact} schema=${schema} field="instance.general_topic" /></label>
    </${Drawer}>
    <${Drawer} title=${tn("statusEmojis")}>
      <p class="note">${tn("statusEmojisInstance")} <${Impact} schema=${schema} field="instance.status_emojis" /></p>
      <${StatusEmojiEditor} own=${inst.status_emojis} platform=${ctx.channelType(f.channel_id || ids[0] || null)} channel=${f.channel_id || ids[0] || null}
        previewBody=${(map) => ({ channel_id: f.channel_id || ids[0] || null, instance_config: map })} onChange=${setEmojis} />
    </${Drawer}>
  </${EditDialog}>`;
}

// ── Connection (bot) ──

/** Rebind a connection: the provider proves the target first, the person confirms it, then the binding job runs. */
/**
 * `alive()` is the dialog's lease: once the dialog is gone, a verification that answers late asks nothing and writes
 * nothing (#1453 review). A write already sent is still followed to its end.
 */
async function rebind(connection, groupId, generalChannelId, say, alive) {
  const key = newKey("binding");
  const binding = { group_id: String(groupId).trim(), general_channel_id: String(generalChannelId || "").trim() || null };
  const base = `/api/settings/connections/${encodeURIComponent(connection)}/binding`;
  say({ text: tn("bindingVerifying") });
  let verified;
  try { verified = await api(`${base}/verify`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ ...binding, idempotency_key: key }) }); }
  catch { say({ error: tn("failed") }); return false; }
  if (!alive()) return false;
  if (!verified.ok) { say({ error: (verified.body && verified.body.error) || tn("bindingVerifyFailed") }); return false; }
  const probe = (verified.body && verified.body.probe) || {};
  const target = [probe.group_name || binding.group_id, probe.channel_name || probe.channel_id].filter(Boolean).join(" / ");
  const perms = [probe.can_view ? "view" : null, probe.can_send ? "send" : null, probe.can_manage_topics ? "topics" : null].filter(Boolean).join(", ");
  say({ text: tn("bindingVerified", `${target}${perms ? ` (${perms})` : ""}`) });
  if (!(await ask(tn("bindingConfirm", target || binding.group_id), { confirmLabel: tn("bindingApplyButton") }))) { if (alive()) say({ text: tn("bindingNotApplied") }); return false; }
  if (!alive()) return false;
  say({ text: tn("bindingApplying") });
  const applied = await confirmedWrite(`${base}/apply`, { method: "POST", key, label: tn("bindingLabel", connection),
    body: { verification_id: verified.body && verified.body.verification_id, idempotency_key: key } }).catch(() => ({ ok: false, body: { error: tn("failed") } }));
  if (!applied.ok && applied.status !== 409) { say({ error: (applied.body && applied.body.error) || tn("bindingApplyFailed") }); return false; }
  let result = applied.body || {};
  for (let n = 0; result.job_id && result.result === "applying" && n < 60; n++) {
    await new Promise((r) => setTimeout(r, 250));
    const status = await api(`${base}/apply/${encodeURIComponent(result.job_id)}`).catch(() => null);
    if (status && status.ok) result = status.body || result;
  }
  const labels = { applied: "bindingApplied", rolled_back: "bindingRolledBack", rollback_failed: "bindingRollbackFailed", applying: "stillApplying" };
  const ok = result.result === "applied";
  say(ok ? { text: tn(labels.applied) } : { error: tn(labels[result.result] || "bindingUnknown") });
  return ok;
}

/**
 * One connection, named by its id — never by its place in the list: a reload after another connection was added or
 * removed must not point this dialog (and a token typed into it) at a different connection (#1453 review). If the
 * connection is gone, the dialog closes and its draft goes with it.
 */
export function BotDialog({ id, ctx, onClose }) {
  const { fleet, schema } = ctx;
  const chs = channelsOf(fleet);
  const index = chs.findIndex((c, i) => channelId(c, i) === id);
  const ch = index >= 0 ? chs[index] : null;
  const type = (ch && ch.type) || "telegram";
  // The moment its connection is gone (this render), nothing started here may ask or write any more — not one frame
  // later, when the close below has run (#1453 review). Revocation is for good: every disappearance starts a new epoch,
  // and a flow belongs to the epoch it began in, so the same id coming back does not revive it.
  const epoch = useRef(0), present = useRef(!!ch);
  const latest = useRef(ctx);
  latest.current = ctx;
  if (present.current && !ch) epoch.current++;
  present.current = !!ch;
  useEffect(() => { if (!ch) onClose(); }, [!ch]);
  const previousAccess = useMemo(() => structuredClone((ch && ch.access) || { mode: "locked", allowed_users: [] }), []);
  const [mode, setMode] = useState(previousAccess.mode || "locked");
  const [users, setUsers] = useState([...(previousAccess.allowed_users || [])]);
  const [group, setGroup] = useState(ch && ch.group_id != null ? String(ch.group_id) : "");
  const [general, setGeneral] = useState(ch && ch.options && ch.options.general_channel_id != null ? String(ch.options.general_channel_id) : "");
  const [binding, setBinding] = useState(null);
  const [bindBusy, setBindBusy] = useState(false);
  const [token, setToken] = useState("");
  const [tokenNote, setTokenNote] = useState(null);
  // Replace token (#1519 P1): the field opens on Replace, and a token is staged only once the platform has named its bot.
  const [replacing, setReplacing] = useState(false);
  const [tokenId, setTokenId] = useState(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const status = (ctx.connections || []).find((c) => c && c.id === id) || {};
  const [emojis, setEmojis] = useState({ value: null, baseline: null });
  const lease = useLease("bot-dialog");
  const accessWarn = mode === "locked" && users.length === 0 ? "accessLockedEmpty" : "";
  // The token's revision (#1529 review): typing moves it, and a Verify for an older value is dropped when it lands.
  const tokenRev = useRef(0);
  const verifyToken = async () => {
    setTokenBusy(true);
    const mine = epoch.current, at = tokenRev.current;
    const identity = await verifyBotToken(type, token);
    if (!lease.current() || epoch.current !== mine) return;
    setTokenBusy(false);
    if (tokenRev.current === at) setTokenId(identity);
  };
  const stageToken = () => {
    if (!ch) return;
    if (!token) { setTokenNote({ error: tn("tokenRequired") }); return; }
    if (!tokenId || !tokenId.valid) { setTokenNote({ error: tn("wizardNeedVerify") }); return; }
    // The token goes into the staged change and nowhere else: not a label, not the URL, not storage.
    ctx.stage(`secret:${id}`, { label: tn("rotateToken", type), impact: schema.order[0], connectionSecret: { id, secret: token } });
    setToken(""); setTokenId(null); setReplacing(false);
    setTokenNote({ text: tn("tokenQueued") });
  };
  const stage = () => {
    if (!ch) return;
    const original = structuredClone(chs);
    const next = structuredClone(original);
    next[index] = { ...next[index], access: { ...(next[index].access || {}), mode, allowed_users: [...users] } };
    const accessChanged = !sameValue(next, original);
    const emojisChanged = !sameValue(emojis.value, emojis.baseline);
    if (emojisChanged) {
      const options = { ...(next[index].options || {}) };
      if (emojis.value) options.status_emojis = emojis.value; else delete options.status_emojis;
      next[index] = { ...next[index], options };
    }
    if (accessChanged || emojisChanged) {
      ctx.stageChannels(`connections:${ch.id || chLabel(index)}`, next, {
        label: tn(accessChanged && emojisChanged ? "updateAccessEmojis" : accessChanged ? "updateAccess" : "updateEmojis", ch.id || chLabel(index)),
        impact: impactOf(schema, accessChanged ? "fleet.channels" : "fleet.channel.options.status_emojis"),
        // Confirmed at Apply, against this snapshot — not the live form, which may change again before then.
        confirms: accessChanged ? accessConfirmations(previousAccess, mode, users) : [],
      });
    }
    onClose();
  };
  const remove = async () => {
    if (!ch) return;
    const asked = epoch.current;
    if (!(await ask(tn("removeBot", `${type} (${chLabel(index)})`), { confirmLabel: tn("deleteBot"), danger: true }))) return;
    if (!lease.current() || !present.current || epoch.current !== asked) return;
    // The list as it is now (a reload may have changed it while the question was open): only this connection goes.
    const now = channelsOf(latest.current.fleet);
    if (!now.some((c, j) => channelId(c, j) === id)) return;
    const next = now.filter((c, j) => channelId(c, j) !== id);
    const res = await confirmedWrite("/api/settings/fleet/channels", { method: "PUT", body: next, label: tn("removeBotLabel", id) }).catch(() => ({ ok: false, body: {} }));
    if (!res.ok) { toast((res.body && res.body.error) || tn("failed"), false); return; }
    toast(tn("saved"));
    ctx.reload();
    if (lease.current()) onClose();
  };
  const L = (text, field, htmlFor) => html`<${Label} text=${text} schema=${schema} field=${field} htmlFor=${htmlFor} />`;
  if (!ch) return null;
  return html`<${EditDialog} title=${type === "telegram" ? "Telegram" : "Discord"} subtitle=${id} onClose=${onClose} onStage=${stage} impacts=${BOT_FIELDS} schema=${schema}>
    <div class="grid2">
      <div class="field">${L(tn("accessMode"), "fleet.channel.access.mode", "bot-mode")}<${Select} id="bot-mode" value=${mode} onChange=${setMode} options=${ACCESS_MODES} />
        <${Feedback} warning=${accessWarn} /></div>
      <div class="field">${L(tn("allowedUsers"), "fleet.channel.access.allowed_users")}<${ChipList} items=${users} onChange=${setUsers} placeholder=${tn("userIdPlaceholder")} label=${tn("allowedUsers")} /></div>
    </div>
    <div class="field">${L(type === "discord" ? tn("guildIdField") : tn("groupIdField"), "fleet.channels", "bot-group")}
      <input id="bot-group" type="text" autocomplete="off" value=${group} onInput=${(e) => setGroup(e.target.value)} />
      <label for="bot-general">${type === "discord" ? tn("generalChannelId") : tn("forumTopicId")}</label>
      <input id="bot-general" type="text" autocomplete="off" value=${general} placeholder=${tn("optional")} onInput=${(e) => setGeneral(e.target.value)} />
      <p class="note">${tn("bindingHint")}</p>
      <div class="dlg-inline-actions"><button type="button" class="btn btn-sm" disabled=${bindBusy} onClick=${async () => {
        if (!group.trim()) { setBinding({ error: tn("groupRequired") }); return; }
        setBindBusy(true);
        const mine = epoch.current;
        const alive = () => lease.current() && present.current && epoch.current === mine;
        const ok = await rebind(id, group, general, (s) => { if (alive()) setBinding(s); }, alive);
        if (lease.current()) setBindBusy(false);
        if (ok) ctx.reload();
      }}>${tn("bindingButton")}</button>
      ${binding ? html`<span class=${`feedback${binding.error ? " error" : ""}`} role="status">${binding.error || binding.text}</span>` : null}</div>
    </div>
    <${Drawer} title=${tn("statusEmojis")}>
      <p class="note">${tn("statusEmojisChannel")} <${Impact} schema=${schema} field="fleet.channel.options.status_emojis" /></p>
      <${StatusEmojiEditor} own=${ch.options && ch.options.status_emojis} platform=${type} channel=${id}
        previewBody=${(map) => ({ channel_id: id, platform: type, channel_config: map })} onChange=${setEmojis} />
    </${Drawer}>
    <${Drawer} title=${tn("advancedSection")}>
      <div class="field"><span>${tn("tokenStatus")}</span>
        <div class="dlg-inline-actions"><span class="token-status">${status.token_present === false ? tn("tokenMissing")
          : status.identity && status.identity.username ? tn("tokenSetAs", botHandle(status.identity.username)) : tn("tokenSet")}</span>
          ${replacing ? null : html`<button type="button" class="btn btn-sm" onClick=${() => { setReplacing(true); setTokenNote(null); }}>${tn("tokenReplace")}</button>`}</div></div>
      ${replacing ? html`<${TokenField} id="bot-token" platform=${type} value=${token} identity=${tokenId} busy=${tokenBusy}
          onInput=${(v) => { tokenRev.current++; setToken(v); setTokenId(null); }} onVerify=${verifyToken} hint=${tn("tokenHint")} />
        <div class="dlg-inline-actions"><button type="button" class="btn btn-sm" disabled=${!tokenId || !tokenId.valid} onClick=${stageToken}>${tn("tokenButton")}</button>
          <button type="button" class="btn btn-sm btn-ghost" onClick=${() => { tokenRev.current++; setReplacing(false); setToken(""); setTokenId(null); }}>${tn("cancel")}</button></div>` : null}
      ${tokenNote ? html`<p class=${`feedback${tokenNote.error ? " error" : ""}`} role="status">${tokenNote.error || tokenNote.text}</p>` : null}
      <${TokenEnvNote} name=${ch.bot_token_env} />
      <div class="dlg-inline-actions"><button type="button" class="btn btn-sm danger" onClick=${remove}><${Icon} name="trash" size=${14} />${tn("deleteBot")}</button></div>
    </${Drawer}>
  </${EditDialog}>`;
}

/**
 * A new connection (#1519 P1): the bot token, checked with the platform, then the server-side plan — a free id and a
 * generated token env (shown under Advanced, read-only) — then the same write the setup wizard makes, without an agent:
 * one operation (the confirmation an admin may have to give, then Apply, which offers the restart a new connection
 * needs). Never a replacement: the server refuses an id or token env another connection holds.
 */
export function NewBotDialog({ ctx, onClose }) {
  const lease = useLease("new-bot");
  const [f, setF] = useState({ type: "discord", id: "", token: "", identity: null, guilds: [], group: "" });
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The form's revision (#1529 review): any change to the token, platform, id or group moves it; a Verify or a plan
  // that began before is dropped when it lands — never restoring an old token, naming it, or planning for it.
  const rev = useRef(0);
  const body = (x) => ({ platform: x.type, connection_only: true, ...(x.id.trim() ? { channel_id: x.id.trim() } : {}),
    ...(x.group.trim() ? (x.type === "discord" ? { guild_id: x.group.trim() } : { group_id: x.group.trim() }) : {}) });
  const planFor = async (x) => {
    const at = rev.current;
    const res = await api("/api/settings/quickstart/plan", { method: "POST", body: JSON.stringify(body(x)) }).catch(() => ({ ok: false, body: {} }));
    if (!lease.current() || rev.current !== at) return null;
    if (!res.ok) { setErr((res.body && res.body.error) || tn("failed")); setPlan(null); return null; }
    setErr(""); setPlan(res.body); return res.body;
  };
  const verify = async () => {
    const at = rev.current, x = f;
    const live = () => lease.current() && rev.current === at;
    setBusy(true); setErr("");
    const identity = await verifyBotToken(x.type, x.token);
    if (!live()) { if (lease.current()) setBusy(false); return; }
    let guilds = [];
    if (identity.valid && x.type === "discord") {
      const g = await api("/api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "guilds", token: x.token }) }).catch(() => null);
      if (!live()) { if (lease.current()) setBusy(false); return; }
      guilds = (g && g.body && g.body.guilds) || [];
    }
    // Onto the form as it is now (same revision, so the same token): never a copy of the form from before the await.
    setF((cur) => ({ ...cur, identity, guilds })); setBusy(false);
    if (identity.valid) await planFor({ ...x, identity, guilds });
  };
  const save = async () => {
    if (!f.identity || !f.identity.valid) { setErr(tn("wizardNeedVerify")); return; }
    const x = f;
    setBusy(true);
    const p = await planFor(x);
    if (!p) { if (lease.current()) setBusy(false); return; }
    const handed = startOperation([{ label: tn("addBotLabel", p.channel_id), impact: impactOf(ctx.schema, "fleet.channels"),
      request: { method: "POST", url: "/api/settings/quickstart/commit",
        body: { ...body(x), channel_id: p.channel_id, token_env: p.token_env, token_env_generated: true, token: x.token }, sensitive: true } }]);
    if (!handed) { setErr(tn("applyBusyLocal")); setBusy(false); return; }
    setF((x) => ({ ...x, token: "" }));
    onClose();
  };
  // A change of platform or id is another connection: what was verified and planned no longer applies. The server or
  // group does not change the id or the token's name, so the plan (and its name under Advanced) stays.
  const set = (k) => (v) => { rev.current++; setF((x) => ({ ...x, [k]: v, ...(k === "type" ? { identity: null, guilds: [], group: "" } : {}) })); if (k !== "group") setPlan(null); };
  return html`<${Dialog} title=${tn("newBot")} onClose=${onClose} busy=${busy}
    actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${onClose}>${tn("cancel")}</button>
      <button type="button" class="btn btn-primary" disabled=${busy || !f.identity || !f.identity.valid} onClick=${save}>${tn("save")}</button>`}>
    <div class="form">
      <div class="field"><label for="nb-type">${tn("type")}</label><${Select} id="nb-type" value=${f.type} onChange=${set("type")} options=${CH_TYPES} /></div>
      <${TokenField} id="nb-token" platform=${f.type} value=${f.token} identity=${f.identity} busy=${busy}
        onInput=${(v) => { rev.current++; setF((x) => ({ ...x, token: v, identity: null, guilds: [] })); setPlan(null); }} onVerify=${verify} hint=${tn("newBotTokenHint")} />
      ${f.type === "discord" && f.guilds.length
        ? html`<div class="field"><label for="nb-group">${tn("guildIdField")}</label><${Select} id="nb-group" value=${f.group} onChange=${set("group")}
            options=${["", ...f.guilds.map((g) => ({ value: g.id, label: `${g.name} (${g.id})` }))]} /></div>`
        : html`<div class="field"><label for="nb-group">${f.type === "discord" ? tn("guildIdField") : tn("groupIdField")}</label>
            <input id="nb-group" type="text" value=${f.group} onInput=${(e) => set("group")(e.target.value.trim())} /></div>`}
      <${Drawer} title=${tn("advancedSection")}>
        <div class="field"><label for="nb-id">${tn("connectionIdOptional")}</label><input id="nb-id" type="text" placeholder=${plan ? plan.channel_id : f.type}
          value=${f.id} onInput=${(e) => set("id")(e.target.value)} onBlur=${() => { if (f.identity && f.identity.valid) planFor(f); }} /></div>
        <${TokenEnvNote} name=${plan && plan.token_env} />
      </${Drawer}>
      ${err ? html`<p class="feedback error" role="alert">${err}</p>` : null}
    </div></${Dialog}>`;
}

// ── ClassicBot room ──

export function ClassicDialog({ room, ctx, onClose }) {
  const { fleet, classic, schema } = ctx;
  const cd = (classic && classic.defaults) || {}, fd = fleet.defaults || {};
  const inherited = {
    backend: cd.backend || fd.backend || "claude-code", model: cd.model || fd.model || "",
    auto_pause_after: cd.auto_pause_after ?? fd.auto_pause_after ?? 0, tool_progress: cd.tool_progress ?? fd.tool_progress ?? "off",
    reply_completion_guard: cd.reply_completion_guard ?? fd.reply_completion_guard ?? true,
  };
  const c = room;
  const [f, setF] = useState(() => ({
    backend: c.backend || inherited.backend, model: c.model || "",
    auto_pause_after: String(c.auto_pause_after ?? inherited.auto_pause_after), tool_progress: c.tool_progress ?? inherited.tool_progress,
    reply_completion_guard: c.reply_completion_guard ?? inherited.reply_completion_guard,
    collab: !!c.collab, web_echo: !!c.web_echo, context_lines: String(c.context_lines ?? cd.context_lines ?? 5),
    inherit: { auto_pause_after: !hasOwn(c, "auto_pause_after"), tool_progress: !hasOwn(c, "tool_progress"), reply_completion_guard: !hasOwn(c, "reply_completion_guard") },
  }));
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const setInherit = (k) => (on) => setF((x) => ({ ...x, inherit: { ...x.inherit, [k]: on } }));
  const errors = { auto: f.inherit.auto_pause_after ? "" : nonNegative(f.auto_pause_after), context: nonNegativeInteger(f.context_lines) };
  const ready = !errors.auto && !errors.context;
  const runtime = ctx.classicRuntime(c.instanceName);
  const classicMode = fd.agent_mode ?? "mcp";
  const lease = useLease("classic-dialog");
  const stage = async () => {
    if (!ready) return;
    const patch = changedFields({
      backend: f.backend, model: f.model.trim() || null,
      auto_pause_after: f.inherit.auto_pause_after ? null : Number(f.auto_pause_after),
      tool_progress: f.inherit.tool_progress ? null : f.tool_progress,
      reply_completion_guard: f.inherit.reply_completion_guard ? null : f.reply_completion_guard,
      collab: f.collab, context_lines: Number(f.context_lines), web_echo: f.web_echo,
    }, {
      backend: c.backend || inherited.backend, model: (c.model && c.model.trim()) || null,
      auto_pause_after: hasOwn(c, "auto_pause_after") ? c.auto_pause_after : null,
      tool_progress: hasOwn(c, "tool_progress") ? c.tool_progress : null,
      reply_completion_guard: hasOwn(c, "reply_completion_guard") ? c.reply_completion_guard : null,
      collab: !!c.collab, context_lines: c.context_lines ?? cd.context_lines ?? 5, web_echo: !!c.web_echo,
    });
    if (!Object.keys(patch).length) { onClose(); return; }
    // #1320: turning web echo on for a group posts every web message where all its members can read it.
    if (patch.web_echo === true && !c.web_echo && webEchoIsGroup(c.channelId)
      && !(await ask(tn("webEchoGroupConfirm"), { confirmLabel: tn("webEchoEnable") }))) return;
    if (!lease.current()) return;
    ctx.stageClassic(c, patch);
    onClose();
  };
  const L = (text, field, id) => html`<${Label} text=${text} schema=${schema} field=${field} htmlFor=${id} />`;
  return html`<${EditDialog} title=${c.name || c.instanceName} subtitle=${`ID: ${c.instanceName} · ${tn(`exec_${runtime.execution}`)}`} onClose=${onClose} onStage=${stage} ready=${ready} impacts=${CLASSIC_FIELDS} schema=${schema}>
    <div class="grid2">
      <div class="field">${L(tn("backend"), "classic.backend", "cl-be")}<${BackendSelect} id="cl-be" value=${f.backend} onChange=${set("backend")} /></div>
      <div class="field">${L(tn("model"), "classic.model", "cl-model")}<input id="cl-model" type="text" placeholder=${inherited.model || tn("inheritPlaceholder")} value=${f.model} onInput=${(e) => set("model")(e.target.value)} /></div>
      <div class="field">${L(`${tn("autoPause")} (${tn("minutes")})`, "classic.auto_pause_after", "cl-auto")}
        <${Override} inherit=${f.inherit.auto_pause_after} onInherit=${setInherit("auto_pause_after")}>
          <input id="cl-auto" type="number" min="0" step="1" class=${errors.auto ? "invalid" : ""} disabled=${f.inherit.auto_pause_after}
            value=${f.inherit.auto_pause_after ? String(inherited.auto_pause_after) : f.auto_pause_after} onInput=${(e) => set("auto_pause_after")(e.target.value)} /></${Override}>
        <${Feedback} error=${errors.auto} /></div>
      <div class="field">${L(tn("toolProgress"), "classic.tool_progress", "cl-tp")}
        <${Override} inherit=${f.inherit.tool_progress} onInherit=${setInherit("tool_progress")}>
          <${Select} id="cl-tp" disabled=${f.inherit.tool_progress} value=${f.inherit.tool_progress ? inherited.tool_progress : f.tool_progress} onChange=${set("tool_progress")} options=${TOOL_PROGRESS} /></${Override}></div>
      <div class="field">${L(tn("replyCompletionGuard"), "classic.reply_completion_guard")}
        <${Override} inherit=${f.inherit.reply_completion_guard} onInherit=${setInherit("reply_completion_guard")}>
          <label class="check"><input type="checkbox" disabled=${f.inherit.reply_completion_guard} checked=${f.inherit.reply_completion_guard ? inherited.reply_completion_guard : f.reply_completion_guard}
            onChange=${(e) => set("reply_completion_guard")(e.target.checked)} /><span>${tn("replyCompletionGuard")}</span></label></${Override}>
        <p class="note">${replyHint(f.backend, classicMode, fd.kiro_ui)}</p></div>
      <label class="check"><input type="checkbox" checked=${f.collab} onChange=${(e) => set("collab")(e.target.checked)} /><span>${tn("collabMode")}</span><${Impact} schema=${schema} field="classic.collab" /></label>
      <label class="check"><input type="checkbox" checked=${f.web_echo} onChange=${(e) => set("web_echo")(e.target.checked)} /><span>${tn("webEcho")}</span><${Impact} schema=${schema} field="classic.web_echo" /></label>
    </div>
    <${Drawer} title=${tn("advancedSection")}>
      <div class="field">${L(tn("contextLines"), "classic.context_lines", "cl-ctx")}
        <input id="cl-ctx" type="number" min="0" step="1" class=${errors.context ? "invalid" : ""} value=${f.context_lines} onInput=${(e) => set("context_lines")(e.target.value)} />
        <${Feedback} error=${errors.context} /></div>
      <div class="dlg-inline-actions">
        ${runtime.status === "running" ? html`<button type="button" class="btn btn-sm" onClick=${() => { onClose(); ctx.pauseWake(c.instanceName, "pause"); }}>${tn("pause")}</button>` : null}
        ${runtime.status === "paused" ? html`<button type="button" class="btn btn-sm" onClick=${() => { onClose(); ctx.pauseWake(c.instanceName, "wake"); }}>${tn("wake")}</button>` : null}
      </div>
    </${Drawer}>
  </${EditDialog}>`;
}

export { worstImpact };
