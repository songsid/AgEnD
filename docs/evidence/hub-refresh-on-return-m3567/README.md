# M-3567: a grant given while the page was away is listed on return (real app)

The real Hub and its real UI, headless Chromium: a desk 1366×900 (zh-TW light) and a phone 390×844 (en dark). "Before" is
release/2.3.5-alpha d1079b02c, "after" this branch. The Hub Admin opens 新對話 / New chat; while the page is away (the
page is made hidden, as when another tab is in front), an owner lets the admin ask one more agent (Sage, then Nova on the
phone); then the page is shown again. Headless Chromium has no tab switching of its own, so the page's own
`document.hidden` and its `visibilitychange` event stand in for it.

| | Before | After |
|---|---|---|
| on return, the list | unchanged (Hub 助理, Quill, Atlas): the new agent only after a reload | the new agent listed (Hub 助理, Sage, Quill, Atlas; Hub assistant, Nova, Sage, Quill, Atlas) |

Pictures: `*-1-before.png` (the list when opened), `*-2-after-return.png` (on return).
