# Hub membership on → pairing fields with no reload

This is the leader's cid-hub-no-reload (#3319: the user got stuck on "Reload page"). Each picture is the Settings → Fleet → Hub section right after turning **Allow this fleet to connect to a Hub** on and confirming it, in the same page load.

The pictures come from `scripts/manual/smoke/smoke-hub-no-reload.mts`. It runs the shared fixture (the product's own web server, a scratch home, no fleet start) with an admin session signed in with a code on a web-only fleet, so the change is confirmed in the page with the authenticator code. The secret is seeded into the scratch home only.

| | Before (release) | After |
|---|---|---|
| Desktop, light, English | [before](desk-light-en-before.png): **Reload page**, no fields | [after](desk-light-en-after.png): **Connect to a Hub** with its fields |
| Phone, dark, 繁體中文 | [before](phone-dark-zh-TW-before.png) | [after](phone-dark-zh-TW-after.png) |

The other two ways of confirming (General's card, and the host's Apply now) end in the same "applied" that the page follows. `tests/hub-membership-ui.test.ts` covers them.
