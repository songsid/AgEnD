# Directory Save refusal evidence

Run from this checkout, with no concurrent tests or source writers:

```sh
npx vitest run tests/hub-directory-save.test.ts tests/hub-compose.test.ts tests/hub-directory-response-owner.test.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
python3 scripts/manual/hub-directory-save-refusal/verify.py
```

The reversal runner restores the original source in `finally`. Optional positional names run only those reversals. Reports stay under `.artifacts/hub-directory-save-refusal/`; a nonzero test exit counts only when the Vitest JSON reports assertion failures.

The SQL/HTTPS controls use a private scratch initialized Hub, owned loopback TLS listeners and inert directory methods. A refused writer commit returns 409 with `committed:false`, no cookie, the unchanged SQL stamp and the still-valid old browser session. A failure immediately after the actual SQL decision sends no refusal packet, retains the journal and has epoch 1. A throwing audit after floor advancement rolls SQL back to epoch 0/no operation, but the durable floor remains uncertain; that case also closes without claiming `committed:false` or issuing a cookie. No public AD route, real directory/account, pilot, native process or live fleet is driven.

The reversals pin response delivery, foreign-participant refusal, error sanitization, final response proof, packet-build proof and the composite stamp comparison. The two individual stamp comparisons overlap; no independent-necessity claim is made for either alone. During development, a reversal exposed an assertion inside the deliberately swallowed reply-failure catch; the test now records that observation and asserts it outside the catch. The final response and packet-build reversals each fail an assertion.

The AD form and public Save/D3 composition remain unfinished under M-2687/S-112. There are no UI changes or screenshots for this slice, and it adds no schema or security-floor migration. Reverting this code change restores the old socket-discard behavior; it never authorizes database/floor/epoch rollback.
