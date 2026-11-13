# M-3091: trust a self-signed pilot Hub

Root cause: company discovery asked OS roots to validate the browser listener before it could read the Hub identity. A self-signed pilot Hub failed there, including when its member key was already known.

The Fleet now offers the PM's one-button trust prompt for a valid, correctly named, self-signed leaf only. It saves that leaf's SHA-256 certificate fingerprint per canonical web origin. Discovery tries normal trust first; a trusted certificate needs no prompt. Only after that fails can an enabled Fleet use an explicitly chosen or saved exact leaf. A changed untrusted certificate refuses ordinary connection; “Trust again and continue” replaces the exact previous pin after a new explicit press. Member/issuer identity and command transport keep their existing checks. The `hub_member.pilot_trust` boolean defaults on only in installed alpha versions; stable and unknown versions default off. Turning it off stops use of the saved browser pins.

Source: `9149c5ff7be174246bf522d902f5e4c6f1e4689b`, plain merge of alpha `51b9f694` included. `SHA256SUMS` binds the ten relevant production files. All source and test changes are committed. No roles activation is included.

## Checks

- Fail first at base `e933d36a9`: correct explicitly selected certificate failed against an owned self-signed IP HTTPS listener; wrong-fingerprint and ordinary-trust controls passed (1 semantic red / 2 controls). `fail-first.json` retains the result.
- Ten focused files: **172/172** after the alpha sync, including the existing company local/client/UI, connection card, membership API and skill suites.
- The integration case was then strengthened to use an IP-addressed sealed Hub and the real member link: **1/1** passes through code push, synthetic company sign-in, redeem, ACK, saved profile and a live pinned WSS welcome. It uses owned scratch files, SQLite and synthetic LDAPS; no real directory/account/Fleet input.
- Native TypeScript source and test checks pass. Commands use `GOMAXPROCS=2`, Vitest `--maxWorkers=2`, and `nice -n10`, starting below load 10.
- `scripts/manual/hub-pilot-trust/accept.mjs`: one serial Chromium, 16 English/zh-TW phone/desktop frames for first trust, changed certificate, disabled setting and the saved-pin hint. No horizontal overflow or page errors. The full fingerprint is shown in first-trust frames. Four representative originals were visually inspected.

The browser uses the production Fleet connection card, Preact, modules and CSS on a small loopback shell with API DTO fixtures. Its receipt names source `0e12b91e1`; every served UI/CSS blob is byte-identical at `9149c5ff7`. This is UI evidence, separate from the real protocol integration test; no packaged runtime or live browser company sign-in claim. Browser, server, scratch keys and test listeners close in their own finally/cleanup paths.

Reproduce the focused checks:

```sh
nice -n10 node_modules/.bin/vitest run tests/hub-company-pilot-trust.test.ts tests/hub-pilot-trust-api.test.ts tests/hub-pilot-trust-join.test.ts tests/hub-pilot-trust-ui.test.ts tests/hub-company-join-local.test.ts tests/hub-company-join-client.test.ts tests/hub-company-join-ui.test.ts tests/hub-connection-card-ui.test.ts tests/hub-membership-api.test.ts tests/hub-skill.test.ts --maxWorkers=2
GOMAXPROCS=2 nice -n10 node_modules/.bin/tsc --noEmit
GOMAXPROCS=2 nice -n10 node_modules/.bin/tsc --noEmit -p tsconfig.test.json
```

For browser evidence, set `PW_DIR` to an owned playwright-core install and `CHROME` to its Chromium executable, then run `nice -n10 node scripts/manual/hub-pilot-trust/accept.mjs`.

Limits: pilot trust is an explicit first-use choice. A browser opened for company sign-in still applies that browser's own certificate policy. Expired, wrong-name and untrusted-chain certificates are not offered. Turning the Fleet setting off is the immediate rollback; reverting this feature restores OS-only discovery. Saved certificate files remain inert when disabled and are separate from pairing state.
