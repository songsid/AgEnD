# #2543: Codex cosmetic redraw during a promised recovery

Native Codex 0.164.0, private npm prefix, scratch HOME/AGEND_HOME/CODEX_HOME and
private `tmux -L cx01640-6002f7`; user/network namespace with loopback only.
The existing Responses mock returned HTTP 429 (`e429`), with request and stream
retries set to zero. Production `CodexBackend` launch/config code was used;
no account, host CLI upgrade, fleet or live tmux was involved.

`before.pane.txt` was captured after retry exhaustion. An identical second
capture five seconds later did **not** show a spontaneous idle redraw.
`after-resize.pane.txt` follows an explicit 120→100-column resize of that same
pane: the tip wraps and the footer alignment changes, while the live error,
empty composer, busy verdict and request are unchanged. The scratch path alone
was replaced with `/tmp/codex-nudge-2543`; padding is retained. This is a real
viewport redraw, not proof of which region changed in the reporter's incident.
The private unit and tmux server were stopped after capture.

The real Daemon + Lifecycle regression feeds both frames in order, keeps the
30-second 429 deadline, and checks exactly one continuation/Enter. Capacity
regressions separately change footer percentage/star decoration and change the
pane while the due nudge waits for the write lock. Genuine draft, busy status,
new output, queue, cancellation and owner changes still block continuation.

## Other promised recoveries inspected

Capacity and #2282 exhausted-429 use the same arming, polling and guarded write
path; both had the byte-equality and silent-cancellation defect. Both now use
Codex's structural periodic-redraw idle check and the current live error row,
with occurrence-count and launch/delivery fences. Exhaustion-pause admission
uses the same semantic pane check, retaining its stricter pause owner fences.

The older `backoff_restart` branch also has silent timer cancellation on
pause/stop. No current backend emits that action (only the compatibility path
and its historical tests remain); this PR does not change that inactive ladder.

A continuation cancellation event is emitted once only for a promise that was
actually dispatched, with the original notification target. It settles that
promise even during planned restart/storm suppression; it cannot create an
orphan retraction for a suppressed promise. A failed/unconfirmed final write
also reports cancellation, without a second paste. Cancellation reasons are
code-owned labels, never pane content. Delivery failure is logged if the
adapter cannot dispatch the notice.
