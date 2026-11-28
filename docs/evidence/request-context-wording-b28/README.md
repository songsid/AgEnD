# Beta.28 wording pass: request-based approvals (real app)

These frames show Settings → Access and security → Request-based approvals, using the S-230 fixture's control stub (no Fleet start, no activation). Script: `scripts/manual/request-context-wording-b28/capture.mts`. `receipt.json` has the commit, the checks (12/12) and each PNG's sha256. The card keeps zh words whole (`word-break: keep-all`), so 「關閉」 no longer breaks mid-word.

| Frame | What it shows |
|---|---|
| `b28-*-off-unavailable` | Turning it on isn't available in this version (#4597). The switch is off and disabled, with its reason. The "can't go back to an older AgEnD" warning is no longer shown under it. An owner who already turned it on still sees the downgrade note (`tests/request-context-wording-b28.test.ts`). |
| `b28-*-blocked-work` | An attempt waits for an agent's current work. EN now reads "Request-based approvals aren't on yet.", matching zh 「依請求核准聯絡尚未開啟。」. zh asks the admin to wait for the work, not to end it: 「請先等這些 Agent 完成目前的工作：Demo worker。…」. |

Not drawn here: the server's blocked result line 「尚未開啟：還在等候「設定 → 存取與安全」裡列出的項目。」 now uses one quote pair for the Settings path; the test checks it.

Variants: desk light en and phone dark zh-TW.
