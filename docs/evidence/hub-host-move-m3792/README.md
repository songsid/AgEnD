# Hub host-move rehearsal

Design/runbook only at base `e05fb8189698dd4bf804e3993a914e8e03a911d9`. No product source changed. [English runbook](../../design/hub-host-move-runbook.md) · [中文](../../design/hub-host-move-runbook.zh-TW.md) · [machine-readable evidence](verification.json).

Four scratch tests pass with real private key/seal, SQLite/floor, encrypted content and member relocation components. Sixty unchanged neighboring tests also pass (the recorded five-file run includes three earlier scratch cases, so those totals overlap). Final typecheck passes using existing complete dependencies. No package was installed.

The source/destination homes are private disposable fixtures. The unchanged-origin case closes the source listener and DB, cold-copies the state, and accepts the same member over actual pinned TLS/WebSocket without re-pairing. The changed-origin case tests the actual signed decision/store logic using explicit link-currentness/probe/remount fixtures: it keeps only the acknowledged Fleet, revokes the offline one, preserves pairing bytes, and performs a higher-revision return decision. The separate existing network suite covers signed relocation transport. This is not proof of a production DNS/proxy or service-manager migration.

Negative controls: missing content key and a hand-edited origin fail verification; B's certificate fails A's hostname check despite retaining SPKI. The latter requires the runbook's distinct backend-port/old-ingress gate. Identical older confirmed statements are safely re-ACKed without overwriting the newer pending return move.

No live home, Fleet start, SSH/server session, directory/provider/account access, native service change, VM build or production migration occurred. New destination capacity and assistant credentials remain preflight checks. Cross-host single-writer fencing is an operator prerequisite, not a property supplied by the copied identity.
