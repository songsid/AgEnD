# M-3454 / S-204 — opt-in settings foundation

This first standalone dev slice converts design draft #4275 into the settings foundation. The approved M-3441 note and its fourteen inert design images remain historical design evidence; they do not claim this build has live metrics.

## Behavior and boundary

- Both options normalize to literal false without an environment/default override. An explicit Settings save writes both booleans to fleet.yaml, including false; repeated real writer saves retain them and unrelated configuration.
- Strict parsers reject null, arrays, unknown fields and non-booleans. The confirmation projection uses the same parser as the handler; public-link writes retain the admin-session gate and continuation checks. Memory rolls back if persistence fails.
- Settings → Notifications uses the existing card, setting rows, switch, hints, drafts and Save bar. The child option requires the parent and its own capability. Turning off asks before changing the draft; cancellation stages no disabling change.
- **Collection is unavailable in this slice.** The schema says so, the actual UI disables enabling and states it plainly, and both the request planner and handler refuse enabling. No provider, timer, worker, history file or monitoring notification is created. This is a conservative partial rollout, not a working collector claim.
- S-205 connects platform collectors and the availability gate only after S-204 actually merges. It must pin absent settings durably before provider startup, apply hot changes and drain/cancel work. S-206 supplies the dedicated history store/cleanup; S-207 page; S-208 alerts; S-209 agent sampler and final measurement. No stacked PRs.
- The cron disk watcher is untouched. The real one-hour both-options-on measurement and real-data dashboard/user acceptance remain pending for the final implementation; the old read-cost proxy is only design evidence.

## Actual product captures

| View | Original |
| --- | --- |
| Desktop EN, light | [Actual Settings](actual-settings-desk-en.png) |
| Phone zh-TW, dark | [Actual Settings](actual-settings-phone-zh.png) |

Scratch FleetManager served the actual modified app and effective configuration, with one synthetic General and no agents started. No DOM/CSS/metrics overrides. The private harness supplied only the tsx function-name helper used by browser-evaluated measurement code. Both contexts asserted unchecked/disabled master and child, no horizontal overflow, no page error. Both originals were individually inspected and are public-safe. The raw fixture starts without a monitoring section; these are its real effective false settings, not proof of a persisted key or real host telemetry. Explicit false persistence is established by the separate real YAML writer test. They are sent to the Leader before any merge; the implementation PR remains HOLD for user capture approval.

## Validation

- Base semantic test: all9 new configuration cases fail; implementation9/9 green.
- Focused controls/configuration/layering set:56/4 pass.
- Integration set including real YAML persistence, UI, loader, validator, settings authority and search:179/7 pass (overlaps earlier set).
- Transactions/confirmation/phone-query and metadata checks:120 passed with2 metadata failures; fixed only fragment frontmatter and the unnecessary concepts-doc edit. Both metadata files then77/77 pass. No unrelated source repair or allowance change.
- Two fault injections are caught: default-on changes false to true; dropping the availability fence returns200 instead of409. Source is restored and the two new files rerun green.
- Source and test TypeScript checks: zero diagnostics.
- All-section Settings browser gate, CI matrix/1024 width:124 checks pass,57s, headless serial. No tap allowance changed.
- Source fixtures never start a model, CLI agent or live tmux server. Browser fixtures/owned listeners closed and browser slot released.

Rollback this foundation by reverting its code/config/UI additions; false values remain inert for older versions. No history cleanup or cron replacement is performed here.

## Actual dev-tip integration

Plain-merged actual dev tip98cfd9b77 (#4236) after the first settings commit. The added/removed-line multiset of all18 owned implementation paths matches the pre-merge patch exactly. Incoming Classic picker changes are preserved. Three whole files gained reviewed incoming hunks (validator, Settings API, dashboard skill); the manifest is refreshed rather than claiming their old whole-file hashes. Actual Settings captures and124browser checks carry from the source stage because its UI/behavior hunks are unchanged; no browser recampaign. The two new tests and validator are checked on the merged tree.

Terminal-result check: two background-runner post-merge commands reported all72 tests passed but later returned SIGTERM143; the signal origin was not established. A foreground non-login invocation then completed72/72 with exit0. The initial124-check browser log also needed a terminal-result recheck; no product repair or timeout increase was made.

The unchanged merged tree then completed the full CI Settings matrix again:124/124 checks,44s, terminal exit0 with the non-login runner. Browser/fixture/listeners closed. This resolves the terminal-result uncertainty; the original two inspected capture blobs stay unchanged.
