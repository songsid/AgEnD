# General Windows backend acceptance (#3007)

This is an opt-in signed-in Windows proof. Obtain the exclusive Windows CLI window before running. It creates only a fresh folder under `C:\Users\changhansung\agend-adapter-proto\general-*`, a scratch AGEND_HOME and a loopback authenticated coordinator. It runs no systemd unit or live fleet. It keeps the person's native CLI home, uses minimal turns, and archives its own written Codex session through `codex archive` after the processes stop. It never edits provider/account configuration or copies credentials.

From a committed source head, build with `npm run build && npm run build:runtime`, then run:

```
node scripts/manual/general-windows/acceptance.mjs
```

The first backend PR proves fixed role/skill publication over the actual paired runtime channel, exact General admission, ordinary tool profile/reply guard/progress, both native providers while idle, busy and resumed, and same-launch reattachment without startup input. Server confirmation lifetime/admin/nonce/route races are independently tested with inert chat adapters. The second PR supplies the public binding/offline UI, durable switch/switch-back and its full browser/reboot acceptance. This backend harness does not claim those later user flows or a physical reboot.

Raw screens and messages stay in memory. The receipt contains only fixed canaries, code hashes, session UUIDs and booleans. Failed cleanup retains only the owned scratch state for inspection; it never erases an uncertain process outcome to make the test pass.
