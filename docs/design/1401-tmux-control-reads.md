# Persistent tmux read queries (#1401)

Design approval: [v1](https://github.com/songsid/AgEnD/issues/1401#issuecomment-6058548182) plus [v2 physical ownership](https://github.com/songsid/AgEnD/issues/1401#issuecomment-6058692901). Part of #1235; 2.2.0. Runtime approval is separate.

## Why

An async `execFile` still starts a child synchronously. The 5s per-instance error monitor performs a window listing and capture; output-driven state checks also capture; 30s health checks list panes. A persistent control client was already attached but only consumed output notifications.

Two live profiles supplied by dev-claude (300s/28,884 samples and 1,200s/113,067 samples) attributed about 85% of non-idle JS sampled time to native spawn, approximately 17–22% of one core. Within spawn samples, monitor listing/capture accounts for about 67%, state captures for 21–25%, health for 6–7%, and safety sweeps for 3%. These are sampled times, not call counts; no running-instance count or exact wall-clock window was recorded. Eliminating read children does not promise an 85% reduction in total fleet CPU or resolve all stalls.

## Interface and ordering

`TmuxManager` accepts an optional `TmuxReadPort`, owned by the fleet's `TmuxControlClient`, scoped to one session/socket. Active and recovered daemon managers receive it. Capture, history/joined capture, window liveness, pane status/registration and TTY metadata use fixed typed read operations. Static cold helpers and managers without the port retain subprocess reads. `send-keys`, paste, create/kill, stty and other mutation/process operations remain outside this interface.

One logical FIFO (maximum 256 requests) is shared by control and fallback. No cached snapshots or coalescing of fresh captures. Queue/admission time counts toward each monotonic enqueue deadline: capture 10s, interaction confirmation 1s, TTY metadata 2s. The control attempt uses at most 2s or half the remaining budget, leaving time for fallback; both attempt and overall deadlines are rechecked on receipt. Retry does not renew the deadline or pass newer requests.

The initial attach frame has flags 0; commands have flags 1. Each read submits its quoted command and a separate `display-message -p` containing a fresh cryptographic nonce. The read settles only after that nonce's complete guard/body/end block. The last matching read footer before the trailer separates raw stdout from real notifications. Pane lines resembling `%output`, `%begin` or `%end` remain data. A genuine `%error` is a command failure, not an automatic subprocess retry. Every argument is a single tmux token; nonce/pane contents are never logged.

The decoder handles chunked UTF-8 and bounds newline-free input. Returned stdout is limited to 1MiB, with 64KiB additional framing allowance. Overflow or invalid framing yields no partial snapshot. Capture's original flags, backslashes, blank lines and final LF are preserved; output-notification octal encoding is not applied to captured text.

## Physical ownership and lifecycle

Retirement fences the parser/ACK immediately, but the control attachment retains its physical reservation until exact-owner exit/close or a confirmed no-child spawn failure. Kill success, timeout, stop/start and `proc.killed` are not exit proof. Only one attachment can be alive, including a retired one. A replacement requires vacancy and at least 2s since retirement. Old close/error/data cannot retire a replacement or schedule duplicate reconnects.

While connecting or after a transport failure, fallback uses original argv through asynchronous execFile within the original deadline and 1MiB limit. At most two physical fallback children exist, including timed-out children awaiting exit. There is only one active logical read: the second physical slot accommodates an old timed-out child. Stop rejects requests and kills children without freeing physical reservations prematurely; late callbacks cannot revive requests.

Registration tokens prevent unregister/re-register ABA; connection ownership prevents stale pane mappings. Existing capture fences remain; health and window recovery recheck manager/boot/spawn/launch ownership before publishing, killing or rebinding. The #1403 safety-sweep slots and event contract remain intact. This adds no permanent poller, worker thread, pane action or new state classification.

## Validation and limits

Unit tests use real client/manager/Daemon handler methods with fake child processes, streams and monotonic clocks. The benchmark declares 40 fixture instances over `(30.001s,90.001s]`, includes the whole 60–89.25s staggered sweep, and injects six output-driven captures per instance. Legacy reads total `40 × (24 monitor + 2 health + 1 sweep + 6 output) = 1,320` subprocess starts; connected control reads start zero. One control attachment per connection is outside the steady-state read count. A 1ms inert native-start cost is injected; measured synchronous API submission wall times are fixture results, not production loop/CPU measurements.

Native integration tests own a unique private tmux socket under the global process guard and compare capture/history/joined bytes and command errors on tmux 3.7b. No live/default tmux, backend CLI or fleet is used. Older tmux versions rely on the documented control protocol and the bounded fallback until separately verified. Protocol sources: [Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode), [capture output](https://github.com/tmux/tmux/blob/3.4/cmd-capture-pane.c#L207-L219), [guard tuples](https://github.com/tmux/tmux/blob/3.4/cmd-queue.c#L762-L778).

One serialized lane can add queue latency; a stalled retired child can delay control recovery while fallback continues within its cap. OS work can outlive a timeout; neither kill nor a JS timer proves exit. Parsing and other synchronous work remain and need a later same-duration production profile. Rollback is a revert, without data/config migration.
