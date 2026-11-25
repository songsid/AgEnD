# S-227: same-card contact server API evidence

Source/test commit: `df3a7f6f39a5e47732342314437e0ee885f2a8a8`. Plain documentation-only integration: `2ad7ac481c8654167d8e2cf5f34a7fcefdaa3a89`.
[Contract and review dispositions](../../design/request-contact-same-card-api.md).
[Commands, path/digest rows and guard reversals](verification.json). Logs stay private.

The missing boundary was a target-manager read identity distinct from decision
authority, plus a full operation-image CAS in both actual decision writers.
The dormant shared card owner now supplies that boundary to web J and native K.
Reads resolve the admitted session account and current target management role;
writes require verification, recheck the same session after awaits, and compare
ticket/policy/image in the SQLite transaction. A late role or incarnation change
rolls delivery and decision back together. Logical expiry/policy reads stay read-only.

The wider affected run passes 2,005 tests with one existing skip in 111 files,
including every FleetManager prototype fixture. It preceded the final All filter
clarification and added controls. The restored final core passes 126/126 in five
files; tests TypeScript, build and changelog validation pass. Nine deliberate
guard reversals each make the corresponding negative control fail, then all
source bytes are restored. The JSON records commands and limitations explicitly.

Both local and named/quick-link requests exercise the real session resolver and
web handler with synthetic sessions. The deliberately unmapped host-tier session
on a chat Fleet remains denied. Native guest person grants remain aligned with E;
Hub/unknown/non-human identities are not guessed into native people.

No production host is installed, no renderer/capture is changed, and no live
fleet/account/vendor/native posting run occurred. K must validate its real
posting bot/message/nonce and callback actor; I does not claim that proof. J adds
the inline verification UI. Before L rollback is a normal revert while OFF;
after activation the parent compatibility-barrier/drain order remains mandatory.
