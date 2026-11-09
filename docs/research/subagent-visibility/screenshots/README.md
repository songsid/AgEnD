# Static web proposal — M-2739

**設計提案｜尚未實作。** Actual alpha Fleet web shell, synthetic chat, proposed DOM only. No product files, endpoints or execution controls changed. Base `47106e8d0c3769021e30881b026ff7707747e72f`; Chrome real browser; desktop1366×900/light, phone390×844/dark; zh-TW.

The synthetic fixture focuses on the agent reply so the complete child card and footer fit above the phone composer without a floating “最新” overlay. The collapsed row adds no separate chat message. Expanding it shows the CLI-reported name/type, task, state and bounded returned summary. Internal IDs are absent from the UI. Friendly Claude display labels (資料核對助手／結果複查助手) are proposal presentation labels; their actual `reader`／`checker` types remain secondary. The live view and completed durations illustrate the captured CLI mechanics; these are historical fixtures, not a live running fleet. The unknown summary reads `子 Agent · 2 待確認`; rows use only `待確認`, with one shared explanation. It never claims completion or continues an invented timer. The common footnote says `子 Agent 的回報不是主 Agent 的最終答覆。`

| Example | Desktop | Phone |
|---|---|---|
| Claude: one finished / one active | [expanded](claude-desk-expanded.png) · [collapsed](claude-desk-collapsed.png) | [expanded](claude-phone-expanded.png) · [collapsed](claude-phone-collapsed.png) |
| Codex: two completed | [expanded](codex-desk-expanded.png) · [collapsed](codex-desk-collapsed.png) | [expanded](codex-phone-expanded.png) · [collapsed](codex-phone-collapsed.png) |
| Missing/disconnected observation | — | [unknown](codex-phone-unknown.png) |
| Real shell before proposal | [Claude](claude-desk-before.png) · [Codex](codex-desk-before.png) | [Claude](claude-phone-before.png) · [Codex](codex-phone-before.png) |

Phone uses one16px outer gutter for the page banner, child card and composer; the full display name remains visible in the header. The unrelated General execution-location recovery card is omitted **only in the static proposal**, not removed from the product. Normalized `預設（啟動時偵測）` wording is presentation-only. Chat remains scrollable in its ordinary viewport. Independent image inspection covered desktop, phone, collapsed and unknown samples; final scoped review confirmed all three expanded/unknown phone cards and footers unobstructed, with no remaining visual issue.

Shared styling: actual shell/chat/composer plus `.note` semantics and `tokens.css` spacing/type/color/radius. Proposal disclosure CSS stays in `scripts/manual/subagent-visibility/proposal.css`, loaded only through the private screenshot runner. The page-level banner is directly under the real shell’s `#main`, outside the chat panel/column, and distinguishes a design from shipped behavior. No fabricated live account or task controls.

To re-render into an owned output directory (supply private Playwright prefix and installed browser):

```sh
REPO="$PWD" PW_DIR="<owned-prefix-with-playwright-core>" CHROME="<owned-chrome>" \
FONTCONFIG_FILE=/etc/fonts/fonts.conf OUT="<owned-output>" \
BASE_SHA=47106e8d0c3769021e30881b026ff7707747e72f \
node --import tsx scripts/manual/subagent-visibility/proposal.mts
```

`receipt.json`: four backend/viewport cases, all no horizontal overflow. Screenshots are proposal evidence, not acceptance of a working subagent feature. No implementation should begin until the leader/user selects the presentation.
