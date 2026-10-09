// #1408 step 3: the setup wizard — the same four steps as `agend quickstart`, one dialog. It pre-fills from the running
// configuration and, when it finishes, writes the files (a write an admin may have to confirm, #1423) and hands over
// to the ordinary Apply: the app's runner (settings-apply.js) posts the apply and watches its job, with the same
// progress, deadline and restart recovery as every other change.
import { html, useEffect, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { Dialog } from "/assets/ui-dialog.js";
import { api } from "./settings-confirm.js";
import { startOperation } from "./settings-apply.js";
import { BACKENDS, DEFAULT_SCHEMA, impactOf, toYaml } from "./settings-model.js";
import { Select } from "./settings-dialogs.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const STEPS = 4;
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }).catch(() => ({ ok: false, status: 0, body: { error: tn("failed") } }));

/** Return the platform-specific default token_env, or keep the current value if it was manually typed.
 * Ensures each platform gets a distinct env variable name so adding a second connection never
 * replaces the first (S1 data-overwrite fix). */
function defaultTokenEnv(currentEnv, newPlatform) {
  const knownDefaults = ["AGEND_TELEGRAM_TOKEN", "AGEND_DISCORD_TOKEN",
    "AGEND_TELEGRAM_TOKEN_2", "AGEND_DISCORD_TOKEN_2", "AGEND_BOT_TOKEN"];
  if (!currentEnv || knownDefaults.includes(currentEnv)) {
    return newPlatform === "telegram" ? "AGEND_TELEGRAM_TOKEN" : "AGEND_DISCORD_TOKEN";
  }
  return currentEnv;
}

export function SetupWizard({ ctx, onClose }) {
  const lease = useLease("wizard");
  const [w, setW] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    (async () => {
      const env = await api("/api/settings/quickstart/environment").catch(() => null);
      if (!lease.current()) return;
      const e = (env && env.body) || { backends: [], channels: [], has_fleet: false };
      setW({ step: 1, env: e, backend: (e.backends || [])[0] || "claude-code", working_directory: "", instance_name: "agent-1",
        platform: "telegram", token: "", token_env: "AGEND_TELEGRAM_TOKEN", group_id: "", guild_id: "", general_channel_id: "", admin_user_id: "",
        identity: null, guilds: [], plan: null, offset: 0 });
    })();
  }, [lease]);
  if (!w) return html`<${Dialog} title=${tn("wizardTitle")} onClose=${onClose}><p class="note">…</p></${Dialog}>`;
  const set = (k) => (v) => setW((x) => ({ ...x, [k]: v }));
  const input = () => ({
    platform: w.platform, token_env: w.token_env, backend: w.backend, working_directory: w.working_directory, instance_name: w.instance_name,
    group_id: w.group_id || undefined, guild_id: w.guild_id || undefined, general_channel_id: w.general_channel_id || undefined,
    admin_user_id: w.admin_user_id || undefined,
  });

  const verify = async () => {
    setBusy(tn("wizardVerifying")); setErr("");
    const res = await post("/api/settings/quickstart/probe", { action: "verify", platform: w.platform, token: w.token });
    if (!lease.current()) return;
    const identity = (res.body && res.body.identity) || { valid: false };
    let guilds = [];
    if (identity.valid && w.platform === "discord") {
      const g = await post("/api/settings/quickstart/probe", { action: "guilds", token: w.token });
      if (!lease.current()) return;
      guilds = (g.body && g.body.guilds) || [];
    }
    setBusy("");
    setW((x) => ({ ...x, identity, guilds }));
  };
  const detect = async () => {
    setBusy(tn("wizardWaitingStart")); setErr("");
    const res = await post("/api/settings/quickstart/probe", { action: "await-telegram-start", token: w.token, offset: w.offset || 0 });
    if (!lease.current()) return;
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
      setBusy(tn("wizardPlanLoading"));
      const res = await post("/api/settings/quickstart/plan", input());
      if (!lease.current()) return;
      setBusy("");
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
    const body = { ...input(), token: w.token };
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
          onClick=${() => setW((x) => ({ ...x, platform: p, identity: null,
            token_env: defaultTokenEnv(x.token_env, p) }))}>${p === "telegram" ? "Telegram" : "Discord"}</button>`)}</div>
      <p class="note">${w.platform === "telegram" ? tn("wizardTelegramHint") : tn("wizardDiscordHint")}</p>`;
  } else if (w.step === 3) {
    body = html`<div class="field"><label for="wz-token">${tn("wizardToken")}</label>
        <input id="wz-token" type="password" autocomplete="new-password" placeholder="123456:ABC-DEF…" value=${w.token} onInput=${(e) => setW({ ...w, token: e.target.value.trim(), identity: null })} />
        <p class="note">${w.platform === "telegram" ? tn("wizardTokenTelegram") : tn("wizardTokenDiscord")}</p></div>
      <div class="field"><label for="wz-env">${tn("tokenEnv")}</label><input id="wz-env" type="text" value=${w.token_env} onInput=${(e) => set("token_env")(e.target.value.trim())} /></div>
      <div class="dlg-inline-actions"><button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${verify}>${tn("wizardVerify")}</button>
        ${w.identity ? html`<span class=${`feedback${w.identity.valid ? "" : " error"}`} role="status">${w.identity.valid ? (w.identity.username || tn("verified")) : (w.identity.reason || tn("verifyFailed"))}</span>` : null}</div>
      ${w.platform === "discord" ? html`
        <div class="field"><label for="wz-guild">${tn("guildIdField")}</label><${Select} id="wz-guild" value=${w.guild_id} onChange=${set("guild_id")}
          options=${["", ...w.guilds.map((g) => ({ value: g.id, label: `${g.name} (${g.id})` }))]} /></div>
        <div class="field"><label for="wz-gen">${tn("wizardGeneralChannel")}</label><input id="wz-gen" type="text" value=${w.general_channel_id} onInput=${(e) => set("general_channel_id")(e.target.value.trim())} /></div>
        <div class="field"><label for="wz-user">${tn("wizardAdminUser")}</label><input id="wz-user" type="text" placeholder=${tn("discordUserPlaceholder")} value=${w.admin_user_id} onInput=${(e) => set("admin_user_id")(e.target.value.trim())} /></div>`
      : html`
        <div class="field"><label for="wz-group">${tn("groupIdField")}</label><input id="wz-group" type="text" placeholder="-1001234567890" value=${w.group_id} onInput=${(e) => set("group_id")(e.target.value.trim())} />
          <p class="note">${tn("wizardDetectHint")}</p></div>
        <div class="dlg-inline-actions"><button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${detect}>${tn("wizardDetect")}</button></div>
        <div class="field"><label for="wz-user">${tn("wizardAdminUser")}</label><input id="wz-user" type="text" placeholder=${tn("telegramUserPlaceholder")} value=${w.admin_user_id} onInput=${(e) => set("admin_user_id")(e.target.value.trim())} /></div>`}`;
  } else {
    body = !w.plan ? html`<p class="note">${tn("wizardPlanLoading")}</p>` : html`
      <p><strong>${tn("wizardWillWrite")}</strong></p>
      <pre class="s-yaml">${toYaml({ channels: [w.plan.channel], instances: { [w.plan.instance.name]: { working_directory: w.plan.instance.working_directory, backend: w.plan.instance.backend } } })}</pre>
      <p class="note">${tn("wizardEnvKeys", (w.plan.env_keys || []).join(", "))}</p>
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
