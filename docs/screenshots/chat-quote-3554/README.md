# Quote selected passages (#3554, M-2789)

Drawn by `scripts/manual/smoke/smoke-chat-quote-2789.mts` (`GATE=full`; saved at 1×) in a real headless Chrome on the shared smoke fixture: the product's own web server from an in-process FleetManager, a scratch home, loopback only. No fleet start and no network. The pill is the real one.

- `*-1-select`, `*-2-select`, `*-3-select`: a passage selected, with its pill. Desktop: anchored at the passage's end. Phone: above the composer in the gutter.
- `*-4-composer`: three passages quoted, each answered. On a phone the composer stops at its 240-px cap and shows the newest quote.
- `*-5-sent`: the message as sent, with its quotes drawn as blockquotes.
- `skew-old-panel`: an open tab's previous `panel-chat.js` with this server. The chat works, there's no pill and no error.
- `skew-old-css`: this `panel-chat.js` with the previous `app.css`. The pill still quotes.

The full run passes 66 checks across 8 cases plus SKEW: pill words and placement, insertion at the caret, focus (desktop) vs. keyboard down (phone), the repeat, what `/ui/send` carries, the blockquotes, no pill across messages or in a header, no page errors and no CSP reports. Native long-press selection on a real phone can't be shown headless (the leader's ruling A is pinned in `tests/web-chat-reply-ui-2272.test.ts`). A real phone confirms it before a beta.
