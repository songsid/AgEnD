# Memory alerts only at critical (M-3534)

Settings → Notifications → Host monitoring → Resource → Memory now offers **Alert only at critical** / **只在嚴重時警示**, using the existing `.s-setting-row`, associated label and `.s-ui-toggle` control. The option is off by default. It is the optional boolean `criticalOnly` on the memory rule in the private alert-settings sidecar; it is rejected on other rule kinds and when not boolean. Pressure thresholds remain Normal=0 / Elevated=1 / Critical=2.

On suppresses the warning streak only. Critical still opens urgent after its existing one-minute hold. An urgent incident stays urgent through Elevated pressure and needs the existing two-minute Normal recovery; missing data still resets recovery. Other resources and the unchecked/absent default retain their behavior.

A settings change already reloads incident state through the serialized coordinator. Before publishing Ready or sending queued alerts, that load now durably retires any suppressed memory warning, removes its outbox entries and retains a bounded closed-history record with an incremented revision. It sends no false pressure-recovery message. This also works on restart without needing a new metric sample. Urgent incidents are preserved, old delivery callbacks stay epoch-fenced, and a failed retirement write fails visibly without sending the old warning. Monitoring Off still performs no incident I/O. History remains capped at 500 records and dangling outbox entries are pruned.

The confirmation summary discloses critical-only on/off. The existing session-confirmed save path and authority fences are unchanged. The affected web-dashboard skill documents the option. No collector, pressure interpretation or platform default changes are included; the platform separation is a following card.

## Checks and controlled failures

The eight new baseline cases produced seven assertion failures and one pass. Initial policy/settings/coordinator suites then passed 44 cases in four files. UI/API/confirmation suites passed 24 cases in three files. A final retention-cap regression makes the new suite nine passing cases, giving **69 distinct final cases across seven files** (the final nine replace the earlier eight). Final test types and build pass.

Three controlled source mutations each produce real assertion failures: removing warning suppression, corrupting the urgent predicate, and disabling durable retirement. The exact patches and input hashes are included; the urgent mutation changes ternary precedence, so it is not described as a single isolated branch. After restoring the production hashes, all nine new cases pass. No live metrics, native CLI, account or model campaign is part of these checks.

## Real-app captures and save/read-back

Four retained originals show desktop light and phone dark in EN and zh-TW, with the saved switch on. The actual Settings app runs on a scratch fixture with a synthetic roster and monitoring off; only capability availability is exposed to render the card. Each case starts off, changes the control, clicks Save, observes 202, confirms through the real store, verifies the actual 0600 sidecar and authenticated GET, then reloads and verifies checked state. No save/read endpoint is mocked and fleet.yaml stays unchanged. Phone associated-label targets measure 266×44 px; no page overflow or page errors occurred during the exercised interactions. All browser/listeners/scratch resources closed. The Notifications Settings gate passes 14 checks with no allowance changes.

The first capture attempt stopped before an image because the rig referenced an obsolete `errors` field. A page-error listener corrected the rig; the four retained originals and `capture-checks.json` all come from the completed run. The images show presentation and saved state, not a live critical-pressure incident. Runtime behavior is covered by the injected-clock and persistence tests. All four images were visually inspected: the labels/hints fit, the complete memory control is visible, and no real paths, hosts, personal names or opaque identifiers are shown.

- [Desktop EN](desk-light-en.png)
- [Desktop zh-TW](desk-light-zh-TW.png)
- [Phone EN](phone-dark-en.png)
- [Phone zh-TW](phone-dark-zh-TW.png)

## Hold and rollback

Dev-only. **USER LOOK HOLD**: no readiness, formal gate or merge until the user approves the captures and the head-specific release is verified. Prism reviews; the coordinator alone merges after exact-head approval and green CI. Completion also requires green post-merge checks.

An older strict reader does not recognize this new sidecar rule property. Before reverting to an older build, reset this rule using the new Settings UI or restore a compatible saved sidecar; older builds refuse incompatible alert preferences rather than changing thresholds silently. Reverting the code restores the former alert behavior; fleet.yaml has no new field.
