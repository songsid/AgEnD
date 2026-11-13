# Compact receipt/ack acceptance (M-3033 / S-131 / #3788)

The tool boundary compacts only after the existing authenticated facade applies visibility and current authority revocation. The store, native proof production, forwarding grants, owner checks and merge-gate validator are unchanged. Original verification now explicitly requests detail in generated instructions, CLI templates, affected skills, verification docs and gate retrieval guidance.

Two actual read-only tool results from this implementation session were retained in private ignored scratch: a delivered task-scope message lookup and the acknowledgement of the legitimate usage-slice registration to the coordinator. The candidate replays those same objects, without another send or receipt read:

| Result | Existing UTF-8 bytes | Compact UTF-8 bytes | Reduction |
| --- | ---: | ---: | ---: |
| delivery_status | 3,340 | 762 | 77.2% |
| send acknowledgement (caller-given correlation) | 297 | 117 | 60.6% |

Both detail results roundtrip exactly. Raw message bodies, excerpts, actor data and lookup IDs are not published. Repeat with your own saved responses:

```
node --import tsx scripts/manual/compact-tool-receipts/measure.mts /owned/status.json /owned/ack.json
```

The compact receipt preserves state, safe-to-retry, source/target/kind, hashes, original proof/authority/origin/forwarding evidence and positive delivery/consumption evidence. It drops repeated summaries/counters and shows at most200characters after best-effort display redaction of obvious OAuth codes, bearer/API tokens, password assignments, private keys and 6–8digit codes. The full original is only in `detail:true`; redaction does not guarantee arbitrary prose is secret-free.

`content_includes` is a case-sensitive check on an authorised message_id lookup, computed from the original after ACL/current-authority handling. It returns only a boolean (null if no original content is available), without echoing the query. Existence is not authorization; it cannot replace reading complete original intent/actor/proof or the merge gate's full-content hash validation.

Compact send/delegate/report/ask acknowledgements expose sent/queued, actual delivery ID, caller-given correlation and any warning. Detail preserves the legacy fields. Broadcast exposes sent count, actual per-recipient delivery_ids and partial failures; an operation ID is never relabeled as a delivery ID. Multiple recipients necessarily need more than one ID. Error or unknown acknowledgements keep operation_id even without detail, so a post-admission failure cannot erase the exact recovery selector. Positive acceptance stays compact. HTTP still privately tracks its operation ID for response-completion acknowledgement, through a WeakMap outside serialized JSON.

Fail-first: original code produced10semantic/shape failures in the new12-test slice. Eight independent reversals now fail assertions and were restored: excerpt redaction, default status projection, full detail with content_includes, content_includes beyond excerpt, retained authority, wrapper detail forwarding, broadcast delivery IDs and HTTP durable response completion. The early detail-return optimization itself is equivalent to the following full-copy branch, so it is not claimed as an independently tested guard.

Focused verification:17files294/294, maxWorkers2, no skips; includes real loopback authenticated HTTP/CLI, original ACL/forwarding/human proof/current-revocation controls, compact/detail shapes, warning preservation and full verification instructions. Existing tests that assert legacy metadata explicitly request detail; their assertions and production scope checks remain intact. No real account, CLI backend or browser was used.

Compatibility: consumers needing full content or operation metadata must request detail. Compact data is not valid merge-gate input; guidance now requests full evidence, while gate validation remains fail-closed. Rollback is a revert; no persisted data migration. Main then alpha; coordinator alone merges after parity and exact-head CI.

Additional merge-gate control: actual gate script with private git/gh fixtures accepts the full approval and refuses an otherwise valid compact excerpt/content_includes input;2selected cases pass (the rest of the gate file is unselected). Gate validation code is unchanged. Native source/test types and160fragment validation pass.
