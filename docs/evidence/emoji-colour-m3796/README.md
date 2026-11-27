# M-3796: emoji in colour on Windows (Edge, Win11)

The user saw 🆕 at the start of an agent's bullet lines as a grey outline in the web chat (Win11, latest Edge, dark theme).

## Root cause

A browser draws each character with the first font in the stack that has a glyph for it, and on Windows it takes that glyph even when it isn't colour. `--font-ui` lists the CJK fonts before the colour emoji fonts. **Noto Sans TC**, which this Windows install has, has its own black-and-white glyphs for 🆕 🆗 🆓 🈶 (Enclosed Alphanumeric and Ideographic Supplement), so Edge used them. In `--font-mono`, a font named **Menlo** on the machine drew ☕ ⚡ ♈ in black and white the same way. The message bytes are plain U+1F195, with no VS15 selector.

## The fix

`tokens.css` adds a face named "AgEnD Emoji": the platform's colour emoji font by `local()` (Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji), so nothing is downloaded. Its `unicode-range` is limited to emoji:
- the emoji planes, U+1F000–1FAFF;
- the BMP symbols that are emoji by default (Emoji_Presentation);
- the joiners that build sequences (U+200D, U+FE0F, U+20E3).

It is the first family of `--font-ui`, `--font-mono` and the system theme font. Text keeps its fonts: digits, `#`, `*`, ©, ™, ★, ♥, arrows and CJK are outside the range. A text-style request (U+FE0E) still gets a text glyph.

## Evidence (real app, Microsoft Edge 158 on Windows build 26100)

`scripts/manual/emoji-colour-m3796/capture-windows.mts` boots the owned web fixture in WSL, with inert agents and a synthetic agent reply. It drives **Edge on Windows** over CDP, headless with no window on the desktop. For each list item, it asks Edge itself which installed font drew it (`CSS.getPlatformFontsForNode`). The cases are dark and light, the default font, and the agents' system and mono theme fonts, all in English. A fifth case is the user's own: a **zh-TW page** (`<html lang="zh-Hant">`, Chinese chrome) with an **agent replying in Chinese** (「🆕 General 聊天室的更新卡片」). Each case checks that the page and the chat really are in its language, and that the zh-TW frame isn't the English one. Each frame is the whole chat panel.

| Run | Commit | Checks |
|---|---|---|
| `base/` | `f7027fbf9` (release/2.3.5-alpha) | **65/83**. The 18 failures are the bug: 🆕 🆗 🆓 🈶 by Noto Sans TC (default font: dark, light and the zh-TW case, whose 「🆕 General 聊天室…」 has its 🆕 in Noto Sans TC), and ☕ ⚡ ♈ by Menlo (mono theme) |
| `fix/` | `077a05b03` (`src` clean) | **83/83**. Every emoji is drawn by Segoe UI Emoji. In the zh-TW bullet the Chinese stays on Noto Sans TC and only the 🆕 moves |

- **Text unchanged.** The line `1 # * © ™ ★ ♥ → 中文 text` and the text-style `🆕︎` are drawn by exactly the same fonts and glyph counts before and after, in every case (`receipt.json` → `fonts`). The only items that changed are emoji, each moving to Segoe UI Emoji, inside inline code too.
- **The zh-TW frames.** An earlier run cropped only the message body, the same English text in every case, so its zh-TW frame matched the English one byte for byte (the leader's capture check). The page was already in Chinese then; now the frame shows it, and a check fails if the two frames match.
- **Pixels.** I cropped each single-emoji item and counted its saturated pixels (by hand, with the script's `CROPS=` option). With the default font, 🆕 goes from 70 to 195, the same as under the system theme font, which already used Segoe UI Emoji. In the mono theme, ⚡ goes from 14 to 62 and ♈ from 34 to 186, again the same as the default.
- **Screenshots.** `base/` and `fix/` hold the chat panel as Edge drew it in each case.

Not covered: the Windows rig has one font set, this machine's. Another Windows machine may have other CJK fonts. The fix doesn't depend on which font had the grey glyph, because the colour face comes first for emoji either way.
