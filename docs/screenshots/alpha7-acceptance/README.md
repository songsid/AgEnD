# Alpha.7 acceptance

Pass 1 product build: `b9bcdf454700f02ebb953cabf2297a59ce39f363`.

Real Chrome 156, desktop 1366 × 900 and phone 390 × 844. All fleets, directory users, credentials, APIs, Runtime peers and marker files belong to isolated test rigs. No live fleet or real account was used. This branch contains evidence only.

## C11: new colleague prerequisite

`pass1/pass1-C11-03-allow-new-colleague.png` shows the actual failed Allow. `alex` was an eligible user in the fake LDAPS directory, with no prior Hub session. The owner typed `alex` into the contextual Allow dialog and submitted. The page displayed “Not found, or not available to you.” behind the still-open dialog. After Alex signed in to this Hub once, the unchanged Allow succeeded and showed “1 may ask.”

The existing named-known-person grant restriction is respected. This finding concerns the missing first-sign-in instruction and recovery, not a proposal to broaden grant authority.

Further story results and the dependency delta will be added after pass 2.

## Pass 1 observations

| Story | Surface and executed result |
| --- | --- |
| B5 | Desktop web EN: add `personal`, open private browser sign-in terminal, approve local mock provider, Move worker → Stage → Save. YAML selects `personal`; the real Settings reconciliation records its stop/start. No additional confirmation. Native process start is a recording boundary. |
| B7 | Desktop web EN: sign-out lists the affected worker; Remove refuses references and offers Move; move to Default, Save, type unused account name, Remove. Account disappears. Phone zh-TW account layout also checked, without overflow. |
| C9 | Hub web EN: admin generates Olivia’s code before Olivia has any Hub session. Card includes the separate member listener address. |
| C10 web-only | Enable membership, reload the offered controls, submit address/code, confirm local fingerprint, first owner Hub sign-in and confirmation, admin approval → Connected/Online. The host-issued loopback session is accepted at submit; no separate Apply now button appeared. `C10-02` captures “Confirmed — applying…”, not an Apply now control. |
| C10 chat/no-General | Before D3, the same host-issued session remains pending and explains the absent General. This is the known dependency delta for pass 2, not a newly filed regression. No gate bypass was used. |
| C11 | Contextual Allow link restores the exact agent across owner sign-in. Grant succeeds after colleague’s first Hub sign-in. Missing prerequisite/recovery filed as [#3370](https://github.com/songsid/AgEnD/issues/3370). |
| C12 | Desktop EN and phone zh-TW: question plus text attachment, real Hub/member TLS/WSS admission, scripted public `hubReport` answer, HTML opt-in, rendered isolated preview, Point at it, page/element-context reply, poll vote, closed tally after reload. Phone document width equals 390px. No generated `[poll results]` asker bubble. Replies are scripted; no model/native answer execution is claimed. |
| A2 | Current-alpha UI boundary only: Settings search `update` has no match; Advanced offers no updater. [#3332](https://github.com/songsid/AgEnD/issues/3332) remains parked. No actual beta upgrade, rollback, updater or tmux migration claim. |
| D15 | Normal code/fingerprint UI → Online → install/detect mocked Claude inventory → Accounts on mock PC → add `work`, Sign in, submit `FAKECODE`, Signed in ✓ → sign out and remove. Public-protocol Linux mock of a Windows peer; no Windows/vendor/install execution or remote agent execution claim. Runtime’s host-login guidance remains parked [#3333](https://github.com/songsid/AgEnD/issues/3333). |
| E20 web-only | Real audited Claude Code 2.1.318, production daemon/prompt bridge, mock Messages API: Yes from web Needs-you creates `yes-marker`; No for separate `no-marker` leaves it absent. Real pane ends “Interrupted · What should Claude do instead?”. No auto-answer or fabricated prompt. |
| E20 chat | Real Claude plus production Telegram adapter with a loopback Bot API mock emits generic Permission needed/Needs-you and Cancel, without permission choices; marker stays absent. [#3334](https://github.com/songsid/AgEnD/issues/3334) remains parked. The observed chat-fleet web session is unverified, so it is not presented as an independent verified-chat-web test. No Discord rerun claim. |

Audited Claude ELF SHA256: `708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd` (337,814,032 bytes), independently obtained from the official `@anthropic-ai/claude-code-linux-x64@2.1.318` tarball and hash-checked against the audit handoff. Permission mock’s original SHA256: `f9ae948d41d92bd706349e6a28a90fc3975f195022cc7d9e471b37ad52c194b7`; only its fixed scratch worker path was changed. Both real-CLI fleets ran in owned internal-network containers with dummy keys, local APIs and auto-updates disabled. Each used its own container HOME and private tmux socket. They are stopped after pass 1.

PNG notes: E20 Needs-you and phone preview were recaptured after content became visible. The page-context draft in `C12-06` is followed by the sent message and agent answer in `C12-07`. Some emoji use fallback boxes in this test font environment; CJK text is legible. Early captures that missed their claimed state are excluded.

Harness note: the Pass 1 Hub context’s language-preference init script attempted localStorage in three opaque preview frames, producing three SecurityError events in the test collector. These came from the test init script, not the HTML answer. The preview rendered and interaction checks passed. The init script is guarded for pass 2; pass 1 does not claim an error-free application log from that collector.

Runtime cleanup also exercised D8: on phone zh-TW, the mock PC’s actions → Revoke → confirm → reload removed it from the list (0 computers). No agent referenced that peer. All owned pass-1 listeners and real-CLI containers were stopped; no live fleet was changed.
