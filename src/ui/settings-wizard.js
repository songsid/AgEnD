// #1408 step 3: the setup wizard — the same four steps as `agend quickstart`, one dialog. It pre-fills from the running
// configuration and, when it finishes, writes the files (a write an admin may have to confirm, #1423) and hands over
// to the ordinary Apply: the app's runner (settings-apply.js) posts the apply and watches its job, with the same
// progress, deadline and restart recovery as every other change.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { Dialog } from "/assets/ui-dialog.js";
import { api } from "./settings-confirm.js";
import { startOperation } from "./settings-apply.js";
import { BACKENDS, DEFAULT_SCHEMA, impactOf, toYaml } from "./settings-model.js";
import { Drawer, Select } from "./settings-dialogs.js";
import { botHandle, TokenEnvNote, TokenField, verifyBotToken } from "./settings-token.js";
import { DiscordServerPicker } from "./settings-discord.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const STEPS = 4;
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }).catch(() => ({ ok: false, status: 0, body: { error: tn("failed") } }));

export function SetupWizard({ ctx, onClose }) {
  const lease = useLease("wizard");
  const [w, setW] = useState(null);
  // The credential's revision (#1529 review): a token or platform change moves it, and a Verify, Detect or plan that
  // began before is dropped when it lands — an answer about an old token never names, or plans for, a new one.
  const rev = useRef(0);
  const bump = () => { rev.current++; };
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    (async () => {
      const env = await api("/api/settings/quickstart/environment").catch(() => null);
      if (!lease.current()) return;
      const e = (env && env.body) || { backends: [], channels: [], has_fleet: false };
      setW({ step: 1, env: e, backend: (e.backends || [])[0] || "claude-code", working_directory: "", instance_name: "agent-1",
        platform: "telegram", token: "", group_id: "", guild_id: "", general_channel_id: "", admin_user_id: "",
        identity: null, guilds: [], plan: null, offset: 0 });
    })();
  }, [lease]);
  if (!w) return html`<${Dialog} title=${tn("wizardTitle")} onClose=${onClose}><p class="note">…</p></${Dialog}>`;
  // Every field the plan or a probe is about moves the revision (#1529 review r2): a plan or Detect that began before an
  // edit — target, admin, backend, directory, name — is dropped when it lands, never committed or written over the edit.
  const set = (k) => (v) => { bump(); setW((x) => ({ ...x, [k]: v })); };
  // No token env: the plan generates one (#1519 P1: AGEND_<PLATFORM>_<ID>_TOKEN, unique) and the commit carries the plan's.
  const input = () => ({
    platform: w.platform, backend: w.backend, working_directory: w.working_directory, instance_name: w.instance_name,
    group_id: w.group_id || undefined, guild_id: w.guild_id || undefined, general_channel_id: w.general_channel_id || undefined,
    admin_user_id: w.admin_user_id || undefined,
  });

  const verify = async () => {
    const at = rev.current, token = w.token, platform = w.platform;
    const live = () => lease.current() && rev.current === at;
    setBusy(tn("wizardVerifying")); setErr("");
    const identity = await verifyBotToken(platform, token);
    if (!live()) { if (lease.current()) setBusy(""); return; }
    let guilds = [];
    if (identity.valid && platform === "discord") {
      const g = await post("/api/settings/quickstart/probe", { action: "guilds", token });
      if (!live()) { if (lease.current()) setBusy(""); return; }
      guilds = (g.body && g.body.guilds) || [];
    }
    setBusy("");
    setW((x) => (x.token === token && x.platform === platform ? { ...x, identity, guilds } : x));
  };
  const detect = async () => {
    const at = rev.current;
    setBusy(tn("wizardWaitingStart")); setErr("");
    const res = await post("/api/settings/quickstart/probe", { action: "await-telegram-start", token: w.token, offset: w.offset || 0 });
    if (!lease.current()) return;
    if (rev.current !== at) { setBusy(""); return; }
    setBusy("");
    if (!res.ok) { setErr((res.body && res.body.error) || tn("applyFailed")); return; }
    if (res.body.found) setW((x) => ({ ...x, offset: res.body.offset, group_id: String(res.body.found.groupId), admin_user_id: String(res.body.found.userId) }));
    else { setW((x) => ({ ...x, offset: res.body.offset })); setErr(tn("wizardNoStartYet")); }
  };
  const next = async () => {
    setErr("");
    if (w.step === 1) { if (!w.working_directory.startsWith("/")) { setErr(tn("wizardNeedDir")); return; } setW({ ...w, step: 2 }); return; }
    if (w.step === 2) { setW({ ...w, step: 3 }); return; }
    if (w.step === 3) {
      if (!w.identity || !w.identity.valid) { setErr(tn("wizardNeedVerify")); return; }
      const at = rev.current;
      setBusy(tn("wizardPlanLoading"));
      const res = await post("/api/settings/quickstart/plan", input());
      if (!lease.current()) return;
      setBusy("");
      if (rev.current !== at) return;
      if (!res.ok) { setErr((res.body && res.body.error) || tn("applyFailed")); return; }
      setW((x) => ({ ...x, plan: res.body, step: 4 }));
      return;
    }
    await finish();
  };
  /**
   * Write the files, then the ordinary Apply — one operation, handed to the app before the commit is even sent
   * (#1453 review): the commit (which may wait for an admin's confirmation), then the apply and its job. While it runs
   * no other Apply can start, leaving the page warns. The token leaves the form now; the operation holds it in the
 * commit's body until that write completes, then drops it.
   */
  const finish = () => {
    // The plan's target, all of it (#1529 review): its connection id and its generated token env — the commit refuses
    // either if it was taken since, instead of quietly picking another.
    const body = { ...input(), channel_id: w.plan.channel_id, token_env: w.plan.token_env, token_env_generated: true, token: w.token };
    // It writes the connection and the first agent: it costs what a connection change does (the server's schema).
    const handed = startOperation([{ label: tn("wizardTitle"), impact: impactOf((ctx && ctx.schema) || DEFAULT_SCHEMA, "fleet.channels"),
      request: { method: "POST", url: "/api/settings/quickstart/commit", body, sensitive: true } }]);
    if (!handed) { setErr(tn("applyBusyLocal")); return; }
    setW((x) => ({ ...x, token: "" }));
    onClose();
  };

  let body;
  if (w.step === 1) {
    body = html`<div class="field"><label for="wz-be">${tn("wizardBackend")}</label>
        <${Select} id="wz-be" value=${w.backend} onChange=${set("backend")} options=${w.env.backends && w.env.backends.length ? w.env.backends : BACKENDS} />
        <p class="note">${w.env.backends && w.env.backends.length ? tn("wizardBackendFound", w.env.backends.join(", ")) : tn("wizardBackendNone")}</p></div>
      <div class="field"><label for="wz-wd">${tn("workingDir")}</label><input id="wz-wd" type="text" placeholder="/home/you/projects/app" value=${w.working_directory} onInput=${(e) => set("working_directory")(e.target.value.trim())} /></div>
      <div class="field"><label for="wz-name">${tn("wizardAgentName")}</label><input id="wz-name" type="text" value=${w.instance_name} onInput=${(e) => set("instance_name")(e.target.value.trim())} /></div>`;
  } else if (w.step === 2) {
    body = html`<div class="seg-inline" role="group" aria-label=${tn("wizardPlatform")}>
        ${["telegram", "discord"].map((p) => html`<button key=${p} type="button" class=${`btn${w.platform === p ? " btn-primary" : ""}`} aria-pressed=${w.platform === p ? "true" : "false"}
          onClick=${() => { bump(); setW((x) => ({ ...x, platform: p, identity: null })); }}>${p === "telegram" ? "Telegram" : "Discord"}</button>`)}</div>
      <p class="note">${w.platform === "telegram" ? tn("wizardTelegramHint") : tn("wizardDiscordHint")}</p>`;
  } else if (w.step === 3) {
    body = html`<${TokenField} id="wz-token" platform=${w.platform} value=${w.token} identity=${w.identity} busy=${!!busy}
        onInput=${(v) => { bump(); setW((x) => ({ ...x, token: v, identity: null })); }} onVerify=${verify} />
      ${w.platform === "discord" ? html`
        <${DiscordServerPicker} idPrefix="wz" token=${w.identity && w.identity.valid ? w.token : ""} bot=${w.identity && botHandle(w.identity.username)}
          invite=${w.identity && w.identity.invite} portal=${w.identity && w.identity.portal} guilds=${w.guilds} onGuilds=${(g) => setW((x) => ({ ...x, guilds: g }))}
          guild=${w.guild_id} onGuild=${set("guild_id")} channel=${w.general_channel_id} onChannel=${set("general_channel_id")} />
        <div class="field"><label for="wz-user">${tn("wizardAdminUser")}</label><input id="wz-user" type="text" placeholder=${tn("discordUserPlaceholder")} value=${w.admin_user_id} onInput=${(e) => set("admin_user_id")(e.target.value.trim())} /></div>`
      : html`
        <div class="field"><label for="wz-group">${tn("groupIdField")}</label><input id="wz-group" type="text" placeholder="-1001234567890" value=${w.group_id} onInput=${(e) => set("group_id")(e.target.value.trim())} />
          <p class="note">${tn("wizardDetectHint")}</p></div>
        <div class="dlg-inline-actions"><button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${detect}>${tn("wizardDetect")}</button></div>
        <div class="field"><label for="wz-user">${tn("wizardAdminUser")}</label><input id="wz-user" type="text" placeholder=${tn("telegramUserPlaceholder")} value=${w.admin_user_id} onInput=${(e) => set("admin_user_id")(e.target.value.trim())} /></div>`}`;
  } else {
    body = !w.plan ? html`<p class="note">${tn("wizardPlanLoading")}</p>` : html`
      <p><strong>${tn("wizardWillWrite")}</strong></p>
      <pre class="s-yaml">${toYaml({ channels: [w.plan.channel], instances: { [w.plan.instance.name]: { working_directory: w.plan.instance.working_directory, backend: w.plan.instance.backend, channel_id: w.plan.instance.channel_id } } })}</pre>
      <${Drawer} title=${tn("advancedSection")}><${TokenEnvNote} name=${w.plan.token_env} /></${Drawer}>
      ${(w.plan.warnings || []).map((x, i) => html`<p key=${i} class="feedback warning">${x}</p>`)}`;
  }
  return html`<${Dialog} title=${tn("wizardTitle")} onClose=${onClose} wide=${true} busy=${busy === tn("wizardCommitting")}
    actions=${html`<button type="button" class="btn" disabled=${w.step === 1 || !!busy} onClick=${() => setW({ ...w, step: w.step - 1 })}>${tn("wizardBack")}</button>
      <button type="button" class="btn btn-primary" disabled=${!!busy} onClick=${next}>${w.step === STEPS ? tn("wizardFinish") : tn("wizardNext")}</button>`}>
    <p class="note">${tn("wizardStep", w.step, STEPS)}${w.env.has_fleet ? ` · ${tn("wizardRerun")}` : ""}</p>
    <div class="form">${body}</div>
    ${busy ? html`<p class="note" role="status">${busy}</p>` : null}
    ${err ? html`<p class="feedback error" role="alert">${err}</p>` : null}
  </${Dialog}>`;
}
