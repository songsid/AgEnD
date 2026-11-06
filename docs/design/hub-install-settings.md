# Hub installation and host Settings

The host owner's Settings → Access & security page holds installation controls. The Hub's directory workspace retains its existing roles: [hub.md](hub.md) says the host owner has a “separate local sign-in for Hub administration/repair”; directory users get “only their current views”. A Hub directory cookie is not a host Settings credential. This page does not grant audit-content access or execution authority.

## Retention

Initialization suggests **7 days for question/answer content and 30 days for events**. Enter accepts the displayed suggestion; an explicit integer from 1 to 3650 overrides it. Both values remain in the final initialization summary and sealed plan. Existing initialized values are preserved.

On the host's Settings page, an initialized, running Hub exposes **Hub record retention**. A save uses the existing owner Settings confirmation, not a Hub directory session or public link. Its exact day counts and expected policy revision are bound to that confirmation. Stale saves are refused.

The signed initialization values seed a private `hub_retention` row during the `s5-retention` migration. Later owner-confirmed policy changes update that row and append `retention.changed` in the Hub database's same immediate transaction. Audit failure aborts the policy change. No signing key or sealed configuration is rewritten by this control. Missing/foreign policy state refuses reads, changes and startup instead of restoring initial values.

Each daily purge reads the current policy. Changes therefore apply without reconnecting members or restarting the Hub. Shortening a period can permanently delete older records at the next purge; extending it cannot restore deleted records. Existing unresolved-evidence preservation and owner/auditor boundaries remain.

The Settings card owns its EN/zh-TW strings in its lazy module so a retained pre-change Settings shell can display it. With the Hub off or unavailable, its endpoint does not open the database or construct a runtime. Older builds that do not recognize the new migration refuse the database; rollback must retain compatible schema support rather than silently reset policy.
