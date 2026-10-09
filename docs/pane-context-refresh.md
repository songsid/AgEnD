# Pane context refresh

[繁體中文](pane-context-refresh.zh-TW.md)

View and status refreshes use the instance daemon's existing tmux manager and
control read lane. Claude Code still prefers its authoritative `statusline.json`.
An explicit `/ctx` retains its existing synchronous fresh-read behavior.

## Bounds and ownership

- A polled read returns the cached value immediately. One background refresh per
  current instance/pane owner starts when the monotonic cache age reaches 8 seconds.
- The read captures 60 history lines with a 2-second total budget, including queueing.
  The existing lane caps raw output at 1 MiB and queued reads at 256.
- Connected control does not spawn a capture child. A disconnected or timed-out
  control attempt retains the lane's existing fallback and its two physical-child
  limit; a child holds its slot until exit/close.
- A result must still belong to the same daemon, tmux manager, launch owner,
  delivery epoch and fleet admission. Stop, respawn, pane replacement, cancel or
  removal makes an outstanding result unavailable. Missing owners return unknown.
- The same parsers are used for Codex, Kiro, Grok and the other pane-based backends.
  An unavailable read remains unknown and can retry after the cache interval.

The OS home used to identify the default tmux namespace is cached only after a
successful password-database lookup, for the same OS user. Changing `HOME` does
not grant default-server access; `AGEND_HOME` still controls the custom namespace.
An unreadable account lookup returns unknown, and can retry. A user-id change
invalidates the successful-home cache. Socket/session names are unchanged.

## Evidence and limits

The read-only 60.000511-second alpha.2 profile supplied for #1235 has 5,928 samples.
Its leaf `spawn` samples under `scrapePaneContextAsync` total 1,087.715 ms. This is
sampled time, not a call count. It attributes the polled capture path; it does not
attribute the parked binary-discovery, install, Kiro compatibility or statusline work.

Run `npm run build`, then `node scripts/benchmark-pane-context.mjs`. It models six
10-second ticks for 23 instances. The baseline spawns a private printf-only fake
tmux; the replacement uses the real manager/lane with an inert connected transport.
No tmux server, fleet, backend CLI or account is opened.

| Three local repetitions | Baseline | Connected control |
| --- | --- | --- |
| Capture children per modeled minute | 138 | 0 |
| Complete fixture workload | 166.7–202.3 ms | 0.82–2.14 ms |
| Longest native-invocation burst in one loop turn | 27.3–50.1 ms | 0 ms |
| Maximum heartbeat gap | 28.3–51.7 ms | 0.56–1.39 ms |

These numbers describe inert fixtures on one host. Heartbeat gaps include host
scheduling and I/O; they are not a production latency promise or a new live
before/after profile. Pane parsing, statusline reads and other unrelated work remain.
