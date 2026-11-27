Kiro quota entitlement correction
================================

The collector previously inferred “Q Developer Pro” from an Identity Center
`start_url`, skipped its quota request, and supplied a fixed monthly-limit hint.
Authentication method does not establish the subscription. It also chose among
stored logins by latest expiry, which could select a different account.

The correction reads the native `kirocli:odic:token` and
`api.codewhisperer.profile` selection in one read-only SQLite transaction. Older
stores are usable only when the selected profile identifies one token, or when
exactly one token remains without a native selection. An expired selected token
never causes an account switch. Malformed, conflicting and ambiguous selections
produce a reason instead of a guessed account. Login-presence checks used by
credential profiles retain their existing behavior.

The returned subscription title, counters and reset determine the display, for
both Identity Center and social logins. Runtime routing follows the selected
profile ARN, not its OIDC authentication region. Only the verified us-east-1 and
eu-central-1 endpoints are allowed; other regions are explicitly unmeasurable.
There is no refresh, login, chat, CLI fallback, additional retry or background
probe. The existing usage request timeout is unchanged.

Included-plan spend excludes separately reported overage. Overage capacity and
charges are separate. Active trial and bonus balances carry expiry timestamps;
expiry is never represented as a billing reset. A response containing bonus
balances does not establish an included-plan gauge: its hint says that split is
not measurable. Negative, nonnumeric, zero-limit and relationally impossible
plan readings are not turned into a quota percentage. A missing or implausible
reset stays unknown. Neither enabled overage nor HTTP 401/403 means unlimited.

Validation is offline: synthetic SQLite stores and intercepted HTTP responses.
The matrix includes five response plan titles with each authentication flow,
selected versus legacy tokens, authentication versus runtime region, ambiguous
and malformed identities, expiry, denied access, zero/missing quota, invalid
counters, overage, trial, bonus, reset units and read-only database preservation.
Existing profile isolation, visibility, localization and expiry consumers are
also checked. The baseline matrix fails 19 assertions with five positive
controls. See verification.json for the tested source bindings and final totals.

Limits: no successful live quota response or new vendor query is claimed. The
prior research's single read-only host request returned HTTP 403; its cause and
that account's entitlement were not established. The positive cases here are
synthetic protocol controls. Real API schema changes and unrecognized runtime
regions stay unknown. No UI capture, native client, login mutation or Fleet
restart is part of this change. Main requires a separate integration twin.

Method references and licensing
-------------------------------

This is an independent implementation in the existing collector; no external
product code is copied. Public behavior and schema were compared with:

- [CodexBar](https://github.com/steipete/CodexBar/tree/a26ca57b518667a659d69524c473af2735069612/Sources/CodexBarCore/Providers/Kiro), MIT, copyright Peter Steinberger, 2026: native SQLite identity/profile binding, runtime routing and quota-field interpretation. Its chat-based fallback is deliberately not adopted because it can create sessions.
- [OmniRoute](https://github.com/cheaper-inference/OmniRoute/tree/20eefcd81b7c46d9b68b444099f728a06e48386d), MIT: recorded Identity Center paid-plan response. Its overage-to-unlimited interpretation is not adopted.
- [Kiro billing documentation](https://kiro.dev/docs/billing/) and [organizational onboarding](https://kiro.dev/startups/onboarding/): identity and subscription are distinct; no published tier allowance is hard-coded here.

Rollback: revert this change's provider, identity-reader and locale additions;
there is no data migration or credential mutation to undo. That restores the
previous limitation for Identity Center accounts. Do not alter the CLI store.

Release status: HOLD for the 2.4.0 cut. Source review is allowed; release of this
HOLD remains with the Leader. The PR author does not merge it.
