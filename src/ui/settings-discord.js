// #1519 P3 (docs/design/ux-onboarding-walkthrough.md §5.3): after a Discord token verifies — the invite (one permission
// set, never Administrator), the Message Content note with the portal's Bot page, the server the bot joins found by
// asking Discord every 2 s for up to 2 minutes, and the server's text channels as a list ("general" first choice). The
// setup wizard and New connection use it. Every answer is checked against the token and server it was asked for: one
// that lands after either changed is dropped.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { api } from "./settings-confirm.js";
import { Select } from "./settings-dialogs.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
export const POLL_MS = 2000, POLL_FOR_MS = 120_000;
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());   // elapsed time: monotonic
const probe = (body) => api("/api/settings/quickstart/probe", { method: "POST", body: JSON.stringify(body) }).catch(() => ({ ok: false, body: {} }));

/**
 * props: idPrefix, token, bot (@name), invite, portal, guilds, onGuilds(list), guild, onGuild(id), channel, onChannel(id).
 * The parent owns the values; this owns the asking.
 */
export function DiscordServerPicker({ idPrefix, token, bot, invite, portal, guilds, onGuilds, guild, onGuild, channel, onChannel }) {
  const [polling, setPolling] = useState(null);            // { until, known: Set } while waiting for the bot to join
  const [channels, setChannels] = useState(null);          // null: not asked; { list } | { error }
  const now = useRef({ token, guild });
  now.current = { token, guild };
  const timer = useRef(null);
  const asking = useRef(false);                            // one guild read at a time
  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } setPolling(null); };
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  // A new token is another bot: what was being waited for, or listed, was about the old one.
  useEffect(() => { stop(); setChannels(null); }, [token]);

  const askGuilds = async (known) => {
    if (asking.current) return;
    asking.current = true;
    const asked = token;
    const res = await probe({ action: "guilds", token: asked }).finally(() => { asking.current = false; });
    if (now.current.token !== asked) return;
    const list = (res.ok && res.body && Array.isArray(res.body.guilds)) ? res.body.guilds : null;
    if (!list) return;
    onGuilds(list);
    const joined = list.filter((g) => !known.has(g.id));
    if (joined.length) { if (joined.length === 1 || !now.current.guild) onGuild(joined[0].id); stop(); }
  };
  const startPolling = () => {
    const known = new Set((guilds || []).map((g) => g.id));
    if (timer.current) clearInterval(timer.current);
    const until = clock() + POLL_FOR_MS;
    setPolling({ until, known });
    timer.current = setInterval(() => {
      if (clock() > until) { clearInterval(timer.current); timer.current = null; setPolling((p) => (p ? { ...p, timedOut: true } : p)); return; }
      void askGuilds(known);
    }, POLL_MS);
  };
  const checkAgain = () => void askGuilds(new Set((polling && polling.known) || []));

  // The chosen server's text channels; "general" when there is one and none is chosen yet.
  useEffect(() => {
    setChannels(null);
    if (!guild || !token) return;
    const askedToken = token, askedGuild = guild;
    (async () => {
      const res = await probe({ action: "channels", token: askedToken, guild_id: askedGuild });
      if (now.current.token !== askedToken || now.current.guild !== askedGuild) return;
      if (!res.ok || !res.body || !Array.isArray(res.body.channels)) { setChannels({ error: (res.body && res.body.error) || tn("failed") }); return; }
      setChannels({ list: res.body.channels });
      if (!channel) { const general = res.body.channels.find((c) => c.name.toLowerCase() === "general"); if (general) onChannel(general.id); }
    })();
  }, [guild, token]);

  return html`<div class="discord-setup">
    ${invite ? html`<div class="dlg-inline-actions">
      <a class="btn btn-sm btn-primary" href=${invite} target="_blank" rel="noopener noreferrer" onClick=${startPolling}>${tn("discordInvite", bot || tn("discordTheBot"))}</a>
      ${polling && !polling.timedOut ? html`<span class="note" role="status">${tn("discordWaitingJoin")}</span>` : null}
      ${polling ? html`<button type="button" class="btn btn-sm btn-ghost" onClick=${checkAgain}>${tn("discordCheckAgain")}</button>` : null}</div>
      <p class="note">${tn("discordIntentNote")} ${portal ? html`<a href=${portal} target="_blank" rel="noopener noreferrer">${tn("discordPortalBot")}</a>` : null}</p>` : null}
    <div class="field"><label for=${`${idPrefix}-guild`}>${tn("guildIdField")}</label>
      ${guilds && guilds.length
        ? html`<${Select} id=${`${idPrefix}-guild`} value=${guild} onChange=${onGuild} options=${["", ...guilds.map((g) => ({ value: g.id, label: `${g.name} (${g.id})` }))]} />`
        : html`<input id=${`${idPrefix}-guild`} type="text" value=${guild} placeholder=${tn("discordNoServerYet")} onInput=${(e) => onGuild(e.target.value.trim())} />`}</div>
    <div class="field"><label for=${`${idPrefix}-gen`}>${tn("wizardGeneralChannel")}</label>
      ${channels && channels.list && channels.list.length
        ? html`<${Select} id=${`${idPrefix}-gen`} value=${channel} onChange=${onChannel} options=${["", ...channels.list.map((c) => ({ value: c.id, label: `#${c.name}` }))]} />`
        : html`<input id=${`${idPrefix}-gen`} type="text" value=${channel} onInput=${(e) => onChannel(e.target.value.trim())} />`}
      ${channels && channels.error ? html`<p class="feedback warning">${channels.error}</p>` : null}</div>
  </div>`;
}
