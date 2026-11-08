# Hub UX review fixes (#3431, Argon's review of the Hub shell)

Before: `songsid/release/2.3.5-alpha` at `10a695e68`, which contains the Hub shell (#3432). After: this branch. Both are drawn
by the Hub shell gate (`scripts/manual/smoke/smoke-hub-shell-gate.mts`, `GATE=full`) on a real Hub web listener: HTTPS on
127.0.0.1, the s3b rig (scratch SQLite, a fake directory, an in-process member), the administrator signed in. The session's
notices mark and one notice are answered in the browser (`page.route`), because the rig composes no notice routes. No fleet
runs and there is no network access.

- `<case>-admin.png`: Administration in all eight cases (desk/phone × light/dark × en/zh-TW). Before, the security notices
  card sits above the page, "Administration" appears twice, and a phone loses 36 px per side to the double gutter. After,
  the page has one title, its scope sits in the header, the lead opens the page, the page has one gutter, and no notices card.
- `desk-light-en-chats`, `phone-dark-zh-TW-chats`: the chats home. On a phone, after the fix, the home list is the
  sidebar's own roster.
- `*-mine`, `*-notices`: My shared agents and the Notices page (the only place notices show, under its header).
- `*-session-menu`: the foot's menu. It now shows the person (name and sign-in name) and Sign out, inside the drawer.

Gate verdicts: before, 108 checks fail (tab title, notices placement, one title, one gutter, list, session menu, phone home
roster); after, 680 checks pass. The Hub UI gate (`smoke-hub-ui-gate.mts`, `GATE=full`) passes 314 checks; its tap list
only shrank.
