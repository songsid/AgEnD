# #3322: Ridge’s assigned UX stories

Tested 2026-11-07 in Chromium 156.0.8078.4. Desktop 1366×900, phone 390×844; EN/light and zh-TW/dark. These are actual product screenshots, not mockups.

Initial alpha: `b47cad34a6fbc25bfab5ce72f31da2d7991bfcaa`. During the run, alpha advanced to `2b4b33d222465f595efce3009e5177fa8c8b4e70` (#3320/#3323/#3324). The checkout fast-forwarded; current UI now has **Settings → Hub**. Account-switch rejection was repeated on the new UI and separately checked in a fresh process. The relevant account-confirmation, Hub protocol, grant and poll implementations did not change between these tips. Earlier screenshots intentionally retain the route names at the time of the action.

## Isolation and evidence limits

- Owned scratch HOME, AGEND_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and XDG directories. All listeners on loopback. The sign-in terminal used a pinned bundled tmux binary behind a wrapper that strips every caller socket argument and forces our private socket.
- No real account, vendor API, live fleet, Windows host or Mac pilot. Fleet lifecycle methods recorded intent; they did not launch or restart an agent.
- B5: a synthetic Claude CLI and loopback device-approval provider completed the actual browser sign-in-terminal flow. This proves the AgEnD web flow; it does not verify Claude’s external identity service.
- Hub: actual HTTPS web, preview and member listeners; real directory driver against an owned TLS OpenLDAP fixture with AD-shaped users; real Hub routes, sessions, grants and attachment checks. The Hub service fixture uses in-memory content/audit storage. Replies and polls are scripted member protocol frames, not model inference. Research/Design helpers were initial published fixture data; C11 separately published a real fixture fleet agent through its Share switch and granted it in the Hub UI.
- B8: production Telegram/Discord adapters, FleetManager ingress, delivered human-receipt lookup, `update_instance_config`, persisted YAML, and adapter reply. Native transports and model decision were scripted; receipt judge observed an owned synthetic pane. Restart was stubbed. This proves the same-chat tool path exists, not natural-language model reliability or a native relaunch.
- E18: a recorded Claude 2.1.319 stream entered the production transcript monitor/FollowLog while the real local fixture file changed. No real model or CLI ran.
- E19: fresh synthetic usage entered real QuotaNotices with FM’s live saved policy and send callback. Two enabled agents shared one credential profile; two identical observations yielded one send, both on web and in each native chat mock. No vendor usage or time-travel expiry was involved.
- UI/docs supplied the navigation. Source was consulted after failures and for fixture transport plumbing. Locator mistakes, private tmux setup failures, a transient 429 during rapid automation, and fixture-missing-runtime states were excluded from product findings.

## Story record

✅ = completed through the stated surface within the mock boundaries above; ⚠️ = completed with a guess or forced context handoff; ❌ = blocked.

| Story | Surface | Actual steps and observed outcome | Result / severity | PNG evidence |
|---|---|---|---|---|
| B5 | Fleet web, desktop EN | Settings → Agents → Accounts → add `personal` → browser sign-in terminal → loopback device approval → signed in → Move agents here → select worker → Stage → Save. Save returns HTTP400 `unsupported_sensitive_effect`, including a verified host-owner session. Account assignment remains unchanged. | ❌ P1 | [Signed in](b5-06-personal-signed-in.png), [visible rejection](b5-12-current-alpha-visible-error.png), [fresh current-process repeat](b5-13-fresh-current-alpha-error.png) |
| B6 | Fleet web, desktop EN | Accounts → old-work → Keep sign-in alive. The row shows its end date and warns that renewal cannot move the date and to sign in again before then (3 days away). | ✅ | [Enabled and warning](b6-01-keepalive-enabled-expiry.png) |
| B7 | Fleet web, desktop EN | Sign out old-work → dialog names the affected worker and offers Move → mocked CLI logout → Remove → dialog blocks while worker uses it → Move → Account personal → Done → Save. The same B5 confirmation failure prevents the move and therefore removal. | ❌ P1, same root finding as B5 | [Affected agent](b7-01-signout-affected-agent.png), [removal guard](b7-02-remove-in-use.png), B5 rejection above |
| B8 | Telegram + Discord mocks | Native human message “General, switch worker to the Claude Code account team.” → verified delivered receipt → scripted decision calls the real config tool → YAML says team → one restart intent → reply returns to originating chat/thread. No redirect to web. | ✅ within mock model/restart scope | Text evidence below; no screenshot of a real native client is claimed |
| C9 | Hub web, desktop EN | AD admin signs in → Menu → Administration → owner olivia → Make code. Before olivia’s first Hub sign-in, generic “Not found, or not available to you.” After olivia signs in once, the same input produces a code; member consumes it and admin sees waiting fingerprint. | ⚠️ P2: undocumented first-login prerequisite | [Failure](c9-03-make-code.png), [same owner succeeds](c9-05-code-after-owner-login.png), [waiting](c9-06-fleet-waiting.png) |
| C10 | Fleet + Hub web, desktop EN | Settings → Access & security (now Settings → Hub) → membership on → verified-owner in-page approval → reload → address + code. Admin code card contains no member address; copying Hub browser address fails. With fixture member address supplied, compare fingerprint → local confirm → Hub My shared agents confirm → Hub admin approve → fleet Online. No terminal or chat required. | ⚠️ P2: incomplete address handoff / guess | [Admin code lacks address](c10-06-admin-code-no-address.png), [failure after wrong address](c10-08-confirmed-connect-failed.png), [connected](c10-12-connected-fleet-share.png) |
| C11 | Fleet web → Hub web | On connected fleet: Share worker → published. No can-ask/grant control or agent grant link there. Switch to Hub → Menu → My shared agents → select worker → Allow → alex → Allow → “1 may ask”. | ⚠️ P2: permission half requires another control plane | [Current fleet page](c11-09-current-alpha-hub-share-no-grant.png), [Hub grant](c11-07-grant-only-on-hub.png), [success](c11-08-new-fleet-agent-granted.png) |
| C12 | Hub web desktop EN + phone zh-TW | AD colleague signs in → New chat → select granted agent → attach txt → question → Send → HTML answer + poll → Preview options → allow previews/confirm → Open in panel → consent → rendered HTML → vote. Works at both sizes. Phone vote then exposes an English internal poll-result prompt, directory identifier, latency and agent instructions as the asker’s chat bubble. | ✅ P3: task completes, protocol text leaks into conversation | [Desktop HTML](c12-07-desktop-live-html.png), [phone attachment](c12-10-phone-file-question.png), [phone HTML](c12-13-phone-live-html.png), [poll protocol bubble](c12-14-phone-poll-results-protocol.png) |
| C13 | Hub owner web + colleague phone | Owner’s agent page → Pause questions → Stop all asking. Colleague’s room shows owner-paused explanation; history remains readable and Send is disabled. | ✅ | [Paused room](c13-02-phone-after-owner-pause.png) |
| E18 | Fleet web desktop EN | Worker chat → More actions → Files & changes → Follow agent. Recorded read selects src/a.ts lines2–4; recorded edit changes actual file to value2, viewer updates and highlights the edit with Following still on. | ✅ recorded-stream scope | [Read](e18-02-follow-read.png), [edit](e18-03-follow-edit.png) |
| E19 | Fleet web + Telegram/Discord mocks | Notifications → Remaining percentages25 → blur → Save → applied. Two same-account agents, fresh weekly80% usage; two observations send once. Web Notices displays one20%-remaining reminder; both native mocks each receive one too. | ✅ synthetic usage scope | [Saved threshold](e19-01-threshold-saved.png), [one web notice](e19-02-one-account-reminder.png) |

## Native transcript and quota checks

For both Telegram and Discord:

```text
human: General, switch worker to the Claude Code account team.
delivery_status: delivered; unique-id-pane; original actor/body retained
update_instance_config(worker, backend_options.claude-code.credential_profile=team)
result: success; savedProfile=team; one restart intent (stubbed)
reply: Fixture: worker’s saved account is now team; restart intent recorded only (no CLI relaunched).
quota policy: two enabled subscriptions, same team account, weekly, threshold25
usage fixture:80% used, known future reset, observed twice
native sends containing Usage reminder:1
Usage reminder · Claude Code · team
Weekly:20% remaining
```

Run infrastructure lives under ignored `.artifacts/ux3322/` (not a download attachment). Product browser runs used real loopback listeners and actual UI actions; B8/E19 native checks exit0. No source implementation was changed and no full-suite claim is made for this review.

## Finding boundaries

1. Accounts: the confirmation diff rejects the `credential_profile` string before presenting/applying a supported account change. B5 and B7 are one finding.
2. Hub pairing owner: login resolution requires a cached Hub person row. Keep the identity/rename safeguards; expose the first-login prerequisite or resolve the directory identity safely.
3. Hub pairing handoff: show the member connection address with the code and distinguish it from the browser address. Keep fingerprint/owner/admin confirmation.
4. Hub permissions: publication on fleet and grants on Hub are split. Provide an authenticated contextual flow or explicitly carry the agent/return context; do not weaken grant authority.
5. Poll: retain the machine-readable result for the agent, but present a localized human result in the chat rather than the internal prompt.

No credentials or bearer URLs are included. Codes, fingerprints, directory IDs and identities in these PNGs belong only to the disposable fixture.
