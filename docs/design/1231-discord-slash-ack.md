# #1231 — Discord slash commands: "The application did not respond"

A slash command must be acknowledged within **3 seconds of being sent**. That
window covers Discord → gateway → AgEnD delivery, AgEnD reaching the event,
and the acknowledgement's own round trip to Discord's REST API. Anything that
eats it shows up as "did not respond", and before this change nothing was
logged anywhere.

This is what was found looking at the whole path, not just the handler.

## What was wrong in the handler (fixed)

| | Finding | Fix |
|---|---|---|
| 1 | `deferReply` came after reading the channel, user and options. | Acknowledge first. Only the reads that decide public vs private (`commandName`, `/restart mode`) come before. |
| 2 | `deferReply` had no `try/catch`. A failure ended in the outer catch: the command was dropped with one generic log line and nothing for the user. | A failed acknowledgement is reported: a private follow-up if the acknowledgement landed after all, else a message in the channel, plus a log line with the timing. **The command is not run.** The user was shown "did not respond" and may well run it again, so running it would do it twice. |
| 3 | Two sessions of the same bot both get every interaction and race to acknowledge it. The loser's `deferReply` threw (40060). | 40060 ("already acknowledged") is recognised: the other session handles it, so this one stays silent. The config validator now warns when two connections share a bot token (by env name, or by value when both are set). |
| 4 | No signal for **where** the time went. | A slash command acknowledged ≥ 1.5 s after it was sent logs its age when AgEnD saw it and how long the acknowledgement took. That separates "delivery was late" (network, gateway, blocked event loop) from "the acknowledgement was slow" (REST path). |

## Design-level findings

**Event-loop contention: real, and now visible.** Every instance's daemon, every
adapter and the web UI share one Node event loop. Discord's `interactionCreate`
only runs when the loop gets to it, so any synchronous stretch long enough to
eat the window loses the command. Demonstrated in the field: `get_instance_logs`
read a 10 MB `output.log` synchronously and blew a 30 s IPC budget (#1206). Any
slash command arriving then was lost.

Synchronous calls still in the fleet process (timed here, idle host):
- `tmux capture-pane` per instance for `/status` / `/ctx` / the `/view` sidebar: 2–4 ms each, × every instance.
- `npm prefix -g` when resolving a binary at spawn: ~90 ms.
- `which` / `ps` / `pgrep`: ~10 ms each.
- kiro's `--version` / `chat --help` probes at spawn.
- `bash -lc command -v` at install/login: up to its 10 s timeout.
- better-sqlite3 (outbox, event log) and whole-file reads in some readers.

None of these is long on an idle machine, but they are proportional to the
instance count and to host load, and the loop has no budget for them.

→ **Fixed here:** the fleet now logs every event-loop stall of ≥ 1 s, with its
length (`perf_hooks.monitorEventLoopDelay`, checked every 30 s). This turns
"did not respond" from a mystery into a log line with a cause.

→ **Follow-up, not in this PR:** move the per-instance synchronous scrapes
(`scrapePaneContext`, `getTreeRssKb`) and the spawn-time probes off the loop.
The stall log will say which ones matter.

**Bot presence / playing status: not a cause.** AgEnD sets one `Watching …`
activity every 15 minutes (plus one coalesced update when instances come
online). That is one gateway send (op 3), far under the 120-per-60 s gateway
send limit. An acknowledgement goes over REST, not the gateway, so it cannot
queue behind a presence update. The `GuildPresences` intent (other members'
presence, the high-volume one) is **not** requested. The usage snapshot that
feeds the activity is async network I/O.

**Message listening (MESSAGE_CREATE): not a cause by itself.** With
`GuildMessages` + `MessageContent`, the bot receives every message in every
guild it is in. Events are processed in arrival order, so a flood delays an
interaction only if processing falls behind real time. The `messageCreate`
handler's synchronous part is light: it filters foreign guilds first, and its
`fetchReference` / attachment work is async. A flood costs CPU, not ordering,
unless the loop is already blocked. That is the stall the new log reports.

**Gateway watchdog: connection-level only.** It watches heartbeat ACKs and shard
status. It cannot see an interaction that arrived on a healthy gateway and was
acknowledged too late. → **Covered here** by the slow-acknowledgement log line
(finding 4).

**discord.js configuration: no extra cost found.** Intents are `Guilds`,
`GuildMessages`, `MessageContent`, `GuildMessageReactions`. There is no
presence/member intent, the bot runs one shard (fine below 2 500 guilds), and
the default caches and sweepers are used. Partial reactions fetch the message
over REST, asynchronously.

**REST rate limits: unlikely.** Interaction callbacks (`deferReply`) use the
interaction's own route and token, not a shared per-channel bucket.

**Network (the corporate-network report): environment, but one lever exists.**
discord.js REST uses undici's global dispatcher (`agent: null`), whose keep-alive
is 4 s. After 4 s without a REST call, the next acknowledgement opens a new TCP +
TLS connection, and on a corporate network also a proxy CONNECT, inside the
3 s window. From this host the cold request took 70 ms and a reused connection
25–45 ms; behind an inspecting proxy the difference is far larger.

→ **Follow-up:** give the REST manager an undici `Agent` with a longer keep-alive
(this needs `undici` as a direct dependency, so a separate change). The new
slow-acknowledgement line (its "ms to acknowledge" share) will show whether this
is the cause in that environment before anything is changed.

**Multiple connections on one token: real misconfiguration risk.** → **Covered
here:** the validator warning, and 40060 handled silently (finding 3).

## Summary

| Kind | Items |
|---|---|
| Real defects, fixed | defer not first; `deferReply` without try/catch (silent drop); no signal for late acknowledgements or event-loop stalls; two sessions racing on one token |
| Real, follow-up | synchronous per-instance scrapes and spawn probes on the fleet loop; REST keep-alive shorter than the gaps between commands |
| Not causes | presence/activity updates; MESSAGE_CREATE volume on its own; intents/partials/sharding/sweepers; REST rate limits on the callback route |
| Environment | network latency to discord.com (proxies, TLS inspection) — measurable now, not fixable in AgEnD beyond the keep-alive follow-up |
