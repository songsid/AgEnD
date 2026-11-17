# ClassicBot agents shared on the Hub (M-3285)

ClassicBot room agents use the existing Fleet-agent publication, owner confirmation, allow-to-ask grants, pause/stop and default contact restriction. Local rows carry the `ClassicBot room` tag. The Hub question and final report use the existing private representative path; no room history is added to that input or its answer metadata. Sharing sends no room notice.

This is **one agent and one memory**. It can use what it learned in the room in a Hub answer, and the other way round. The EN/zh-TW Settings lead and room-specific confirmation disclose that consequence. This change does not create separate model conversations or promise that the model cannot quote prior context.

## Root cause and routing

The old inventory excluded Classic rooms. Merely lifting that exclusion was unsafe: although a Hub input has no chat address, the daemon retains the last real room address, and the manager forces channel tools back to the registered Classic room. The optional contact window neither fences channel output nor survives a successful report or its 30-minute expiry.

The manager now writes a content-free private-turn mark before handing off a Classic Hub input. Reply/reaction/edit and public progress/notices are refused while marked, including after report ACK, expiry, restart or unregister. The final reply sink rechecks after asynchronous validation. Normal person input shares the idle delivery queue, proves fresh idle and no handed-off Hub work, and only reopens output after its own current IPC handoff succeeds. A refused/disconnected handoff leaves the mark intact. A busy public room turn finishes before private Hub input can start.

Classic consent uses the actual backend, workspace and adapter/channel binding. A retarget or remove/re-add invalidates it; a Fleet/Classic name collision is refused. Fleet-only incarnation hashes and Hub wire snapshots are unchanged.

## Validation

Routing product checkpoint: `16805078e`. Plain alpha sync: `8e954ae929cc540751c188d038c802be51df0a3e`, based on `b644a30785b031f6fef3934c8a92ed1d6221e051`. [alpha-sync.json](alpha-sync.json) pins identical own patch lines across all 19 paths; no unchanged matrix was repeated for the sync.

The retained logs have checkout paths replaced with `<checkout>`. Test scopes overlap; their counts must not be added.

| Scope | Command after `node_modules/.bin/vitest run` | Result |
|---|---|---|
| First implementation control | `tests/hub-classic-share-m3285.test.ts --maxWorkers=2` | Initial 4 cases red: missing room inventory and missing private-output refusals. The first version checked missing refusal errors; the final tests assert no adapter call first. |
| Final-handoff controls | Same file | 2 red before the fix: refused person handoff reopened output; reply validation raced private input. Then 33/33 with `tests/hub-representative-fleet.test.ts`. |
| Unregister control and routing | Same file plus `tests/classic-outbound-address-1626.test.ts tests/hub-representative-fleet.test.ts --maxWorkers=2` | The new unregister case first observed a real inert adapter send; after the fix 136/136 pass across 3 files. |
| Exposure, UI language and skill | `tests/hub-classic-share-m3285.test.ts tests/hub-exposure-api-s3c.test.ts tests/hub-skill.test.ts tests/web-pending-page-language-3416.test.ts --maxWorkers=2` | 64/64 before the final three routing controls. |
| Composed lifecycle, room input and UI | `tests/hub-skill.test.ts tests/web-pending-page-language-3416.test.ts tests/hub-compose-member.test.ts tests/hub-room-compose-track-c.test.ts tests/hub-representative.test.ts tests/hub-room-ask-track-c.test.ts --maxWorkers=2` | 143/143. |
| Existing Classic address and composition | `tests/classic-outbound-address-1626.test.ts tests/hub-compose-member.test.ts tests/hub-room-compose-track-c.test.ts --maxWorkers=2` | 128/128. |

The 17 Classic tests include Discord and Telegram, contact restriction off, accepted report, restart and expired contact window, notices/progress, normal room input, peer input, corrupt privacy state, exact report metadata, incarnation changes, busy public input, name collision, final handoff, async sink and unregister. [Type-check results](validation/types.json) record both TypeScript programs.

## Rendered views

[receipt.json](receipt.json): **22/22** checks and six originals, on `462768b5d` (final PM copy correction over the synced routing source). The walk uses the real Fleet shell and local exposure/confirmation HTTP APIs with a disposable SQLite store. Pairing and representative readiness are inert. Web authority is off in this fixture to retain the existing pending-confirmation view; the normal owner's self-confirming path was not changed. All people, room names and ids are synthetic.

| View | Desktop EN / light | Phone zh-TW / dark |
|---|---|---|
| Settings lead | [PNG](images/desk-en-light-lead.png) | [PNG](images/phone-zh-TW-dark-lead.png) |
| Complete room row | [PNG](images/desk-en-light-room-row.png) | [PNG](images/phone-zh-TW-dark-room-row.png) |
| Memory disclosure in confirmation | [PNG](images/desk-en-light-confirmation.png) | [PNG](images/phone-zh-TW-dark-confirmation.png) |

All six originals were visually inspected after fixing the earlier element-capture clipping. The lead shots use the actual viewport; the row and confirmation crops show their complete controls. No live identity or secret was visible.

Reproduce with `scripts/manual/smoke/smoke-hub-classic-share-m3285.mts`, setting `REPO` to the checkout, `PW_DIR` to a local playwright-core installation, `CHROME` to the Linux headless shell, and optional `OUT`/`HP`. The script refuses Windows and mounted Windows browser paths. Its fixture owns and closes the browser, loopback listeners and scratch home. No model, Discord/Telegram service, Windows process or live Runtime was used.

## Limits and rollback

The private mark intentionally survives answer ACK and has no time-based release. It contains only local agent/correlation identity, a random token and time. Invalid storage fails closed. A private task needing approval remains private until resolved and idle; the new room input waits rather than forcing it public.

Functional rollback: withdraw Classic publications and retain the private-output guard for accepted work. Do not delete marks or run an older guard-less binary while private work is pending. A source rollback requires that work to finish and a normal current person-input handoff to release each mark first. No Hub migration or protocol change is involved.

The obsolete M-3014 design, [#3765](https://github.com/songsid/AgEnD/pull/3765), was marked superseded and closed. The sharing implementation follows the new decision instead.

## PM copy correction and scan classification

PM accepted the layout at `54bae4f3a` conditional on two exact changes, with no further review round required: the Classic lead is now its own paragraph, and the confirmation is a statement naming the ClassicBot room. Both languages were retaken at `8361945af`; all four changed lead/confirmation originals were inspected again. The runtime guard is unchanged. The exposure and pending-language tests passed (40 cases) and the adjusted story-copy test passed (19 cases); the numeric changelog validator passes 75/75.

The first secret scan flagged two entries in the old sync manifest: public-source SHA-256 values under API-file-name keys. Both were independently recomputed from the public Git diff. The current manifest separates `path` and `sha256`; `.gitleaksignore` names only the two exact historical fingerprints. No credential was involved or rotated. [Classification](validation/scan-classification.json) records the masked locations and the local scan scope; exact CI remains the full remerge scan.

## Review delta: complete two-way consent

The code reviewer found no blocking source issue at `b381c0d6e` and caught the post-await reply guard with a mutant. The remaining consent question is closed by PM's explicit final wording: the summary now also says “What it learns from Hub questions may also come up in the room.” /「它從 Hub 提問中得知的內容，也可能在房間裡提到。」 These are statements about later answers, distinct from the guarantee that no Hub question or answer is automatically posted to the room.

At `462768b5d`, the API and pending-language tests pass 40/40; the 17 Classic tests also pass with a new direct public `notifyInstanceTopic`/negative-ACK assertion. The routing runtime is byte-identical to `b381c0d6e`. The headless walk now checks the full two-way consent in both languages (22/22); both updated confirmation originals were inspected and have complete controls and no clipping. PM requested no further round after applying those exact sentences.

The final notice-test log introduced one more digest match in the old file-hash map. That value was independently recomputed from the committed sanitized log. The file-hash manifest now also uses separate `path` / `sha256` rows; only the exact historical fingerprint is ignored. No product, test or screenshot changed in this manifest repair.

## CI compatibility repair and squash control

Exact CI exposed partial test hosts that the initial focused suites had not covered: constructor-less hosts have no data directory, plain objects borrowing the outbound handler must supply the new privacy dependency, and Classic `/stop` fixtures must supply the actual channel lookup. A new ordinary-progress case was red with the missing-data-directory exception before the fix. The runtime delta is one guard: without a data directory there is no durable mark to read. Data-backed guards remain required, including unreadable-file refusal. Test doubles now provide their real method contract; production sink checks were not made optional.

The alpha sync at `8adcdd07c` preserves both sides of the append-only `.gitleaksignore` conflict. Repair source `cfb7f7243` passes **678/678 across 24 affected files**, including all seven files reported by the failed CI. [The exact file list](validation/ci-compat-files.json) covers notices, progress/bubbles, delivery/reconnect, Classic stop and tool routing. Both TypeScript programs also pass. The temporary squash checkout was removed before running this matrix; the red specimen has one skipped copy from that temporary checkout, with only the named progress case executed. No model, native or browser campaign was repeated.

A separate control builds a single-parent scratch squash on the current alpha tip, replaces `.gitleaksignore` with exactly that base's file (zero fingerprints for this PR's branch commits), and scans only `base..scratch` with pinned Gitleaks 8.24.3. The control asserts that every other tracked file matches the final PR tree, records the parent/range/version/zero-findings receipt, then removes the temporary worktree. The exact final receipt is reported to the leader and reviewer before approval; it does not rely on a commit-bound exception surviving a squash.
