# Member-address backend rehearsal (#3429)

Run `scripts/manual/hub-member-address/run.sh` in an owned checkout. The pinned browser image and sandbox flags follow the adjacent web-address recipe: no privileged container, host network, inherited credentials or host lifecycle. Only the evidence directory is writable. Source/dependencies are read-only; scratch homes/listeners/browser profiles are removed afterward.

A real initialized Hub uses TLS-verified synthetic LDAPS. A second FleetManager first connects through the shipped manual pairing flow. A Chromium host session changes the member address using the real D3 Settings API and the affected Fleet preview. Old credentials are revoked, old endpoint refuses, browser address/session stays intact, and the original owner has one durable reconnect notice. Recovery uses the existing exact-binding Disconnect/Start over followed by real browser company-account sign-in and a fresh group-authorized credential. Old revoked rows are retained. No signed relocation, automatic trust reset, row supersession or new one-button UI is manufactured.

The browser resolves only the owned Hub fixture hostname to loopback; the company client gets the owned self-signed browser leaf and that same exact lookup seam. The AD group-policy contract names port 636; only that exact loopback destination is redirected to the owned ephemeral fake-LDAPS listener. These are fixture network/CA seams, not replacement protocol handlers. Hub identity, Origin/CSRF, browser bridge, group/directory checks, proof, receipt/journal and member WSS run production code. Agent inventory is empty; no CLI/model/native/real AD/pilot claim.

Existing-shell zh-TW desktop PNGs are technical evidence only. Settings UI, its vocabulary/consolidation and the final EN/zh desktop/phone/SKEW matrix remain held under #3658. This backend rehearsal does not claim that future UI or an existing-company trust-repair journey; its initial pairing is the legacy manual path.

Eight isolated guard reversals can be reproduced with `python3 scripts/manual/mutation/hub-member-address.py` in an owned checkout. It restores exact source bytes after each test and records local logs under `.artifacts`. The first fixture attempts exposed a Chrome error-page navigation race, the AD group-policy requirement for port 636, and an obsolete connected-card selector. These harness failures remain disclosed; the final source-bound container run supersedes them. No test timeout or product security rule was loosened.

## Option B leg (#3429, M-2901)

`SCRIPT=accept-b.mts OUT=<dir> scripts/manual/hub-member-address/run.sh` replaces `accept.mts`'s option-A expectations (every Fleet revoked). It covers:
- **The Settings card** (**Settings → Hub → Fleet connection address**): show, edit and confirm in EN/zh-TW × desktop/phone × light/dark, and Check then Back changing nothing.
- **Leg 1, member online** (the change confirmed through the card, in EN): it follows the issuer-signed relocation. Its credential and pairing.json are byte-identical, its relocation is confirmed, the Hub keeps the Fleet, no notice names it, and the old endpoint is refused.
- **Leg 2, member paused** (through the card, in zh-TW): it doesn't follow. The card names it, the Hub revokes it and its owner's notice names it, and the new endpoint refuses its old credential. It then re-joins with the company account (Phase A one-box) and comes back online.

The PNGs and `receipt.json` are in `docs/screenshots/hub-member-address-3429-b/`.
