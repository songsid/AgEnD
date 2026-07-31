import { EventEmitter } from "node:events";

/**
 * Carries "this instance looks hung" from the daemon to the fleet manager.
 *
 * It is only an event bridge. Hang detection itself lives in the daemon's pane-state
 * machine, which emits `hang` directly when a pane stops changing for the configured
 * stuck timeout; `instance-lifecycle` subscribes to that and notifies.
 *
 * It used to also contain a silence-timer state machine — `start()`, `isHung()`,
 * `hungEmitted`, and timestamps fed by `recordActivity` / `recordInbound` /
 * `recordStatuslineUpdate`. None of it ran: `start()` was never called from
 * anywhere, so `isHung()` was unreachable, the timestamps were written and never
 * read, and the constructor's `timeoutMinutes` was ignored (the real stuck timeout
 * is read separately by the pane monitor). Its tests exercised that dead logic —
 * two had identical setup with contradictory expectations, which can only pass
 * unnoticed when neither runs against anything real.
 *
 * Kept as a named class rather than a bare EventEmitter so the daemon → lifecycle
 * wiring stays typed and greppable.
 */
export class HangDetector extends EventEmitter {}
