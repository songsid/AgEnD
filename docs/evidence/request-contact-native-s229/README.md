# Native same card (S-229, slice K of M-3736)

`en.json` and `zh-TW.json` are the payloads the real posting path sends: FleetManager's nonce posting, callbacks and retirement, on slice I's `RequestContactCards` and E's gate over a real `DeliveryOutbox`. The adapter and people are synthetic, and nothing connects to Discord or Telegram. Ticket short ids and nonces are normalized.

Regenerate: `S229_EVIDENCE=1 npx vitest run tests/request-contact-native-s229.test.ts`.

| Case | Card | Buttons |
|---|---|---|
| `held-request` | A request-scoped hold: question, quote, who asked · #id · expiry, the web card's short scope line (#4497) | Continue / Decline |
| `held-legacy` | A legacy ticket on the same card | Approve once / Decline |
| `general-proposal` | General's proposal: its one suggestion, then the same card ending at the meta line (no scope line) | the suggested choice / Not now |

What a card says when it closes:

| When | EN | zh-TW |
|---|---|---|
| Continued here | Continued by {person}. | {person} 已讓這筆請求繼續。 |
| Approved here (legacy) | Approved once by {person}. The message was sent. | {person} 已核准這一次，訊息已送出。 |
| Declined here | Declined by {person}. The agent is told. | {person} 已拒絕，已通知該 Agent。 |
| Decided on the web or another card | Continued elsewhere (the dashboard or another card). / Declined elsewhere (…) | 已在別處繼續（網頁或另一張卡片）。／已在別處拒絕（…） |
| The request changed after posting | This request changed. A fresh card follows. | 這筆申請有變動，下方會附上新卡片。 |
| Not now (proposal) | Not now. The request still waits. | 先不處理，申請仍在等待。 |
| A proposal past five minutes or a changed General | This proposal expired or changed. Ask General to propose again; nothing was applied. | 這份提案已到期或內容已變更。請 General 重新提出；未套用任何變更。 |

This is native text and payload evidence, not a claim about how a platform renders it.
