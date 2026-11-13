# Hub web-address backend rehearsal

Run `scripts/manual/hub-web-address/run.sh` from an owned checkout with its locked dependencies installed and Docker available. It builds a browser image from the pinned public images, snapshots this checkout, mounts code/dependencies read-only, and runs as the invoking user's UID with no network beyond the container's loopback, no capabilities and no privilege escalation. Only its evidence directory is writable on the host. It does not touch any other container or registry.

The script uses real FleetManager health/Settings routing and D3 host authentication. The normal initializer seals an owned Hub against a synthetic, TLS-verified LDAP wire peer. A second FleetManager uses its normal pairing API, fingerprint confirmations and production member runtime, with an empty Agent inventory. Chromium sends the actual directory sign-in, preparation and commit requests; no API responses are mocked. The Hub moves to a new HTTPS port, the member reconnects with byte-identical credentials/pins, the old browser session ends, fresh sign-in works on the new address, and the old port refuses connections.

This is a backend rehearsal, not acceptance of proposed address controls. The existing Settings and Hub shells are real. It does not start the full fleet daemon, an Agent CLI, tmux, systemd or a model endpoint. There is no real directory, account, pilot, DNS/firewall/trust-store change or native platform claim. Browser certificate-error bypass is limited to the owned self-signed fixture; the initializer and directory driver still validate their fixture material.

Outputs are in `.artifacts/hub-address-3428/container-evidence`. The committed two PNGs show the existing signed-in Hub and its new-address sign-in screen. They are zh-TW desktop technical evidence, not the future EN/zh desktop/phone Settings proposal. `receipt.json` records precommit production hashes and PNG hashes; it makes no exact-commit claim. Scratch homes, credentials, browser profiles, LDAP and application listeners are removed on completion. The Docker image and inert source snapshot remain for reproduction.

The first fixture attempts failed on a container UID mismatch, an obsolete Settings-card selector and the browser form-wait harness; they are superseded by the final actual-browser API rehearsal. A smaller pinned-client rehearsal passed before the second FleetManager runtime was added. Neither is counted as the final 23-check result.

## Settings card leg (M-2901)

`SCRIPT=accept-ui.mts OUT=<dir> scripts/manual/hub-web-address/run.sh` runs the same owned container, and drives the **Settings → Hub → Hub address** card by clicks instead of calling the API. It covers:
- EN/zh-TW × desktop/phone × light/dark shots of each state, and of the page before (the same shell with the page mark stripped, which is what a server without the card draws) and after;
- Check then Back changes nothing;
- a non-host session sees no card, and the route refuses it;
- two real changes through **Confirm change**: zh-TW keeps the certificate on the same host name, EN creates one under Advanced. Each checks the saved address and listener, an unchanged member address and issuer, the member reconnecting with identical pins, the old Hub sign-in ended, a fresh sign-in at the new address, and the old address refused.

The committed PNGs and `receipt.json` are in `docs/screenshots/hub-web-address-ui/`.
