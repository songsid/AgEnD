Independent review by Ridge (`agend-dev-sol3-t463420`). **Review only; no product changes.**

Reviewed alpha **6e542469bebbf47f445c3f4080e11e1f7d7fc344** (contains requested `4ff8c192`), using full Chrome **156.0.8078.4** on owned scratch listeners. Viewports: desktop **1366×900**, phone **390×844**, DPR1. All ten Settings routes were opened in light and dark zh-TW; desktop light EN and phone dark EN checked text length. Local Noto Sans CJK TC fallback was supplied through a private font configuration; the initial broken-font captures were replaced and are excluded.

The product served its real HTML/JS/CSS. Accounts, paired computers, Hub membership/pairing and owner-device responses were synthetic documented UI fixtures. Empty, failure, delayed-read and populated states were selected in the browser. All effectful writes and external requests were blocked; the pairing/enrollment dialogs received synthetic responses only. No CLI, live fleet, Windows host, real enrollment or account change was used. Native confirmations were dismissed. Fixture header version is fixture data; source SHA above identifies the reviewed build.

**Priority:** S01 is a confusing account-action confirmation (P1); S02–S08 are inconsistent or incomplete presentation/recovery (P2); S09–S17 are polish (P3).

**S01 · P1 · Accounts → Claude Code → Sign in again** — Copy / confirmation

The Claude Code action opens a native browser confirmation saying **“Sign in again? Kiro will sign out its existing account first.”** / **「要重新登入嗎？Kiro 會先登出目前的帳號。」**. The handler still carries the selected Claude backend, but its confirmation names Kiro at the account action. Observed in all four supplemental browser cases; every confirmation was dismissed. The PNG shows the trigger and its Claude context; the prompt text above is the real browser dialog event, not text painted into a screenshot.

PNG: [desk-light-en-focus-accounts-signin.png](desk-light-en-focus-accounts-signin.png), [phone-dark-zh-TW-focus-accounts-signin.png](phone-dark-zh-TW-focus-accounts-signin.png).

Location: [structured-signin.js:11](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/structured-signin.js#L11), [structured-signin.js:149](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/structured-signin.js#L149). House style / concrete direction: Use provider-specific confirmation copy and the in-app confirmation pattern used by Runtime CLI install, so the target and action stay explicit. [runtime-cli-install.js:87](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/runtime-cli-install.js#L87), [accounts-manage.js:220](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-manage.js#L220).

**S02 · P2 · Notifications → page explanation** — EN/zh translation

**`settingsLayout.lead_notifications`** is visible immediately beneath the page title in both languages. The new section asks for a lead key that neither locale defines.

PNG: [desk-light-en-notifications-1.png](desk-light-en-notifications-1.png), [phone-dark-zh-TW-notifications-1.png](phone-dark-zh-TW-notifications-1.png).

Location: [settings-layout.js:93](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-layout.js#L93). House style / concrete direction: Supply an ordinary localized lead with the same heading/scope/explanation hierarchy as Preferences. [settings-layout.js:91](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-layout.js#L91), [shared/page-head.js:6](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/page-head.js#L6).

**S03 · P2 · Notifications → Quota notices form** — Card / heading / spacing

The entire quota form sits directly on the page background. “用量提醒” / “Quota notices” is a large h2 and its introduction is larger and denser than neighboring Settings help. The section uses `.s-card`, for which no card rule exists; its default paragraph spacing also differs from the Settings forms.

PNG: [desk-light-zh-TW-notifications-1.png](desk-light-zh-TW-notifications-1.png), [phone-dark-zh-TW-notifications-1.png](phone-dark-zh-TW-notifications-1.png).

Location: [settings-quota-notice.js:83](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-quota-notice.js#L83). House style / concrete direction: Use the normal padded `.card`/h3 section and `.note` help rhythm. Web dashboard provides a working Settings card reference; preserve the rule scope and effective summary. [shared/app.css:528](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/app.css#L528), [shared/app.css:530](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/app.css#L530).

**S04 · P2 · Agent shared settings → General execution location** — Field / heading / button sizing

The new card competes with the page title: oversized h2, label and compact square native select on one line, then mismatched Save and stretched Refresh. Its labels, controls and vertical rhythm do not match the shared-default cards immediately below it.

PNG: [desk-light-zh-TW-agent-defaults-1.png](desk-light-zh-TW-agent-defaults-1.png), [phone-dark-zh-TW-agent-defaults-1.png](phone-dark-zh-TW-agent-defaults-1.png).

Location: [general-location.js:37](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/general-location.js#L37), [general-location.js:63](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/general-location.js#L63). House style / concrete direction: Reuse `.field` stacked labels and rounded 40px controls, a normal card h3, and a deliberate action row. The adjacent shared-default fields in the same PNG show the intended pattern. [shared/app.css:440](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/app.css#L440), [shared/app.css:530](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/app.css#L530).

**S05 · P2 · Runtime → Connect a computer / pairing code / Rename** — Field pattern / phone size

The address and pairing-code inputs are square browser controls; Rename has the same input treatment. Real Chrome measured the Connect inputs at **30px high, 0px radius, 1px 2px padding**, rather than the house field treatment. It is especially conspicuous beside rounded command cards and buttons.

PNG: [desk-light-zh-TW-focus-runtime-connect.png](desk-light-zh-TW-focus-runtime-connect.png), [phone-dark-zh-TW-focus-runtime-connect.png](phone-dark-zh-TW-focus-runtime-connect.png), [phone-dark-zh-TW-focus-runtime-rename.png](phone-dark-zh-TW-focus-runtime-rename.png).

Location: [panel-runtimes.js:402](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L402), [panel-runtimes.js:433](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L433), [shared/app.css:3086](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/app.css#L3086). House style / concrete direction: Use the common `.field` treatment, including focus state. Compare the account-name field in the Add account dialog: 40px minimum, 8px radius and 8px/12px padding. [shared/app.css:440](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/app.css#L440), [accounts-manage.js:150](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-manage.js#L150).

**S06 · P2 · Runtime → paired computer → Install a CLI** — Loading / incomplete labels

While the remote-setup GET is held, the section renders disabled “安裝” / “安裝固定版本” (“Install” / “Install pinned”) buttons with empty version slots and no loading explanation. This looks like an unfinished settled form. This state was captured with only that read delayed; no installation was requested.

PNG: [desk-light-zh-TW-focus-runtime-cli-loading.png](desk-light-zh-TW-focus-runtime-cli-loading.png), [phone-dark-en-focus-runtime-cli-loading.png](phone-dark-en-focus-runtime-cli-loading.png).

Location: [runtime-cli-install.js:47](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/runtime-cli-install.js#L47), [runtime-cli-install.js:81](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/runtime-cli-install.js#L81), [runtime-cli-install.js:100](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/runtime-cli-install.js#L100). House style / concrete direction: Show the existing form/row Skeleton until the remote capability, switch and pinned versions are known. Runtime policies already distinguishes loading from its real controls. [panel-runtimes.js:263](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L263), [shared/ui-states.js:1](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/ui-states.js#L1).

**S07 · P2 · Accounts → first read fails** — Error / recovery

A fresh Accounts read returning 503 leaves only subdued “無法讀取帳號。” / “Could not read the accounts.” inside the disclosure. The Accounts heading/content disappear and there is no Retry. It resembles helper text rather than a failed data section.

PNG: [desk-light-zh-TW-focus-accounts-error.png](desk-light-zh-TW-focus-accounts-error.png), [phone-dark-zh-TW-focus-accounts-error.png](phone-dark-zh-TW-focus-accounts-error.png).

Location: [accounts-view.js:192](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-view.js#L192). House style / concrete direction: Keep the section heading and show the shared ErrorState with Retry. The Settings configuration read and Runtime read both give an explicit error/retry affordance. [panel-settings.js:416](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-settings.js#L416), [panel-runtimes.js:430](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L430).

**S08 · P2 · Agents → AI sign-ins and API keys → Accounts** — Scope / information hierarchy

The disclosure and banner say these are credentials **on the AgEnD host**, and send Windows management to Runtime. The same disclosure now lists and manages the paired “Design workstation” accounts. That makes the location and effect of an account action unclear. The host-only wording is repeated in the Accounts introduction.

PNG: [desk-light-zh-TW-focus-accounts-host.png](desk-light-zh-TW-focus-accounts-host.png), [phone-dark-zh-TW-focus-accounts-machine.png](phone-dark-zh-TW-focus-accounts-machine.png), [desk-light-en-focus-accounts-machine.png](desk-light-en-focus-accounts-machine.png).

Location: [settings-layout.js:42](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-layout.js#L42), [panel-settings.js:418](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-settings.js#L418), [accounts-view.js:29](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-view.js#L29), [accounts-view.js:276](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-view.js#L276). House style / concrete direction: State that this section includes this host and paired computers. Give host rows an explicit host group, matching the already-labelled “On <computer>” machine groups. Keep the machine read-only reasons. [accounts-view.js:276](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-view.js#L276), [panel-runtimes.js:173](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L173).

**S09 · P3 · Runtime → Install a CLI → Other CLIs / install permission command** — Command presentation / copy

The remote-setup permission command and Other CLIs commands use bare pre/code with no Copy action. On the phone, the Antigravity line runs past the visible code area and needs horizontal scrolling. This is contained code scrolling, **not page overflow**; the inconsistency is the missing labelled/copyable command pattern.

PNG: [desk-light-zh-TW-focus-runtime-other-cli.png](desk-light-zh-TW-focus-runtime-other-cli.png), [phone-dark-zh-TW-focus-runtime-other-cli.png](phone-dark-zh-TW-focus-runtime-other-cli.png).

Location: [runtime-cli-install.js:106](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/runtime-cli-install.js#L106), [runtime-cli-install.js:112](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/runtime-cli-install.js#L112). House style / concrete direction: Reuse Runtime’s existing labelled command card with Copy and an explicit scrollable code area, already used by Connect and reinstall. [panel-runtimes.js:389](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L389), [shared/runtime-install.css:7](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/runtime-install.css#L7).

**S10 · P3 · Accounts keep-alive / Access authenticator / Hub membership** — Toggle pattern / alignment

Persistent on/off features use visibly different controls: Keep sign-in alive and Allow outside connections use tiny native checkboxes; Hub membership uses a blue switch at the left; the adjacent authorization policy uses switches aligned at the right. This makes recent sections look assembled from different forms.

PNG: [phone-dark-zh-TW-focus-accounts-keepalive.png](phone-dark-zh-TW-focus-accounts-keepalive.png), [phone-dark-zh-TW-focus-authenticator-configured.png](phone-dark-zh-TW-focus-authenticator-configured.png), [phone-dark-zh-TW-focus-hub-membership.png](phone-dark-zh-TW-focus-hub-membership.png), [phone-dark-zh-TW-access-3.png](phone-dark-zh-TW-access-3.png).

Location: [accounts-keepalive.js:102](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-keepalive.js#L102), [settings-outside.js:212](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-outside.js#L212), [settings-hub-membership.js:71](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-hub-membership.js#L71). House style / concrete direction: Use the common persistent-feature switch/label/hint row. Authority is an existing aligned example. Retain a checkbox for the optional paid fallback and for multi-item selections; those express a different choice. [shared/app.css:3804](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/app.css#L3804), [settings-shared.js:257](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-shared.js#L257).

**S11 · P3 · Runtime → computer menu → Rename** — Dialog action placement

Save is a small inline button inside the form, and the only way to cancel is the header X/Escape. It lacks the consistent Cancel / primary-action footer used by the neighboring account dialogs.

PNG: [desk-light-zh-TW-focus-runtime-rename.png](desk-light-zh-TW-focus-runtime-rename.png), [phone-dark-zh-TW-focus-runtime-rename.png](phone-dark-zh-TW-focus-runtime-rename.png).

Location: [panel-runtimes.js:186](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L186). House style / concrete direction: Put Cancel and the primary Save action in Dialog.actions, with the normal field in the body. Add/Remove account already follows this pattern. [shared/ui-dialog.js:47](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/ui-dialog.js#L47), [accounts-manage.js:147](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-manage.js#L147).

**S12 · P3 · Accounts → Sign in dialog** — Heading / setup-only copy

Inside Settings, the dialog repeats “登入 Claude Code”, “登入你的 AI 後端”, then “Claude Code”. It tells the person they can sign in later **from the dashboard** and can **continue setup**, although they are already in the dashboard. The corrected signed-in fixture has pending=[]; no claim is made about a contradictory Later button.

PNG: [desk-dark-zh-TW-focus-accounts-signin.png](desk-dark-zh-TW-focus-accounts-signin.png), [phone-dark-en-focus-accounts-signin.png](phone-dark-en-focus-accounts-signin.png).

Location: [structured-signin.js:5](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/structured-signin.js#L5), [structured-signin.js:113](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/structured-signin.js#L113), [structured-signin.js:156](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/structured-signin.js#L156), [backend-signin.js:222](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/backend-signin.js#L222). House style / concrete direction: Give the shared renderer a Settings context: retain one target-specific dialog heading and suppress onboarding-only headings/instructions. Use the concise Add/Remove dialog structure. [accounts-manage.js:147](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-manage.js#L147), [accounts-manage.js:181](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-manage.js#L181).

**S13 · P3 · Access & security → Set up authenticator app** — Dialog alignment

The QR code sits against the left content inset, leaving the right side empty. The stylesheet explicitly intends a centered QR, but align-self has no effect in this block wrapper.

PNG: [desk-light-zh-TW-focus-authenticator-setup.png](desk-light-zh-TW-focus-authenticator-setup.png), [phone-dark-zh-TW-focus-authenticator-setup.png](phone-dark-zh-TW-focus-authenticator-setup.png).

Location: [settings-outside.js:226](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-outside.js#L226), [shared/app.css:3558](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/shared/app.css#L3558). House style / concrete direction: Center the QR within its setup block, as the device sign-in QR wrapper already does; keep the setup key and instructions readable below it. [signin.html:44](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/signin.html#L44).

**S14 · P3 · Notifications → effective summary** — EN/zh mismatch

The built-in summary translates the period as 每週, but the effective summary directly beneath it displays `weekly`. The read-only summary should use the localized label even if the editable rule accepts protocol tokens.

PNG: [phone-dark-zh-TW-notifications-1.png](phone-dark-zh-TW-notifications-1.png).

Location: [settings-quota-notice.js:20](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-quota-notice.js#L20), [settings-quota-notice.js:86](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-quota-notice.js#L86). House style / concrete direction: Use the same localized period words as the built-in summary; leave command/value syntax unchanged. [settings-quota-notice.js:20](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-quota-notice.js#L20).

**S15 · P3 · Accounts → Keep sign-in alive → transient outcome** — English copy

The visible status says **“couldn't reach the service; tried again tomorrow”**, mixing a past action with a future time. zh-TW says 明天再試.

PNG: [desk-light-en-focus-accounts-keepalive.png](desk-light-en-focus-accounts-keepalive.png), [phone-dark-en-focus-accounts-keepalive.png](phone-dark-en-focus-accounts-keepalive.png).

Location: [accounts-keepalive.js:22](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-keepalive.js#L22). House style / concrete direction: Use “couldn't reach the service; will try again tomorrow”, consistent with the zh-TW status. [accounts-keepalive.js:36](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-keepalive.js#L36).

**S16 · P3 · Access & security → adjacent Hub cards** — zh-TW terminology

Hub membership calls the fleet/agents 「艦隊／代理」, while Connect to a Hub immediately switches to Fleet/Agent. The same nouns change within one task and differ from most of Settings.

PNG: [phone-dark-zh-TW-focus-hub-membership.png](phone-dark-zh-TW-focus-hub-membership.png), [phone-dark-zh-TW-focus-hub-unpaired.png](phone-dark-zh-TW-focus-hub-unpaired.png).

Location: [settings-hub-membership.js:17](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-hub-membership.js#L17), [hub-strings.js:1](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/hub-strings.js#L1). House style / concrete direction: Use the Fleet/Agent terminology already used by Connect and the Agent shared settings page, or make an explicit product-wide terminology choice. [hub-strings.js:1](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/hub-strings.js#L1), [settings-layout.js:47](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/settings-layout.js#L47).

**S17 · P3 · Runtime → machine count / CLI count** — English copy

With one paired computer containing one CLI, English displays **“1 computers”** and **“1 CLIs”**. Both counters use unconditional plurals.

PNG: [desk-light-en-focus-runtime-cli-loading.png](desk-light-en-focus-runtime-cli-loading.png).

Location: [panel-runtimes.js:107](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L107), [panel-runtimes.js:173](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L173), [panel-runtimes.js:416](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/panel-runtimes.js#L416). House style / concrete direction: Choose singular labels for one, as Accounts already does for its agent and ClassicBot room counts. [accounts-view.js:33](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-view.js#L33), [accounts-view.js:138](https://github.com/songsid/AgEnD/blob/6e542469bebbf47f445c3f4080e11e1f7d7fc344/src/ui/accounts-view.js#L138).

**Coverage and negative findings**

| Settings section | Routes/states reviewed |
|---|---|
| This device / Preferences | profile/name, identity disclosure, device preferences; all scroll segments in representative desktop/phone cases |
| Look | appearance, font, theme and expanded page content |
| Agents / Accounts | agent list; empty/populated host and paired accounts; add-invalid/remove/sign-out/switch/sign-in dialogs; keep-alive; first-read error |
| Runtime | empty/populated computers; failed/pending/manual update reports; reinstall; install permission/loading/Other CLIs; Rename and computer info; Connect Windows/ZIP |
| Agent shared settings | General location, main fields, advanced disclosure, right-side usage/info tooltips |
| Notifications | rule scopes, form, built-in/effective summaries, EN/zh text length |
| Chat connections | connection cards, ClassicBot defaults and lower content |
| Web dashboard | feature/resource/branding cards and lower content |
| Access & security | login/guests/sharing tabs; owner authenticator unset/configured/setup; devices/list/add; authority policy; Hub off/unpaired/pending/key-changed/paired |
| Advanced | editor and effective configuration tabs |

**The reported dark Agent shared settings right-edge overflow did not reproduce at 1366 or 390 px** in this build, including expanded advanced fields and the available right-side tooltips. Page and Settings pane scroll widths matched their client widths in the 60 baseline route cases. The captures do not rule out another viewport, font, custom value, browser or theme preset. Please retain that report as unconfirmed rather than closing it as fixed. See `desk-dark-zh-TW-focus-shared-main.png`, `phone-dark-zh-TW-focus-shared-advanced.png` and the `shared-tip-*` images.

No additional concrete broken layout was found in Preferences, Look, Chat connections, Web dashboard or Advanced. Add/remove/sign-out/switch account dialogs, device-add and Hub fingerprint/key-changed states fit the reviewed phone viewport. Long Runtime commands scroll within their code containers; this was not reported as page overflow. This is a visual review, not a backend/security or live-device acceptance claim.

**Evidence index**

File names give device, theme, language, section and scroll segment; `focus-` names identify an interaction state. Every finding links directly to PNGs. The branch contains a curated subset of the full captures: all section first views in all six browser cases, the complete baseline scroll views for desktop light zh-TW and phone dark zh-TW, and selected populated/dialog counterparts. No archive or CI artifact is required.

| Browser case | Viewport | Baseline section PNGs | Focus PNGs |
|---|---|---:|---:|
| desk-light-zh-TW | 1366×900 | 20 | 32 |
| desk-dark-zh-TW | 1366×900 | 10 | 12 |
| phone-light-zh-TW | 390×844 | 10 | 5 |
| phone-dark-zh-TW | 390×844 | 27 | 39 |
| desk-light-en | 1366×900 | 10 | 15 |
| phone-dark-en | 390×844 | 10 | 15 |

205 committed PNGs. Source references are pinned to the reviewed alpha SHA.
