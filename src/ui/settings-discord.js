// #1519 P3 (docs/design/ux-onboarding-walkthrough.md §5.3): after a Discord token verifies — the invite (one permission
// set, never Administrator), the Message Content note with the portal's Bot page, the server the bot joins found by
// asking Discord every 2 s for up to 2 minutes, and the server's text channels as a list ("general" first choice). The
// setup wizard and New connection use it.
//
// Every read is an operation of its own (#1533 review): numbered when it starts, and its answer is taken only while it is
// still the current one of its kind and this picker is still on the page. A new token, another server, a manual choice,
// Stop, the 2-minute limit or leaving the page each retire what was asked before — an answer about A never lands after
// B, nor after A again (an older A), nor once the page is gone.
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
  const [polling, setPolling] = useState(null);            // { timedOut } while waiting for the bot to join
  const [channels, setChannels] = useState(null);          // null: not asked; { list } | { error }
  const live = useRef(true);
  const now = useRef({ token, guild, channel });
  now.current = { token, guild, channel };
  // The current operation of each kind; an answer is taken only while its number is still the one here.
  const op = useRef({ poll: 0, check: 0, channels: 0 });
  const poll = useRef({ timer: null, until: 0, known: new Set(), asking: false });
  const chosen = useRef(false);                            // the person picked a General channel since this server's list was asked

  const stopPolling = (timedOut = false) => {
    op.current.poll++;                                     // retires the poll's reads still on their way
    if (poll.current.timer) { clearInterval(poll.current.timer); poll.current.timer = null; }
    setPolling(timedOut ? { timedOut: true } : null);
  };
  useEffect(() => () => { live.current = false; if (poll.current.timer) clearInterval(poll.current.timer); }, []);
  // A new token is another bot: what was being waited for, or listed, was about the old one — and so was its General.
  const lastToken = useRef(token);
  useEffect(() => {
    op.current.check++; op.current.channels++; stopPolling(); setChannels(null);
    if (lastToken.current !== token && now.current.channel) onChannel("");
    lastToken.current = token;
  }, [token]);

  /** One read of the bot's servers, for operation `kind` number `seq`; joined: pick it (unless the person chose meanwhile). */
  const readGuilds = async (kind, seq, known, deadline) => {
    const asked = token;
    const res = await probe({ action: "guilds", token: asked });
    const current = () => live.current && op.current[kind] === seq && now.current.token === asked && (deadline == null || clock() <= deadline);
    if (!current()) return false;
    const list = (res.ok && res.body && Array.isArray(res.body.guilds)) ? res.body.guilds : null;
    if (!list) return false;
    onGuilds(list);
    const joined = list.filter((g) => !known.has(g.id));
    if (!joined.length) return false;
    if (joined.length === 1 || !now.current.guild) pickGuild(joined[0].id, false);
    return true;
  };
  const startPolling = () => {
    stopPolling();
    const seq = op.current.poll, known = new Set((guilds || []).map((g) => g.id)), until = clock() + POLL_FOR_MS;
    poll.current = { timer: null, until, known, asking: false };
    setPolling({ timedOut: false });
    poll.current.timer = setInterval(async () => {
      if (op.current.poll !== seq) return;
      if (clock() > until) { stopPolling(true); return; }
      if (poll.current.asking) return;                     // one read at a time
      poll.current.asking = true;
      const joined = await readGuilds("poll", seq, known, until).finally(() => { poll.current.asking = false; });
      if (joined && op.current.poll === seq) stopPolling();
    }, POLL_MS);
  };
  // Check again: a new, explicit read of its own (it does not revive a stopped poll).
  const checkAgain = () => { const seq = ++op.current.check; void readGuilds("check", seq, poll.current.known, null); };

  /** A server is picked — by the person (`manual`) or because the bot joined it. Either way the old General goes. */
  const pickGuild = (id, manual) => {
    if (manual) { stopPolling(); op.current.check++; }   // a choice of the person's: no read still on its way overrides it
    if (id !== now.current.guild && now.current.channel) onChannel("");
    onGuild(id);
  };
  const pickChannel = (id) => { chosen.current = true; onChannel(id); };

  // The chosen server's text channels; "general" when there is one and none is chosen yet.
  useEffect(() => {
    const seq = ++op.current.channels;
    chosen.current = false;
    setChannels(null);
    if (!guild || !token) return;
    const askedToken = token, askedGuild = guild;
    (async () => {
      const res = await probe({ action: "channels", token: askedToken, guild_id: askedGuild });
      if (!live.current || op.current.channels !== seq || now.current.token !== askedToken || now.current.guild !== askedGuild) return;
      if (!res.ok || !res.body || !Array.isArray(res.body.channels)) { setChannels({ error: (res.body && res.body.error) || tn("failed") }); return; }
      setChannels({ list: res.body.channels });
      // The first choice only fills an empty choice the person has not made.
      if (!chosen.current && !now.current.channel) {
        const general = res.body.channels.find((c) => c.name.toLowerCase() === "general");
        if (general) onChannel(general.id);
      }
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
        ? html`<${Select} id=${`${idPrefix}-guild`} value=${guild} onChange=${(v) => pickGuild(v, true)} options=${["", ...guilds.map((g) => ({ value: g.id, label: `${g.name} (${g.id})` }))]} />`
        : html`<input id=${`${idPrefix}-guild`} type="text" value=${guild} placeholder=${tn("discordNoServerYet")} onInput=${(e) => pickGuild(e.target.value.trim(), true)} />`}</div>
    <div class="field"><label for=${`${idPrefix}-gen`}>${tn("wizardGeneralChannel")}</label>
      ${channels && channels.list && channels.list.length
        ? html`<${Select} id=${`${idPrefix}-gen`} value=${channel} onChange=${pickChannel} options=${["", ...channels.list.map((c) => ({ value: c.id, label: `#${c.name}` }))]} />`
        : html`<input id=${`${idPrefix}-gen`} type="text" value=${channel} onInput=${(e) => pickChannel(e.target.value.trim())} />`}
      ${channels && channels.error ? html`<p class="feedback warning">${channels.error}</p>` : null}</div>
  </div>`;
}
