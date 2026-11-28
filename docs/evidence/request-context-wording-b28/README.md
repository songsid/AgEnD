# Beta.28 wording pass: request-based approvals (real app)

These frames show Settings → Access and security → Request-based approvals, using the S-230 fixture's control stub (no Fleet start, no activation). Script: `scripts/manual/request-context-wording-b28/capture.mts`. `receipt.json` has the commit, the checks (18/18) and each PNG's sha256. The card keeps zh words whole (`word-break: keep-all`), so 「關閉」 no longer breaks mid-word.

| Frame | What it shows |
|---|---|
| `b28-*-off-unavailable` | Turning it on isn't available in this version (#4597). The switch is off and disabled, with its reason. The "can't go back to an older AgEnD" warning is no longer shown under it. An owner who already turned it on still sees the downgrade note (`tests/request-context-wording-b28.test.ts`). |
| `b28-*-blocked-work` | An attempt waits for an agent's current work. The switch is drawn off, as the real controller reports it: `enabled` is true only once the mode is active (M-3900; the #4599 frames drew it on). EN now reads "Request-based approvals aren't on yet.", matching zh 「依請求核准聯絡尚未開啟。」. zh asks the admin to wait for the work, not to end it: 「請先等這些 Agent 完成目前的工作：Demo worker。…」. |
| `b28-phone-dark-zh-TW-off-unavailable-access-banner` | The Access and security banner on a phone (M-3900). 「放寬存取需要 Fleet 管理員確認；收緊的變更立即生效。」 keeps zh words whole, so 「立即」 stays on one line (it broke as 「立 / 即」 before). The devices note under it keeps 「未驗證」 whole too (it broke as 「未驗 / 證」). The script checks each word's characters share a line; with either `keep-all` removed its check fails (tops 412 vs 435; 831, 831, 855). |

Not drawn here: the server's blocked result line 「尚未開啟：還在等候「設定 → 存取與安全」裡列出的項目。」 now uses one quote pair for the Settings path; the test checks it.

Variants: desk light en and phone dark zh-TW.
