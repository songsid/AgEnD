# Room context since the agent's last input (M-3122)

The first ask in an agent conversation includes the existing latest 30 visible posts. Later asks include only newer
posts, plus a visible reply anchor even when it precedes the cursor. The existing 30-row window, optional 31st anchor,
2 KiB text bounds, join/audience floors and attachments remain. Context is frozen with each queued ask; overlapping
asks may share context because neither input was confirmed when they were queued.

## Negotiation and frames

`room-context-v1` is a Hub-only welcome offer, with `welcome-caps-v1` and `room-ask-v1`. It is never another member hello
entry: the current 17-name hello and its beta.3 fallback dropping only `fleet-update-v1` stay intact. The mounted Hub
adds one welcome offer (legacy welcome remains at most 16). A composed newer member explicitly enables the feature.

- `room.context-state {exposureId,generation}` -> `room.context-state-result {exposureId,generation,ok,code?}`.
- An opted-in ask has `contextState: {generation,after,through}`. `through` is the asking post's room sequence; its text
  is already the question. `after` is the last confirmed cursor in this room/exposure/generation.
- `room.context-input {messageId,exposureId,generation}` -> `room.context-input-result` echoes those fields with `ok,code?`.

Both requests use existing requestId/current-link epoch RPCs. The Hub takes sequence bounds from its frozen delivery,
never from the member. It accepts inputs only for the current generation and exact owner/publication/membership.
Duplicates are idempotent; old generation receipts cannot advance or restore a cursor. An overlapping higher receipt
can advance only when its frozen lower bound covers the current cursor; its actual input contains that cumulative
visible window. Previously frozen deltas are never relabelled for a later generation.

## Fleet generation and actual input

The daemon persists an opaque conversation generation at process restart, an owned clear command write, and a newly
observed owned session. Ordinary Hub/network reconnect, compaction and transcript rebaselining do not rotate it. A
reattached native pane preserves its generation. Unknown/unwritable generation holds a modern delta rather than
pretending the agent remembers it. The configured agent owns the generation, not a model argument.

IPC acceptance is insufficient. The daemon reports a successful ordinary pane submission, or the existing queued
handoff watcher proves that a turn took it. A busy CLI queue, lost/uncertain input or failure does not advance context.
The encrypted member row retains the generation and input receipt; it retries that receipt until the Hub ACKs it.
The existing input/held/answer state machine and no-repaste rules remain.

Old peers retain the complete existing full-window behavior. A legacy full-window ask in transit at feature startup
may be acknowledged in the newly confirmed generation; only a full legacy window can take this path, never a delta.
The model-facing prompt contains the same quoted room messages/question, without protocol cursor details.

## Scope and verification

Ridge granted room-only protocol/types/client/server/compose/migration ownership for this card. Keep version/update,
relocation and room-post-return blocks; M-3161's answered_at/dashboard/coalesced-stop additions are separate.
Focused fail-first controls cover repeat/reset, visible anchors/floors/2 KiB, duplicate/stale/overlapping receipts,
frozen replay, queued-vs-input handoff and old strict-schema/hello fallback. One bounded integration and ordinary Fable
review; no separate protocol/security gate. Rollback stops the optional offer and keeps existing journals/cursor data.
