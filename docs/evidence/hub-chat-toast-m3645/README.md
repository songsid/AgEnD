# M-3645: where a toast stands in a Hub chat (real app)

These are captures of the real Hub shell. The Hub's own web listener serves it over HTTPS on loopback. The rooms come from the rooms fixture (`tests/support/hub-rooms-fixture.ts`): a one-to-one chat with an agent (`room-helper`) and the weekly group room (`room-weekly`). The captures were taken headless with Chromium, with motion reduced. Script: `scripts/manual/hub-chat-toast-m3645/capture.mts`.

**The toast.** The shared toast (`/assets/ui-toast.js`) shows the wording of #4412's mute confirmation, with the chat's title as the name. Then two confirmations come in a row: that one, then the Hub's own "Pinned." The fixture's people are shown under obviously sample names (Sam/Alex/Casey/Jordan/Riley Sample in English, 範例主管/範例同事/範例組員/範例夥伴/範例訪客 in zh-TW). The fixture itself is unchanged.

**Before** serves the base branch's `app.css` through `route.fulfill`; nothing changed on disk. **After** is this branch's committed code. `receipt.json` lists the commit, every check with its measurements, where each "before" toast stood, and each PNG's sha256.

Each toast is measured against the chat's head, the composer, Send, and every message row the thread shows (clipped to the thread's scrolling box).

| What | Capture |
|---|---|
| **Before: the bug.** On a desk the toast stands in the bottom-right corner: on Send in a one-to-one chat, and on the members list's foot in a group room. On a phone it comes in at 60 px, where a Fleet page's header ends, which puts it on the thread's first row. | `*-before-1-toast.png` |
| **After: in the chat's head.** The toast stands in the head's band, on a desk and a phone alike. It never touches the composer, Send or a message row (checked). The head's buttons under it still take clicks, as before (toasts let clicks through). | `*-after-1-toast.png` |
| **Two in a row.** The newest confirmation stands in the head and the older one gives way, so the stack never runs down the thread. | `*-after-2-newest.png` |

Combinations: desk en light, desk zh-TW dark, phone en light, phone zh-TW dark; each in the one-to-one chat (`direct`) and the group room (`group`).

**Not changed:** an error toast, or a source's details (the toast with every line), keeps every line and is never hidden by a newer one. If either runs longer than the head, it reaches below it. A Fleet chat keeps its own place, under the header.
