---
title: "How AgEnD went from unstable at 30-something agents to 42+ running"
date: 2026-10-21
summary: "Three hotspots that froze the fleet for seconds at a time, the failures that took every agent down, and what changed — with the numbers from a 45-instance fleet before and after."
tags: [performance, stability]
---

In AgEnD, one manager process coordinates every agent of a fleet: it delivers their messages, serves the dashboard and talks to the chat platforms. With a handful of agents nobody notices what that process costs. Somewhere past thirty it started to show: the fleet froze for seconds at a time, and now and then it stopped altogether. This post is what we measured, what we changed, and what the numbers look like now.

## 1. Background: unstable at 30-something agents

Two different things went wrong.

**The fleet froze for seconds at a time.** The manager does its work on one event loop. When something on that loop runs synchronously for a long time, everything else waits: messages, the dashboard, tmux, the agents' tool calls. On a fleet of about 39 instances in early October, AgEnD wrote 30, 64 and 77 stall warnings on three days in a row (7 to 9 October); the worst delay was 7.2 s ([#1956](https://github.com/songsid/AgEnD/issues/1956)). Section 2 explains what one warning counts.

**One failure took every agent down.**
- An agent's one-off script grew to 19 GB, the kernel killed it, and systemd stopped the entire service with it ([#2015](https://github.com/songsid/AgEnD/issues/2015)).
- A network outage made the fleet exit, and afterwards its Discord connection gave up retrying and stayed down ([#2191](https://github.com/songsid/AgEnD/issues/2191)).
- Two errors in the `/login` browser terminal and its public link could escape and crash the fleet. They were found and reproduced while we looked into a user's `/login` report ([#2243](https://github.com/songsid/AgEnD/issues/2243)), but they are not what that report was: see section 6.

## 2. How it was measured

AgEnD watches its own event loop. Every 30 seconds it looks at the worst delay the loop had in that window. If it was **1 second or more**, it writes **one warning** for the window, naming the synchronous work that ran in it and how long each piece took. Two things follow from that:
- A warning is a 30-second window, not a single stall: several stalls in one window give one warning, carrying the worst of them.
- Back-to-back calls of the same work (less than 10 ms apart) are recorded together as one stretch, with their summed time.

The live numbers in section 5 were counted from these warnings in the fleet log, read-only. Full fleet restarts were counted separately, from the log's start and stop markers.

That tells us *where* the time goes on a real fleet, but a live fleet is noisy: load depends on how many dashboard tabs are open and how often agents restart. So each fix was also measured on a **rig**: a scratch fleet of 40 instances (80 for some checks) with real tmux on a private socket, where one thing changes at a time. Rig numbers say how much a fix removes; live numbers say what people actually see. Below, rig numbers are always labelled as such.

## 3. The hotspots and their fixes

Almost every warning named the same three things ([#1956](https://github.com/songsid/AgEnD/issues/1956)).

**The dashboard's status, rebuilt for every open tab.** Every open dashboard tab gets the fleet's status every 10 seconds, and the fleet built it from scratch for each tab, every time. Building it read each instance's files from disk synchronously, some of them up to three times.
- [#2225](https://github.com/songsid/AgEnD/pull/2225): one build per tick, shared by every open tab. Each viewer still gets only what it may see; a guest's view is cut down from the same build, never taken from someone else's.
- [#2226](https://github.com/songsid/AgEnD/pull/2226): each instance's statusline file is read once per build instead of up to three times.

**Codex's model list, re-read on every build.** For every Codex instance, each status build re-read and parsed Codex's whole model cache (about 400 KB) and its config file. On the rig this was 71% of the status build's time.
- [#2224](https://github.com/songsid/AgEnD/pull/2224): the result is kept per version of those files and read again only when a file changes.

**Starting tmux commands.** Every message delivered to an agent runs tmux commands. Node starts a child process by copying the parent synchronously, and that takes longer the more memory the parent uses: about 3 ms per 100 MB on the rig. The manager uses around 550 MB, and in the warnings of 19 October (section 5) a recorded stretch of tmux work took 111 ms at the median and up to 747 ms. During a restart or a mass start they stacked up.
- [#2230](https://github.com/songsid/AgEnD/pull/2230): a small helper process starts tmux commands for the fleet. The fleet only sends it a message, so starting a command no longer copies the fleet's memory. If the helper isn't there, each call falls back to the old direct way.

**The rig numbers.** Each row is one PR's own before/after, measured on its own; they are not one combined run and are not meant to be added up.

| Fix (rig) | Measurement | Before | After |
|---|---|---|---|
| [#2224](https://github.com/songsid/AgEnD/pull/2224) | Status build, median, 40 instances | 9.0 ms | 2.2 ms |
| [#2226](https://github.com/songsid/AgEnD/pull/2226) | File-system calls per build | 247 | 167 |
| [#2225](https://github.com/songsid/AgEnD/pull/2225) | One tick with 5 tabs open | 42.0 ms | 10.9 ms |
| [#2230](https://github.com/songsid/AgEnD/pull/2230) | tmux command on the loop, 551 MB | 26.2 ms | 0.38 ms |

## 4. Stability: outages and OOM no longer take the fleet down

**One runaway command no longer stops the fleet.** systemd's default for a service is to stop *all* of it when the kernel kills one of its processes for running out of memory. Everything an agent runs lives inside the fleet's service, so one agent's 19 GB script took every agent down with it.
- [#2018](https://github.com/songsid/AgEnD/pull/2018): the service is now written with `OOMPolicy=continue`. Only the killed process dies; the manager and the other agents keep running. An installed service gets the setting with the next `agend update`.
- This applies to AgEnD's systemd service on Linux, and to a command an agent runs being killed. If the kernel picks the manager itself, the service still stops, and systemd starts it again.
- [#2036](https://github.com/songsid/AgEnD/pull/2036): when the host runs short of memory, the log, `/health` and the dashboard name the largest processes and which agent they belong to, so you can see what is eating memory before the kernel steps in.

**A network outage no longer stops the fleet, and Discord comes back by itself.**
- [#2195](https://github.com/songsid/AgEnD/pull/2195): an error from a Discord connection being replaced during the outage escaped to the fleet's last-resort error handler, which stops everything. That error is now handled where it happens. A connection that fails to start keeps retrying with a capped backoff instead of giving up after ten tries, and **Settings → Connections → Retry now** asks for an attempt at once. Fleet tools that don't need a chat platform (sending to another agent, task status and the like) keep working while it is away. If the fleet ever does stop on an unexpected error, it now writes the reason to `fleet-fatal.log` first.
- [#2204](https://github.com/songsid/AgEnD/pull/2204): a Discord connection that was already replaced can no longer start a new socket late, which could otherwise throw the same error into that handler.

**Two `/login` errors now end only that login.**
- [#2245](https://github.com/songsid/AgEnD/pull/2245): a late error from the browser terminal's server, or from the tunnel's output streams, escaped uncaught and took the fleet down. Now it ends that one login, and the chat says why and what to try next.
- These two were reproduced on their own. They are not the cause of the hang in the user's report, and they don't fix it: that report turned out to be the WSL hang in section 6, which is still open.

## 5. Real before/after numbers

These come from a production fleet of about 45 instances, counted from the warnings described in section 2. Times are local (UTC+8). The [summary on #1956](https://github.com/songsid/AgEnD/issues/1956#issuecomment-6310681211) has the headline counts.

| | Before | After |
|---|---|---|
| Window | 19 Oct, all day | 20 Oct 15:30 – 21 Oct 15:30 |
| AgEnD 2.3.0 | beta.9 – .11 (no fixes) | beta.16 – .18 (fixed) |
| Warnings (≥ 1 s) | 16 (0.67 an hour) | **0** |
| Worst delay: median / p90 / max | 1.47 / 2.74 / 5.75 s | — |
| Sum of worst delays | 28.7 s | 0 s |
| Full fleet restarts | 5 | 2 (both updates) |

The 16 warnings before were all between 14:01 and 16:18; after, there were none in any of the 24 hours. "Worst delay" is each warning's worst delay in its window, and their sum is not the total time the fleet was stalled. The warnings before named the work from section 3. Each figure is a recorded stretch of that work, back-to-back calls together (median / p90 / longest):
- the Codex model list, in 15 of the 16;
- the status build, in 14 (566 / 1,634 / 2,250 ms);
- the dashboard stream, in 13 (651 / 1,567 / 2,279 ms);
- tmux commands, in 10 (111 / 266 / 747 ms).

Please read them with these caveats:
- **It is a live fleet, not a lab.** Stalls depend on load, especially open dashboard tabs and restarts. The before window had more restarts (5 against 2), and how many dashboard tabs were open isn't recorded.
- **The after window spans three releases** (beta.16, .17 and .18); all three include the fixes.
- **Zero means no window's worst delay reached 1 second.** Shorter stalls aren't logged, so this doesn't claim the fleet never lags.
- **The rig numbers in section 3 are the controlled measurements;** this table shows the effect people actually see.

## 6. What's still open

**A hang on WSL after `/login`** ([#1880](https://github.com/songsid/AgEnD/issues/1880)). On one WSL host, about a minute after `/login` opened the browser terminal, the manager stopped responding and couldn't even be stopped normally: a thread was waiting inside the kernel. It wasn't using CPU, and nothing in AgEnD's code on that path is known to block, so there is no fix yet. The user report above ([#2243](https://github.com/songsid/AgEnD/issues/2243)) is the same kind of hang. The issue has a short read-only capture to run **before** restarting if it happens again; with that we can see where it waits.

**Per-command memory limits** ([#2015](https://github.com/songsid/AgEnD/issues/2015)). `OOMPolicy=continue` keeps the fleet alive when one command runs out of memory, but it doesn't stop a command from using too much in the first place. Capping each agent's commands is still a design question, and nothing is built yet.

If your fleet stalls or stops, the warnings described in section 2 are in the fleet log, and they name what was running. Attach them to an issue: that is how every fix above started.
