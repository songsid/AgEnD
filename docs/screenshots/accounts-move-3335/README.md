# Accounts Move → Save (#3335)

Source base: alpha `06f60b079`; fix: `f9ae4a731`. This is alpha-only: main lacks Accounts UI and the profile guards.

The original request was rejected before reaching the Accounts handler: the Settings diff treated `credential_profile` as an unknown sensitive string. The fix recognizes only valid account-reference leaves at the exact fleet-default/agent paths for the supported CLIs. It keeps sibling secrets/permissions and other paths under their existing checks. A CLI change also rechecks a same-named target account’s sign-in.

## Browser acceptance

The reusable runner is [smoke-accounts-move-3335.mts](../../../scripts/manual/smoke/smoke-accounts-move-3335.mts). Chromium156, real loopback FleetManager listener, verified host-owner sign-in through `/signin`, real Settings HTTP gate and Apply job/reconcile. Profiles contain synthetic credentials; logout runs an owned mock CLI. The native stop/start boundary records calls and updates fixture runtime snapshots. No live agent, model or provider account is used; this does not claim a native relaunch or conversation carry.

| Case | Coverage |
|---|---|
| Desktop1366×900 EN/light | B5 default account → personal → Save; B7 Sign out → Remove guard → Move to old-work → Save → remove unused personal |
| Phone390×844 zh-TW/dark | Same B5/B7 flow |
| Desktop EN, cached old app.css from `b47cad34a` | B5 Move/Save with the older stylesheet |

Each move persists through PATCH200, admits the existing Apply job (normal202), completes one restart row, and records one stop/start for the selected worker. There is no pending web-session confirmation or additional confirmation dialog. B7’s logout POST and unused-profile DELETE return200; the still-used account remains intact. No page/CSP errors or horizontal overflow.

The human actions are unchanged: Move agents here → select agent → Stage → Save. B7 retains its existing sign-out/removal dialogs and typed account-name safeguard. No new click is added. The runner seeds signed-in accounts as a precondition; the earlier #3322 audit separately exercised Add/account login through a mock browser terminal/device service.

Run with owned environment paths:

```sh
REPO="$PWD" PW_DIR=<playwright-core directory> CHROME=<Chromium executable> \
  FONTCONFIG_FILE=<CJK fonts.conf> TMPDIR=<short owned scratch path> \
  node --import tsx scripts/manual/smoke/smoke-accounts-move-3335.mts
```

The runner creates a private HOME and fail-closed tmux guard, binds only its checked loopback ports and closes them after each case. SKEW covers old CSS; no product JS/CSS is changed in this PR.

## PNGs

[Before: visible400 refusal](before-b5-earlier-alpha-2b4b33d22.png) is the original fresh-process evidence from alpha `2b4b33d22`, explicitly earlier than this PR’s base. #3331 changed Accounts’ styling afterwards; this is not presented as a same-base visual comparison.

- [Desktop: Move](desk-light-en-b5-01-move-stage.png) → [saved/restart complete](desk-light-en-b5-02-saved-restarted.png).
- [Phone: Move](phone-dark-zh-TW-b5-01-move-stage.png) → [saved/restart complete](phone-dark-zh-TW-b5-02-saved-restarted.png).
- [Desktop: removal names the agent](desk-light-en-b7-02-remove-in-use.png) → [moved away](desk-light-en-b7-04-saved-restarted.png) → [unused account removed](desk-light-en-b7-06-unused-removed.png).
- [Phone: removal names the agent](phone-dark-zh-TW-b7-02-remove-in-use.png) → [moved away](phone-dark-zh-TW-b7-04-saved-restarted.png) → [unused account removed](phone-dark-zh-TW-b7-06-unused-removed.png).
- [Cached CSS: successful Save](desk-light-en-skew-old-app-css-b5-02-saved-restarted.png).

## Tests and mutations

`tests/accounts-confirmation-3335.test.ts` fails on base with400, then passes through the actual gate and handler, saved YAML and real Apply plan. It pins zero confirmation proposals, signed-out refusal, null inheritance, fleet defaults, malformed references, namespace/path boundaries, secret redaction and same-name cross-CLI refusal. The old Codex-speed expectation that all profile changes are refused is updated.

Focused tests:170/170 across11 files. Both typechecks and changelog guard pass. One earlier concurrent run timed out importing FleetManager in an unchanged Settings test; isolated18/18 and the settled170/170 run passed with no timeout change.

Eight mutations were tested in a separate owned checkout; all were caught, and its unmutated control passed:

| Mutation | Result |
|---|---|
| Remove account classification | Caught |
| Accept another diff root | Caught |
| Accept nested/lookalike containers | Caught |
| Accept unsupported CLI namespace | Caught |
| Accept malformed profile name | Caught |
| Stop validating the old reference | Caught |
| Allow signed-out account | Caught |
| Skip new-CLI check for same profile name | Caught |

No migration. Revert the source patch to restore the previous refusal; saved account choices remain ordinary fleet configuration.
