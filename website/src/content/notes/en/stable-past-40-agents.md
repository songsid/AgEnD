---
title: "How AgEnD went from unstable at 30-something agents to 42+ running"
date: 2026-10-21
summary: "Three hotspots that froze the fleet for seconds at a time, three ways one failure took every agent down, and what changed — with the numbers from a 45-instance fleet before and after."
tags: [performance, stability]
---

AgEnD runs every agent of a fleet from one process. With a handful of agents nobody notices what that process costs. Somewhere past thirty it started to show: the fleet froze for seconds at a time, and now and then it stopped altogether. This post is what we measured, what we changed, and what the numbers look like now.

## 1. Background: unstable at 30-something agents

Two different things went wrong.

**The fleet froze for seconds at a time.** The fleet process does its work on one event loop. When something on that loop runs synchronously for a long time, everything else waits: messages, the dashboard, tmux, the agents' tool calls. On a fleet of about 39 instances in early October, AgEnD logged 30, 64 and 77 stalls of a second or more on three days in a row (7 to 9 October), the longest 7.2 s.

**One failure took every agent down.** A single fault anywhere could stop the whole fleet:
- an agent's one-off script grew to 19 GB, the kernel killed it, and systemd stopped the entire service with it;
- a network outage made the fleet exit, and afterwards its Discord connection gave up retrying and stayed down;
- an error while opening the `/login` terminal or its public link crashed the fleet.

## 2. How it was measured

AgEnD watches its own event loop. Whenever the loop stalls for **1 second or more**, it logs a warning that names the synchronous work that ran during the stall and how long each piece took. Those warnings are where every number in section 5 comes from: we counted them in the fleet log, read-only, and read the durations and the named work from them.

That tells us *where* the time goes on a real fleet, but a live fleet is noisy: load depends on how many dashboard tabs are open and how often agents restart. So each fix was also measured on a **rig**: a scratch fleet of 40 instances (80 for some checks) with real tmux on a private socket, where one thing changes at a time. Rig numbers say how much a fix removes; live numbers say what people actually feel. Below, rig numbers are always labelled as such.

## 3. The hotspots and their fixes

Almost every stall warning named the same three things (#1956).

**The dashboard's status, rebuilt for every open tab.** Every open dashboard tab gets the fleet's status every 10 seconds, and the fleet built it from scratch for each tab, every time. Building it read each instance's files from disk synchronously, some of them up to three times.
- #2225: one build per tick, shared by every open tab. Each viewer still gets only what it may see; a guest's view is cut down from the same build, never taken from someone else's.
- #2226: each instance's statusline file is read once per build instead of up to three times.

**Codex's model list, re-read on every build.** For every Codex instance, each status build re-read and parsed Codex's whole model cache (about 400 KB) and its config file. On the rig this was 71% of the status build's time.
- #2224: the result is kept per version of those files and read again only when a file changes.

**Starting tmux commands.** Every message delivered to an agent runs tmux commands. Node starts a child process by copying the parent synchronously, and that takes longer the more memory the parent uses: about 3 ms per 100 MB on the rig. The fleet process uses around 550 MB, and in the stall warnings of 19 October (section 5) a tmux command took 111 ms at the median and up to 747 ms; during a restart or a mass start they stacked up.
- #2230: a small helper process starts tmux commands for the fleet. The fleet only sends it a message, so starting a command no longer copies the fleet's memory. If the helper isn't there, each call falls back to the old direct way.

**The rig numbers, before → after:**

| Measurement (rig) | Before | After |
|---|---|---|
| Status build, 40 instances | 9.8 ms | 2.1 ms |
| File-system calls per build | 247 | 155 |
| One dashboard tick with 5 tabs open | 42 ms | 5.6 ms |
| A tmux command on the fleet's loop, fleet at 551 MB | 26.2 ms | 0.38 ms |

## 4. Stability: outages and OOM no longer take the fleet down

**One runaway command no longer stops the fleet.** systemd's default for a service is to stop *all* of it when the kernel kills one of its processes for running out of memory. Everything an agent runs lives inside the fleet's service, so one agent's 19 GB script took every agent down with it (#2015).
- #2018: the service is now written with `OOMPolicy=continue`. Only the killed process dies; the fleet and the other agents keep running. An installed service gets the setting with the next `agend update`.
- #2036: when the host runs short of memory, the log, `/health` and the dashboard name the largest processes and which agent they belong to, so you can see what is eating memory before the kernel steps in.

**A network outage no longer stops the fleet, and Discord comes back by itself** (#2191).
- #2195: an error from a Discord connection being replaced during the outage escaped to the fleet's last-resort error handler, which stops everything. That error is now handled where it happens. A connection that fails to start keeps retrying with a capped backoff instead of giving up after ten tries, and **Settings → Connections → Retry now** asks for an attempt at once. Fleet tools that don't need a chat platform (sending to another agent, task status and the like) keep working while it is away. If the fleet ever does stop on an unexpected error, it now writes the reason to `fleet-fatal.log` first.
- #2204: a Discord connection that was already replaced can no longer start a new socket late, which could otherwise throw the same error into that handler.

**`/login` failures no longer crash the fleet** (#2243).
- #2245: an error from the login terminal or from the public link's tunnel ended up as an uncaught error and took the fleet down. Now that login ends on its own, and the chat says why and what to try next.

## 5. Real before/after numbers

These come from a production fleet of about 45 instances, counted from the stall warnings described in section 2.

| | Before | After |
|---|---|---|
| Window | 19 Oct, all day | 20 Oct 15:30 – 21 Oct 15:30 |
| AgEnD 2.3.0 | beta.9 – .11 (no fixes) | beta.16 – .18 (fixed) |
| Stalls of 1 s or more | 16 (0.67 an hour) | **0** |
| Stall median / p90 / max | 1.47 / 2.74 / 5.75 s | — |
| Time stalled in all | 28.7 s | 0 s |
| Full fleet restarts | 5 | 2 (both updates) |

The 16 stalls before were all between 14:01 and 16:18; after, there were none in any of the 24 hours. The warnings before named the work from section 3 (median / p90 / longest per call):
- the Codex model list, in 15 of the 16;
- the status build, in 14 (566 / 1,634 / 2,250 ms);
- the dashboard stream, in 13 (651 / 1,567 / 2,279 ms);
- tmux commands, in 10 (111 / 266 / 747 ms).

Please read them with these caveats:
- **It is a live fleet, not a lab.** Stalls depend on load, especially open dashboard tabs and restarts. The before window had more restarts (5 against 2), and how many dashboard tabs were open isn't recorded.
- **The after window spans three releases** (beta.16, .17 and .18); all three include the fixes.
- **Zero means no stall reached 1 second.** Shorter stalls aren't logged, so this doesn't claim the fleet never lags.
- **The rig numbers in section 3 are the controlled measurements;** this table shows the effect people actually see.

## 6. What's still open

**A hang on WSL after `/login`** (#1880). On one WSL host, about a minute after `/login` opened the browser terminal, the fleet's process stopped responding and couldn't even be stopped normally: a thread was waiting inside the kernel. It wasn't using CPU, and nothing in AgEnD's code on that path is known to block, so there is no fix yet. The issue has a short read-only capture to run **before** restarting if it happens again; with that we can see where it waits.

**Per-command memory limits** (#2015). `OOMPolicy=continue` keeps the fleet alive when one command runs out of memory, but it doesn't stop a command from using too much in the first place. Capping each agent's commands is still a design question, and nothing is built yet.

If your fleet stalls or stops, the warnings described in section 2 are in the fleet log, and they name what was running. Attach them to an issue: that is how every fix above started.
