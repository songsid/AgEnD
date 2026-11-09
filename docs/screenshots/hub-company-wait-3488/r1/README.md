# Scoped R1 — discover handoff B after an older terminal A

**摘要：** 只修正 Prism 的一個 P2。新等待分頁看到舊的 A 時，必須繼續讀取目前操作；找到自己 handoff B 後才固定 B 的 operation id。一般輪詢及到期後「再次檢查」都沿用同一個讀取函式，沒有放寬身分、deadline 或世代檢查。

PR #3491 review head: **b8e003e2970523be08c68abd039c01a0583e1de2**. Relative to962d4f6c4: only the read-target condition/comment and three regression cases (two files,25 added/1 removed). No other finding reopened.

## Failure and correction

An initial discovery frame can contain older terminal operation A with a handoff different from the waiting tab's B. Previously the panel kept `?operationId=A`, including after B was approved; A's conflicting status prevented discovering B. The read now stays on the current-operation endpoint until a matching handoff is observed, then pins that matching operation. The existing single physical read, live/generation fence, fixed local deadline and exact bridge condition are unchanged.

Three mounted cases fail before correction and pass afterwards:

1. Cancelled A → current discovery of B joining → pinned B ready → correct bridge.
2. Ended A → the same sequence.
3. Unmatched A at local timeout → automatic reads stop → Check again discovers ready B with GET only, without a new Start.

Each checks request paths, not just a final redirect. The pre-existing null→B positive and never-matching negative remain. Final focused run: **188/188 across eight files, zero skips**; both TypeScript checks pass. Reversing only the new selection condition gives **3 semantic failures**, then the restored wait suite passes11/11: [reversal](reversal.json).

## Real browser / HTTP check

Fresh exact-head sealed Hub + production LDAP driver over synthetic TLS/BER peer + real Fleet/Chrome, desktop and phone:

- One **ordinary requesting session** starts A, confirms it through the real shared authenticator form, and cancels A through the UI.
- In that same session, B starts202/held. Two actual current-status reads return retained cancelled A **without an operation-id query**. No new Hub enrollment occurs before B's local approval.
- The fixture waits for the **next real TOTP time step**, confirms B through the same shared form, follows its bridge, signs in to the synthetic directory, and observes B saved/online.

Both legs PASS: [receipt](browser-receipt.json). Dummy authenticator pre-enrollment is a scratch setup boundary, not a UI enrollment claim. No API answers are stubbed and no real account, model/CLI, native/Windows or live/pilot operation occurs. Ended-A and timeout/manual-retry are mounted-test evidence; only cancelled-A is claimed as real browser evidence.

| State | Desktop | Phone |
|---|---|---|
| B held, older cancelled A observed | [PNG](R1-desk-old-A-held-for-B.png) | [PNG](R1-phone-old-A-held-for-B.png) |
| B continues to synthetic Hub sign-in | [PNG](R1-desk-approval-continued-to-hub.png) | [PNG](R1-phone-approval-continued-to-hub.png) |
| B saved/online | [PNG](R1-desk-online.png) | [PNG](R1-phone-online.png) |

[Manifest](manifest.json) pins the exact source and all six PNGs. The markup/words and all shared assets/smoke script are byte-identical to the prior reviewed head, so its eight-cell style/locale/cache evidence carries for those unchanged surfaces. The new read-target behavior is established by the tests and fresh browser scenario above. Read-only visual inspection found no new raw keys, overlap or horizontal overflow. The existing English server-summary sentence in zh-TW remains; phone online screenshots cover the upper connection section, not all lower controls.

## Fixture limits / cleanup / CI

Earlier exploratory fixture attempts are retained privately and excluded from PASS: a host-authorized Start can return202 before completion; a different session correctly cannot read the old operation; and a host session does not show an ordinary session's authenticator form. The final run explicitly uses the same ordinary session for A and B and waits for actual UI signals, rather than a raw HTTP200 assumption. No product change was made for these fixture corrections.

All owned resources closed. Independent cleanup checks show zero live owned PIDs, roots or listeners for the final run (44 recorded PIDs) and the earlier discarded rigs (21 and32). No private operator screenshot/link is published.

[Exact-head CI42559252154](https://github.com/songsid/AgEnD/actions/runs/42559252154) succeeded; PR checks22/22SUCCESS, none pending/failed. No timeout, authorization, shared-card, persistence or protocol change. Rollback is the scoped read-target change's revert, which restores the known discovery bug; the earlier waiting-state work is otherwise unaffected.
