# First Hub setup browser acceptance

Run from the candidate checkout with Node 22+, its development dependencies and an installed Playwright Chromium:

```sh
REPO="$PWD" PW_DIR="<directory with playwright-core>" CHROME="<Chromium binary>" \
  FONTCONFIG_FILE=/etc/fonts/fonts.conf OUT="$PWD/.artifacts/hub-web-setup" MATRIX=full \
  npx tsx scripts/manual/hub-web-setup/accept.mts
```

The script owns private scratch homes, an inert FleetManager HTTP listener, a real local host/D3 cookie, fake people and a TLS-verified fake LDAPS peer. It drives the actual Settings → Hub form and setup routes; it does not stub API replies. Each of eight cases creates sealed state, keeps group policy never-enabled and mints no Hub session. It explicitly mounts only the owned Hub runtime after setup for a normally verified HTTPS read. The inert FleetManager never starts its lifecycle, any CLI, a service manager or a member Fleet. No real directory/account, vendor, pilot or trust-store operations occur.

Each form step checks page/column overflow and phone tap size. Captures include the top and, when needed, a separate `-actions.png` for lower controls in the real panel scroller. `receipt.json` records checks and cleanup. Errors close the browser, Hub/HTTP/LDAPS listeners and scratch files before exit. No host values or secrets belong in receipts. All displayed directory names are fictional.

`MATRIX=quick` selects desktop/light/EN and phone/dark/zh-TW. For before-images, set `BEFORE=1 REPO=<own checkout of approved API head 6cc87d267>`; it captures the actual pre-form Settings page and performs no setup action. Old-module/old-shell SKEW modes are described in the acceptance receipt; only static UI bytes are substituted, never API replies.

The shared Settings gate also runs separately with `SECTIONS=hub GATE=full`; its normal session is not the D3 host session, so the new form's every-step geometry checks above complement that gate. Directory reconfiguration and its session-epoch/compensation/notice integration are outside this initial-form script.
