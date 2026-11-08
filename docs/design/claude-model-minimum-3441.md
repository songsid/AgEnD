# Claude's model-version refusal (#3441)

AgEnD's update/postinstall installs and verifies AgEnD, synchronously before service activation. It does not upgrade an existing Claude Code installation. The same is true at the two reported release tags. The field report supports an independent npm replacement overlapping pane launch; the updater remains unidentified.

Only Claude's own `Claude Code A does not support this model; version B or newer is required` error requests repair. There is no model-specific minimum table or global B. Ordinary startup does no new version or executable inspection, and there is no deleted/npm-temporary executable guard.

The daemon resolves the currently installed launcher and reads its version with the existing static filesystem reader. It never invokes Claude for `--version` or another probe. Below-B or unknown versions produce one plain update notice with `/login` and no restart. A later disk update can make a later refusal eligible.

A sufficient disk version permits one restart for the daemon's lifetime. Before claiming it, the exact pane/window, launch attempt, generation, pause/stop fences and an authoritative idle capture must still hold. The pane-write lock closes the delivery race; the spawn latch holds queued delivery through checkpointing and ordinary startup readiness. The exact saved Claude UUID is passed with `--resume`; an unknown UUID or explicit fresh-start admission cannot select another conversation. Disk evidence and ownership are checked again after checkpointing, and tmux rechecks admission after its asynchronous sizing step before respawn.

Concurrent detections share one operation. Once claimed, the budget never renews on natural respawns; repeated error rows cannot create a restart loop or repeated success notices. An actual failed repair blocks delivery/supervision and posts one failure notice. Stop/pause/replacement during awaits retires the stale operation. No user turn is automatically replayed or resubmitted, and readiness does not prove that a model accepted a new request.

Scope/limits: this uses the existing Claude tmux daemon and installed-version reader. It adds no process scan, proc filesystem worker, executable-image verifier, installer lock, CLI installation, account/vendor probe, or native-Windows acceptance claim. An external installer can still modify the package after the final read. Existing error occurrence detection remains the admission source. An explicit operator restart creates a new daemon/budget.

Rollback: revert the change to restore the prior handling of this CLI error. No schema, configuration or durable repair journal is added; session markers remain backward compatible.
