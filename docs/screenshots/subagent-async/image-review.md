# M-2801 saved image review

**CLEAR — no blocking visual issue found.** Reviewed all 14 supplied PNGs using the built-in image viewer. These are the supplied actual-shell/reader captures with saved mock record phases; this review started no browser, CLI, account or fleet operation and changed no product file.

| Captures | Visual result |
|---|---|
| `desk-light-zh-TW-before-unknown.png`, `phone-dark-zh-TW-before-unknown.png` | Expanded dock clearly shows `2 待確認`; child identity, task text and neutral unknown badges are readable. |
| `desk-light-zh-TW-running.png`, `phone-dark-zh-TW-running.png` | Dock shows `2 執行中`; running badges and elapsed-time text are legible. |
| `desk-light-zh-TW-completed.png`, `phone-dark-zh-TW-completed.png` | Dock shows `2 已完成`; visible completion badge, 8.5-second duration and returned summary are readable. Lower child details continue inside the dock's bounded scroll area. |
| Both sizes' `completed-retired.png` and `unknown-retired.png` | Dock is absent after retirement. The composer, available chat area and navigation remain intact. |
| Both sizes' `reopened.png` | Expired dock remains absent after reopening; no stale card visibly returns. |
| `skew-old-server.png` | Compact dock shows `2 待確認`, not a false running state. It fits above the composer without covering it. |
| `phone-light-en-running.png` | English shell, `2 running`, Running badges, elapsed time and scroll guidance are clear; supplied synthetic task content remains in its original language. |

Across the desktop light and phone dark/light images, no visible horizontal overflow, colliding text, missing glyphs or clipped controls were found. The phone composer retains both selector controls, attachment/send controls and the verification footer; the four bottom navigation items remain fully visible. Desktop input and its keyboard-help footer remain visible.

The expanded dock deliberately limits its height. At the saved initial scroll position, later child content is cut at the dock's inner boundary; the explicit scroll hint explains this, and the dock stays separate from the composer. Header-name and input-placeholder ellipses are ordinary truncation, not layout overflow. Saved images establish appearance, not scroll/click behavior or elapsed expiry timing independently of the capture recipe.

All paths above are relative to `.artifacts/subagent-async-rca/browser/`.
