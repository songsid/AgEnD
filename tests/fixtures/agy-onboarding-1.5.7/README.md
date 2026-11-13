# Authorised agy onboarding capture (2026-11-13)

The live post-trust banner identified **Antigravity CLI 1.5.7**. These are actual
plain tmux screen captures from a fresh owned HOME/private socket, after the user
completed Google OAuth. No credentials were copied; no model prompt was sent.
Only the owned project path is replaced with `/fixture/agy-workspace` in `trust`.
The colour/Terms frames contain no account identity or sign-in material. The
private settings frame is reduced to its version, colour and telemetry rows.

Observed keys, each after a fresh capture:
1. Welcome: `> terminal`, `[Next]` → Enter.
2. Terms: `> [x]` → Enter; repaint proves `> [ ]`.
3. Unchecked checkbox → Down; repaint proves `> Previous`.
4. Down on Previous did **not** move focus (not part of the final handler).
5. Right on Previous → `[Previous] > Done`, still `[ ]`.
6. Enter on unchecked Done → project trust; existing Yes/Enter handler reaches idle.
7. `/config` (named by the CLI's own screen) showed `Color Scheme terminal` and
   `Enable Telemetry off`; neither setting was changed there.

Local `settings.json` had no telemetry/Interactions key; `cache/onboarding.json`
changed consumerOnboardingComplete/onboardingComplete false→true, enterprise
remained false. No local opt-out persistence key was established. Static binary
inspection found onboarding's `saveSettingsAndOnboardingStatus` calling the store's
`SetTelemetryEnabled`, and the server backend getter/setter using CodeAssistClient
`FetchUserInfo`/`SetUserInfo`. This supports an account/server preference, but is
not a direct capture of the remote stored record or proof of server semantics.

This is a bounded onboarding audit, not a complete 1.5.6 or 1.5.7 CLI audit. The
1.5.6 inputs in the sibling folder remain screenshot transcriptions. Neither
version is marked audited by this change.
