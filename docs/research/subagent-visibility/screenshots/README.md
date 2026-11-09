# Static web proposal — M-2739

**設計提案｜尚未實作。** Actual alpha Fleet web shell, synthetic chat, proposed DOM only. No product files, endpoints or execution controls changed. Base `47106e8d0c3769021e30881b026ff7707747e72f`; Chrome real browser; desktop1366×900/light, phone390×844/dark; zh-TW.

The collapsed row adds no separate chat message. Expanding it shows the CLI-reported name/type, task, state and bounded returned summary. Internal IDs are absent from the UI. The live view and completed durations illustrate the captured CLI mechanics; these are historical fixtures, not a live running fleet. “狀態待確認” never claims completion or continues an invented timer.

| Example | Desktop | Phone |
|---|---|---|
| Claude: one finished / one active | [expanded](claude-desk-expanded.png) · [collapsed](claude-desk-collapsed.png) | [expanded](claude-phone-expanded.png) · [collapsed](claude-phone-collapsed.png) |
| Codex: two completed | [expanded](codex-desk-expanded.png) · [collapsed](codex-desk-collapsed.png) | [expanded](codex-phone-expanded.png) · [collapsed](codex-phone-collapsed.png) |
| Missing/disconnected observation | — | [unknown](codex-phone-unknown.png) |
| Real shell before proposal | [Claude](claude-desk-before.png) · [Codex](codex-desk-before.png) | [Claude](claude-phone-before.png) · [Codex](codex-phone-before.png) |

Phone chat is scrollable within its ordinary viewport: Claude's lower explanatory footer continues below the expanded capture; message, task rows, composer and navigation do not overlap. Final independent image inspection covered both phone expanded views; earlier passes also checked desktop, collapsed and unknown samples. Both issues found initially (recipient-name mismatch and misleading completed parent prose in the unknown example) were corrected.

Shared styling: actual shell/chat/composer plus `.note` semantics and `tokens.css` spacing/type/color/radius. Proposal disclosure CSS stays in `scripts/manual/subagent-visibility/proposal.css`, loaded only through the private screenshot runner. Page-level banner distinguishes a design from shipped behavior. No fabricated live account or task controls.

To re-render into an owned output directory (supply private Playwright prefix and installed browser):

```sh
REPO="$PWD" PW_DIR="<owned-prefix-with-playwright-core>" CHROME="<owned-chrome>" \
FONTCONFIG_FILE=/etc/fonts/fonts.conf OUT="<owned-output>" \
BASE_SHA=47106e8d0c3769021e30881b026ff7707747e72f \
node --import tsx scripts/manual/subagent-visibility/proposal.mts
```

`receipt.json`: four backend/viewport cases, all no horizontal overflow. Screenshots are proposal evidence, not acceptance of a working subagent feature. No implementation should begin until the leader/user selects the presentation.
