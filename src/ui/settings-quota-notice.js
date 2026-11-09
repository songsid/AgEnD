import { html, useEffect, useMemo, useState } from "/assets/app-html.js";
import { lang } from "/assets/app-i18n.js";
import { useDraft, syncStage } from "./settings-draft.js";

const COPY = {
  en: { title: "Notifications", heading: "Quota notices", hint: "One reminder per account, shared by its enabled agents. Exhaustion, pause and auto-continue messages are always kept.",
    classic: "ClassicBot", periodExample: "weekly", scope: "Rule for", fleet: "Fleet default", backend: "Backend", agent: "Agent", enabled: "Reminders", inherit: "Inherit", on: "On", off: "Off",
    thresholds: "Remaining percentages", thresholdHint: "Comma-separated, 1–99 (up to 8). Blank inherits; none disables reminders.",
    periods: "Periods", periodHint: "session, hourly, daily, weekly, monthly. Comma-separated; blank inherits; none disables reminders.",
    target: "Send to", general: "General", error: "Check percentages and periods. Changes cannot be saved yet.",
    old: "This server does not support quota notice settings. Update AgEnD to edit them.",
    sources: "Only fresh account usage with a known reset is used. Unsupported or stale readings do not send reminders. Enabled agents contribute a union of rules; disabling one does not silence others.",
    effective: "In effect", defaults: "Built-in: on · 10% remaining · weekly · General", saved: "Quota notices" },
  "zh-TW": { title: "通知", heading: "用量提醒", hint: "同一帳號共用一份提醒，由啟用提醒的 Agent 合併規則。額度耗盡、暫停與自動繼續的狀態訊息一律保留。",
    classic: "ClassicBot", periodExample: "weekly", scope: "設定對象", fleet: "全隊預設", backend: "後端", agent: "Agent", enabled: "提醒", inherit: "繼承", on: "開啟", off: "關閉",
    thresholds: "剩餘百分比", thresholdHint: "以逗號分隔，1–99，最多 8 個。空白表示繼承；none 表示不提醒。",
    periods: "週期", periodHint: "session（工作階段）、hourly（每小時）、daily（每日）、weekly（每週）、monthly（每月）。以逗號分隔；空白繼承；none 不提醒。",
    target: "傳送至", general: "General", error: "請檢查百分比與週期，目前無法儲存。",
    old: "此伺服器尚未支援用量提醒設定，請更新 AgEnD 後再編輯。",
    sources: "只採用有重設時間的最新帳號用量。不支援或過期的資料不會產生提醒。各 Agent 的規則取聯集；關閉其中一個不會關掉其他 Agent 的提醒。",
    effective: "目前生效", defaults: "內建預設：開啟 · 剩餘 10% · 每週 · General", saved: "用量提醒" },
};
export const quotaNoticeText = () => COPY[lang()] || COPY.en;
const BACKENDS = ["claude-code", "codex", "kiro-cli", "grok", "antigravity", "muse"];
const PERIODS = ["session", "hourly", "daily", "weekly", "monthly"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fieldKey = (scope, field) => JSON.stringify([scope, field]);
const ruleForm = (v = {}) => ({ enabled: v.enabled === undefined ? "" : v.enabled ? "on" : "off", thresholds: v.thresholds === undefined ? "" : v.thresholds.join(", ") || "none", periods: v.periods === undefined ? "" : v.periods.join(", ") || "none" });
export function quotaRuleFromForm(f) {
  const rule = {};
  if (f.enabled) rule.enabled = f.enabled === "on";
  for (const k of ["thresholds", "periods"]) {
    const raw = f[k].trim(); if (!raw) continue;
    const values = raw === "none" ? [] : raw.split(",").map(v => v.trim());
    const list = k === "thresholds" ? values.map(v => v === "" ? NaN : Number(v)) : values;
    if (new Set(list).size !== list.length || (k === "thresholds" ? list.length > 8 || list.some(v => !Number.isFinite(v) || v < 1 || v > 99) : list.some(v => !PERIODS.includes(v)))) return null;
    rule[k] = list;
  }
  return rule;
}

export function QuotaNoticeSettings({ ctx }) {
  const text = quotaNoticeText();
  const supported = ctx.schema?.impacts?.["instance.quota_notice"] === "now";
  const instances = ctx.fleet.instances || {};
  const classic = ctx.classic?.channels || {};
  const base = useMemo(() => {
    const d = ctx.fleet.defaults?.quota_notice || {};
    return { target: d.target || "general", rules: Object.fromEntries([
      ["fleet", ruleForm(d)], ...BACKENDS.map(b => [`backend:${b}`, ruleForm(d.backends?.[b])]),
      ...Object.entries(instances).map(([n, c]) => [`agent:${n}`, ruleForm(c.quota_notice)]),
      ...Object.entries(classic).map(([n, c]) => [`classic:${n}`, ruleForm(c.quota_notice)]),
    ]) };
  }, []);
  // useDraft retains top-level edited fields. Flatten rules so an edit never
  // freezes untouched rules (or untouched fields of the same rule) across reload.
  const savedFields = useMemo(() => {
    const saved = { target: base.target, ...Object.fromEntries(Object.entries(base.rules).flatMap(([scope, rule]) => Object.entries(rule).map(([field, value]) => [fieldKey(scope, field), value]))) };
    const retained = ctx.drafts?.get("quota-notices");
    if (retained) ctx.drafts.set("quota-notices", Object.fromEntries(Object.entries(retained).filter(([key]) => Object.hasOwn(saved, key))));
    return saved;
  }, []);
  const [fields, setFields] = useDraft(ctx, "quota-notices", () => savedFields);
  const form = useMemo(() => ({ target: fields.target, rules: Object.fromEntries(Object.entries(base.rules).map(([scope, rule]) => [scope, Object.fromEntries(Object.keys(rule).map(field => [field, fields[fieldKey(scope, field)]]))])) }), [fields]);
  const [scope, setScope] = useState("fleet");
  const parsed = Object.fromEntries(Object.entries(form.rules).map(([k, v]) => [k, quotaRuleFromForm(v)]));
  const invalid = Object.values(parsed).some(v => v === null);
  useEffect(() => {
    if (!supported) return;
    const defaults = { ...parsed.fleet, target: form.target, backends: Object.fromEntries(BACKENDS.flatMap(b => Object.keys(parsed[`backend:${b}`] || {}).length ? [[b, parsed[`backend:${b}`]]] : [])) };
    const changed = !same(form.rules.fleet, base.rules.fleet) || form.target !== base.target || BACKENDS.some(b => !same(form.rules[`backend:${b}`], base.rules[`backend:${b}`]));
    syncStage(ctx, "quota:defaults", changed ? { label: text.saved, impact: "now", ...(invalid ? { invalid: text.error } : { request: { method: "PUT", url: "/api/settings/fleet/defaults", body: { quota_notice: defaults } } }) } : null);
    for (const [name, isClassic] of [...Object.keys(instances).map(n => [n, false]), ...Object.keys(classic).map(n => [n, true])]) {
      const k = `${isClassic ? "classic" : "agent"}:${name}`, rule = parsed[k];
      syncStage(ctx, `quota:${k}`, !same(form.rules[k], base.rules[k]) ? { label: `${text.saved} · ${name}`, impact: "now", ...(rule === null ? { invalid: text.error } : { request: { method: "PATCH", url: isClassic ? `/api/settings/classic/channels/${encodeURIComponent(name)}` : `/api/settings/fleet/instances/${encodeURIComponent(name)}`, body: { quota_notice: Object.keys(rule).length ? rule : null } } }) } : null);
    }
  }, [form, supported]);
  const value = form.rules[scope];
  const selectedBackend = scope.startsWith("backend:") ? scope.slice(8) : scope.startsWith("agent:") ? instances[scope.slice(6)]?.backend || ctx.fleet.defaults?.backend || "claude-code" : scope.startsWith("classic:") ? classic[scope.slice(8)]?.backend || ctx.classic?.defaults?.backend || ctx.fleet.defaults?.backend || "claude-code" : null;
  const effective = { enabled: true, thresholds: [10], periods: ["weekly"], ...parsed.fleet,
    ...(selectedBackend ? parsed[`backend:${selectedBackend}`] : {}), ...(scope.startsWith("agent:") || scope.startsWith("classic:") ? parsed[scope] : {}) };
  const update = k => e => setFields(f => ({ ...f, [fieldKey(scope, k)]: e.target.value }));
  // alpha.6 feedback (#3): the Settings card (card s-group, as Shared agent settings: a title and its note, the fields in the
  // grid), not a bare heading over full-width fields.
  return html`<section class="card s-group" id="quota-notices"><div><h3>${text.heading}</h3><p class="note">${text.hint}</p><p class="note">${text.defaults}</p></div>
    ${!supported ? html`<p role="status">${text.old}</p>` : null}
    ${!invalid ? html`<p class="note" data-quota-effective>${text.effective}: ${effective.enabled ? text.on : text.off} · ${effective.thresholds.map(v => `${v}%`).join(", ") || "—"} · ${effective.periods.join(", ") || "—"}</p>` : null}
    <fieldset disabled=${!supported} class="s-quota-fields grid2">
      <div class="field"><label for="qn-target">${text.target}</label><select id="qn-target" value=${form.target} onChange=${e => setFields(f => ({ ...f, target: e.target.value }))}>
        <option value="general">${text.general}</option>${Object.entries(instances).filter(([n]) => n !== "general").map(([n, c]) => html`<option value=${n}>${c.display_name || n}</option>`)}
        ${form.target !== "general" && !Object.hasOwn(instances, form.target) ? html`<option value=${form.target}>${form.target}</option>` : null}
      </select></div>
      <div class="field"><label for="qn-scope">${text.scope}</label><select id="qn-scope" value=${scope} onChange=${e => setScope(e.target.value)}>
        <option value="fleet">${text.fleet}</option>${BACKENDS.map(b => html`<option value=${`backend:${b}`}>${text.backend} · ${b}</option>`)}
        ${Object.entries(instances).map(([n, c]) => html`<option value=${`agent:${n}`}>${text.agent} · ${c.display_name || n}</option>`)}
        ${Object.entries(classic).map(([n, c]) => html`<option value=${`classic:${n}`}>${text.classic} · ${c.name || c.instanceName || n}</option>`)}
      </select></div>
      <div class="field"><label for="qn-enabled">${text.enabled}</label><select id="qn-enabled" value=${value.enabled} onChange=${update("enabled")}><option value="">${text.inherit}</option><option value="on">${text.on}</option><option value="off">${text.off}</option></select></div>
      <div class="field"><label for="qn-thresholds">${text.thresholds}</label><input id="qn-thresholds" value=${value.thresholds} onInput=${update("thresholds")} placeholder="10" /><p class="note">${text.thresholdHint}</p></div>
      <div class="field"><label for="qn-periods">${text.periods}</label><input id="qn-periods" value=${value.periods} onInput=${update("periods")} placeholder=${text.periodExample} /><p class="note">${text.periodHint}</p></div>
    </fieldset>${invalid ? html`<p class="feedback error" role="alert">${text.error}</p>` : null}<p class="note">${text.sources}</p></section>`;
}
