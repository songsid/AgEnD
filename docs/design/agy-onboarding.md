# Antigravity first-run consent

AgEnD's agy startup table previously handled project trust only. A missing
`<agy home>/cache/onboarding.json` can expose the earlier colour and Terms wizard,
so a successfully connected account can still be waiting for input. Skipping the
wizard by writing completion flags does not establish the sharing choice.

The user authorised retaining the default colour and accepting the Terms with
Interactions-data sharing **off** (decision 0a47ab4b). The backend shares one
screen table between startup and runtime. Each entry sends one key, is claimed
once per physical launch, blocks deliveries and is freshly revalidated by the
existing daemon pane-write lock. In particular, Done requires both an unchecked
box and the exact Done cursor on the current Terms screen. A dropped toggle, a
missing/duplicate cursor, changed consent/link, unreadable/replaced pane or
unrecognised layout does not receive a confirming Enter. Existing parked-dialog
handling exposes held screens in Needs you; project trust retains its own handler.

The fixtures distinguish the user's 1.5.6 screenshot transcriptions from actual
1.5.7 pane captures. The user authorised a fresh-home Google sign-in; the leader
entered the one-time code. The observed sequence is Enter(default terminal),
Enter(untick), Down(Previous), Right(Done), Enter, then project trust. Down on
Previous did not move focus; no Done was sent until a fresh capture showed `[ ]`
and the Done cursor. `/config` subsequently showed `Enable Telemetry off`.
No credentials were copied, no model prompt was sent, no completion flag was
seeded, and neither version is marked fully audited in the CLI ledger. The owned
private tmux and scratch home, including its new credentials, were removed.

## Launch paths

Default and named interactive accounts use the same backend dialog table; it does
not inspect account tokens or change account paths. Named-account preparation
must not seed onboarding completion to bypass the consent choice (#3771).

On the alpha line, Windows native agy uses `buildNativeInvocation()` in
`src/windows-cli-providers.ts`: stream-JSON stdin/stdout, no interactive pane.
The native pane protocol admits Claude/Codex only. This key handler therefore
cannot answer a Windows agy wizard; existing headless errors/refusals require
operator attention. No Windows onboarding completion or remote preference change
is asserted. Adding an interactive transport or a proven upstream onboarding
interface is a separate change.

## Validation and rollback

Tests use saved text fixtures and mock panes, with fake-clock startup scans. They
never run agy or contact an account. Check both detector tables, delivery holds,
write-lock repaint races and launch-owner retirement. Compile each guard mutation
and require an assertion failure, then restore exact source. Rebuild the detector
manifest whenever the parser changes. Roll back by reverting this change; no
credential/config/onboarding migration needs undoing.

A read-only inspection of the local ELF (no additional CLI execution) locates
`onboarding.OnboardingModel.updateSecurityNotice` and `footerSecurityNotice` in
its Go function table. The footer builds inactive `[Previous]` / `[Done]`, but
replaces the focused label with `Previous` / `Done` and a `  > ` marker; the actual
captures confirm this layout. Startup previously treated Right as literal
text even though runtime already sent it as a special key. Startup now sends
Right as a special key too, with an integration test asserting no literal
key send for this sequence.

## Where the choice goes

In the fresh home, local `settings.json` had no telemetry/Interactions preference
key, while `cache/onboarding.json` only changed completion flags. Static inspection
shows `saveSettingsAndOnboardingStatus` calling store `SetTelemetryEnabled`; the
server backend getter/setter call `CodeAssistClient.FetchUserInfo` / `SetUserInfo`.
Together with the visible `Enable Telemetry off` setting this supports an account/
server preference, rather than an onboarding-file switch. The exact remote stored
field/value was not independently captured. The handler does not fabricate a
local setting or claim that completion flags prove consent.
