Personal agent: progressive setup (M-3262)

The first setup rewrite still showed every instruction at once. The revised card expands only the current step: prepare the computer, install, choose the app and name, then share. Completed steps become ticked titles; later steps show only their title. Optional settings and troubleshooting stay closed. The folder/account disclosure remains visible beside Save, and the folder-sharing warning remains beside Share. Answer only remains an inline explicit choice when Codex needs it. Saved agents show their actual status and Shared / Not shared yet, with Edit. Off states have one sentence and the administrator's exact-setting link.

The revised real-app walk uses application source `2518084b93eed51c39b69d1df42f88d9c2891254`: **16 PNGs, 67 passing checks**. It retains the same seven desktop-English/light and phone-Traditional-Chinese/dark states, plus the unsaved configuration step in each language. Phone images are full **390×844** viewport captures. The viewport is never enlarged: every default card, including configuration, fits without scrolling to read it. Deliberately opened optional settings/help may need scrolling.

| Revised state | Desktop English | Phone Traditional Chinese | Phone card height |
| --- | --- | --- | --- |
| Hub off, administrator | [view](compact/desktop-en-light-disabled-admin.png) | [view](compact/phone-zh-TW-dark-disabled-admin.png) | 150 px |
| Hub off, member | [view](compact/desktop-en-light-disabled-member.png) | [view](compact/phone-zh-TW-dark-disabled-member.png) | 94 px |
| Prepare computer | [view](compact/desktop-en-light-setup.png) | [view](compact/phone-zh-TW-dark-setup.png) | 445 px |
| Install command | [view](compact/desktop-en-light-install.png) | [view](compact/phone-zh-TW-dark-install.png) | 561 px |
| Choose app, name and save | [view](compact/desktop-en-light-configure.png) | [view](compact/phone-zh-TW-dark-configure.png) | 683 px |
| Saved, not shared | [view](compact/desktop-en-light-ready.png) | [view](compact/phone-zh-TW-dark-ready.png) | 288 px |
| Working, shared | [view](compact/desktop-en-light-working.png) | [view](compact/phone-zh-TW-dark-working.png) | 228 px |
| Offline, shared | [view](compact/desktop-en-light-offline.png) | [view](compact/phone-zh-TW-dark-offline.png) | 300 px |

The revised walk also proves exact-command Copy through an inert clipboard, the actual Administration-card scroll target, a single current step, consumed-command retirement, current CLI eligibility and failure help. The 66 focused UI/shell/skill tests and test TypeScript program pass. Private rig homes, browser and loopback listeners were closed in `finally`; no private home remains. No Windows process, user account, model or live directory was used.

Reproduce the revised packet with `PHASE=compact`, an isolated output folder, local Playwright package and Linux headless Chromium. The source script refuses other platforms. All 16 revised originals were inspected, then the three affected phone views were checked again after list-label alignment. No clipping, overflow, exposed token or live identity remains. Lumen's shortened copy is implemented; revised rendered-view and user review are pending, so the PR remains on author hold. The earlier walks below are retained as historical before/expanded comparisons, not proof of the compact layout.

The personal publication row below the card previously said Shared even before any person could ask. Its list now says **My agents** when it contains a personal agent, and all personal publication tags say **Saved**. The row has no authoritative sharing boolean, so the card remains the authority for Shared / Not shared yet; no count or grant was invented. Fleet labels are unchanged. The three affected phone views (ready, working, offline) were refreshed at `8daa17d4742ed6a6fd2b6d5ac214de0e5104ed2c` with 19 checks; `compact/list-alignment.json` records their source and unchanged viewport. The other 13 originals retain the earlier source.

Historical comparison

The old card described the feature but gave no route from “not enabled” to an answering agent. The new card names the next action for each state: the administrator opens the exact Administration card; a member asks the administrator; a new owner gets four setup steps; a paired owner gets configuration, sharing, working or reconnect guidance.

The English and Traditional Chinese copy follows the product manager's reviewed strings. The requirements say “your Windows computer”; availability still depends on that computer's checks. Node.js 22.14 or newer links to nodejs.org. Codex's Answer only limitation is explained in the preparation step. The existing folder/account disclosure, private 15-minute command, explicit sharing, replacement and disconnect confirmation remain.

After the computer appears, the completed steps and consumed command leave the card. A command for a replacement remains visible until the replacement connects. The Administration shortcut uses a section query because the Hub navigation deliberately strips cross-page section hashes; the card scrolls into view after its settings form is ready.

Evidence scope

- Before: the beta.9 application at `297475387086e6403eb9724e5452d2024f29b11b`.
- After: application source at `c04069c4259bda91f009e3431724df0c75467ad1`; subsequent evidence/recording changes do not alter the application.
- Real product shell, HTTP, SQLite and encrypted audit in an isolated rig. People, computer names, account logins and folders are explicit synthetic fixture data. Directory and Runtime operations are inert. No live company directory, Windows process, installer, CLI account or model was used.
- Desktop 1366, English/light; phone 390, Traditional Chinese/dark. Each image is the rendered card; viewport height expands to capture its full scrollable contents. Only the one-time fixture token is replaced in the screenshot DOM, then restored. The command area is intentionally bounded; Copy is checked separately against the full generated command through an inert clipboard port.
- Before: 14 PNGs and 37 passing checks. After: 14 PNGs and 45 passing checks. These are separate state walks, not counts of distinct product behaviors.
- The image inspection opened all 28 originals and found no outer overflow, clipped controls, unmasked token or live host/company identity. The setup and pairing states remain readable at both widths.

Views

| State | Desktop EN before / after | Phone zh-TW before / after |
| --- | --- | --- |
| Hub off, administrator | [before](before/desktop-en-light-disabled-admin.png) · [after](after/desktop-en-light-disabled-admin.png) | [before](before/phone-zh-TW-dark-disabled-admin.png) · [after](after/phone-zh-TW-dark-disabled-admin.png) |
| Hub off, member | [before](before/desktop-en-light-disabled-member.png) · [after](after/desktop-en-light-disabled-member.png) | [before](before/phone-zh-TW-dark-disabled-member.png) · [after](after/phone-zh-TW-dark-disabled-member.png) |
| No computer yet | [before](before/desktop-en-light-setup.png) · [after](after/desktop-en-light-setup.png) | [before](before/phone-zh-TW-dark-setup.png) · [after](after/phone-zh-TW-dark-setup.png) |
| Install command issued | [before](before/desktop-en-light-install.png) · [after](after/desktop-en-light-install.png) | [before](before/phone-zh-TW-dark-install.png) · [after](after/phone-zh-TW-dark-install.png) |
| Ready, not shared | [before](before/desktop-en-light-ready.png) · [after](after/desktop-en-light-ready.png) | [before](before/phone-zh-TW-dark-ready.png) · [after](after/phone-zh-TW-dark-ready.png) |
| Working | [before](before/desktop-en-light-working.png) · [after](after/desktop-en-light-working.png) | [before](before/phone-zh-TW-dark-working.png) · [after](after/phone-zh-TW-dark-working.png) |
| Offline | [before](before/desktop-en-light-offline.png) · [after](after/desktop-en-light-offline.png) | [before](before/phone-zh-TW-dark-offline.png) · [after](after/phone-zh-TW-dark-offline.png) |

Validation

- `vitest run tests/hub-personal-ui-m3224.test.ts tests/hub-shell-parity.test.ts --maxWorkers=2`: 47/47 pass. The UI file includes the role-specific disabled action, ordered requirements, no automatic command, connected state hints and consumed-command retirement. Existing captured-session, consent/profile eligibility, expiry and disconnect cases remain green.
- `tsc --noEmit -p tsconfig.test.json`: exit 0.
- The consumed-command case failed before the UI state fix, then passed with the full focused packet. See `validation/command-before.log` and `validation/focused.log`.
- The after walk checks the actual Administration scroll call and visible target heading, the four steps, removal of finished steps/command, and Copy receiving the full command. It creates only its own loopback listeners and removes its private rig home in `finally`.
- Reproduction script: `scripts/manual/hub-personal/setup-steps.mts`, run in WSL/Linux with `PHASE=before|after`, an isolated output folder, a local Playwright package and its headless Chromium shell. It refuses other platforms; it never executes the displayed PowerShell command.

Privacy and rollback

Published logs use `%REPO%` and `%HOME%`; rendered identities and paths are synthetic. PNG metadata and the public text/diff are checked before publication with the fleet's private public-GitHub checker. Git author identity is left at the configured value, as instructed.

This change adds guidance and a targeted Administration link; it changes no server authority, migration, installer, Runtime or launch profile. Reverting the UI and skill restores the earlier presentation without touching pairing, agent publication, sharing or history.
