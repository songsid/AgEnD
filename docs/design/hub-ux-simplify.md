# Hub UX simplification: build spec for Phase A and Phase B

Source: [#3658](https://github.com/songsid/AgEnD/issues/3658) and [`hub-ux-review.md`](hub-ux-review.md) (M-2902). The owner chose Phase A and Phase B together on 2026-11-11; Phase C (device-code direction) is out.
Not in this spec: the setup wizard fixes (M-2917, Cairn) and the re-join dead end (#3644, re-checked in the alpha.14 rehearsal).
Base: `release/2.3.5-alpha`. Line references are to `1066a85a`. Alpha-only, behind the existing Hub switches.

Words used here: **must** is a requirement, **decision** marks a choice this spec makes where the review left it open, **open** marks something the leader or owner has to settle (collected in section 6).

## 0. What stays unchanged

| Property | Where it lives today | Effect of this spec |
|---|---|---|
| Company AD identity | The person signs in on the Hub page; `approve()` binds `realm/objectGUID` (`src/hub/join/service.ts:243`) | Unchanged in A and B. Every fleet still needs its owner's AD sign-in. |
| Local admin consent | A signed-in Fleet admin's press of 「以公司帳號登入」 (decision a9ccee59), enforced in `src/settings-http-confirmation.ts:148` | Unchanged for joining. Reconnect reuses the same rule (see 1.3, open item O1). |
| Hub key pinning | `CompanyTrustStore.checkAndPin` (`src/hub/join/trust.ts`): first use under CA-validated TLS, or an expected digest from a link | Unchanged. A typed address is already supported; this spec only makes it the default. |
| Fleet key proof, PKCE, state hash, nonces, record CAS | `src/hub/join/protocol.ts`, `service.ts` `consume`/`records.save` | Unchanged. Phase B adds one field to the push payload and one branch in `approve()`. |
| Named-person admin approval | Individual invitation (`createInvitation`, `service.ts:116`) | Phase B adds a second form of approval: an enrolment code. It replaces **only** this. |

## 1. Phase A

### 1.1 Fleet: one input for the Hub

Files: `src/ui/settings-hub-company-join.js`, `src/ui/hub-company-join-strings.js`, `src/ui/settings-hub-connection.js`; Fleet server: the company-join local API (`src/hub/join/local.ts`, `http.ts`).

**Form.** The unconnected card has one text input, the button 「以公司帳號登入」 and a collapsed 「其他方式」 disclosure that holds the pairing-code form. The 「Fleet 名稱」 field is removed from the form.

**What the input accepts.** The page trims the value and classifies it locally, in this order:

| Typed or pasted | Treated as | Sent to `start` |
|---|---|---|
| `https://host[:port]/join-info#hub=…` or `#invite=…` | Legacy company link or invitation | unchanged, as `address` |
| `https://host[:port]` | Hub web address | unchanged |
| `host[:port]` (no scheme, a valid host name or IP) | Hub web address | `https://` + value |
| any of the above, then whitespace, then 8 code characters (optional `-` after the 4th) | Address plus enrolment code (Phase B) | `address` and `code` |
| 12 hex characters alone, or address + 12 hex | Pairing code | not sent; opens 「其他方式」 with the fields filled in, no submit |
| `http://…` | Refused | message E2 |
| anything else | Refused | message E1 |

**Probe (new, read-only).** After 600 ms without typing, and again on blur, the page calls `POST /api/hub/member/company-join/probe { address }`.
- Same gate as `start`: a signed-in admin cookie session with CSRF; header tokens, guests and public links are refused.
- The Fleet fetches the Hub's public join metadata over CA-validated HTTPS, exactly as `start` does, and stops there. It **must not** pin, write a journal, create a handoff or push.
- Limit: 10 probes per session per minute; 5 s timeout.
- Response: `{ hubName: string | null, webOrigin, companyJoin: boolean, identity: "new" | "known" | "changed", separateHosts: boolean }`.
  - `hubName` comes from a new display-only `name` field in the Hub's metadata response (server item S1.1). An older Hub omits it; the page then shows the host name.
  - `identity` compares the fetched identity digest with the saved pin for that origin without changing it.
- The page shows one line under the input: 「找到「{hubName}」。這台 Fleet 會顯示為「{label}」」 with a 「改名」 link that reveals a single optional text input.

**Fleet label.** Default: the computer's host name (`os.hostname()`, first label, at most 120 characters), served by the Fleet in the probe response as `suggestedLabel`. If it is empty, use the existing `defaultFleet` string. The label is sent in `start` as today. Renaming after connecting is out of scope.

**After the press.** Unchanged protocol. Two UI changes:
- The Fleet card shows 「已開啟 {hubName} 的登入分頁…」 with a countdown from the server's `outerDeadline`, plus 「重新開啟分頁」 and 「取消」.
- The Hub tab, once `browserView().connected` is true, replaces its content with 「已連接。可以關閉這個分頁。」, calls `window.close()`, and if the tab is still open after 300 ms shows the existing 「返回 Fleet 設定」 link. The Fleet page already follows the claim and updates by itself.

**Connected card.** Title is the Hub name. One line: 「以 {ownerLabel} 的公司帳號連接 · 這台 Fleet 叫「{label}」」. `ownerLabel` and `hubName` are display-only fields added to the redeem response (S1.3) and saved beside the profile; when absent the line is omitted. The 「設定 Hub」 card moves below the connection card and collapses to a link once a connection exists.

**Messages.** One sentence that says what happened, then what to do. The codes are the existing ones unless marked new.

| # | Condition (code) | zh-TW | EN |
|---|---|---|---|
| E1 | Not an address (local check) | 這不是 Hub 位址。請輸入像 hub.example.com 的位址。 | That is not a Hub address. Enter one like hub.example.com. |
| E2 | `http://` | Hub 位址必須是 https。 | A Hub address must use https. |
| E3 | DNS, refused, timeout (probe `unreachable`, new) | 連不上 {host}。請確認位址，以及這台電腦連得到公司網路。 | {host} cannot be reached. Check the address and that this computer is on the company network. |
| E4 | TLS not trusted (probe `certificate`, new) | {host} 的憑證不受這台電腦信任，所以沒有連接。請向 Hub 管理員確認位址或憑證。 | This computer does not trust {host}'s certificate, so nothing was connected. Check the address or certificate with your Hub administrator. |
| E5 | Not an AgEnD Hub (probe `not-hub`, new) | {host} 不是 AgEnD Hub。 | {host} is not an AgEnD Hub. |
| E6 | Hub has company join off (`incompatible`) | 「{hubName}」還沒開放用公司帳號連接。請 Hub 管理員開啟。 | "{hubName}" does not accept company-account connections yet. Ask its administrator to turn them on. |
| E7 | Same host name (`separateHosts`) | Hub 和這台 Fleet 的網址要用不同的主機名稱。只換連接埠不行。 | The Hub and this Fleet need different host names. A different port is not enough. |
| E8 | Identity differs from the saved one (`changed`) | 「{hubName}」的身分和上次不同，所以沒有連接。請向 Hub 管理員確認後，再選「更換已儲存的 Hub 身分」。 | "{hubName}" presents a different identity than before, so nothing was connected. Confirm with your Hub administrator, then choose Replace saved Hub identity. |
| E9 | Not permitted (`denied`) | 你的公司帳號沒有連接 Fleet 的權限。請找 Hub 管理員。 | Your company account may not connect a Fleet. Ask your Hub administrator. |
| E10 | Per-person limit (`limit`) | 你已經連接 {n} 台，達到上限。請先在 Hub 撤銷一台。 | You already have {n} Fleets connected, the limit. Revoke one on the Hub first. |
| E11 | Hub busy (`busy`) | Hub 正在處理其他連接，稍後會自動再試。 | The Hub is handling other connections and will retry shortly. |
| E12 | Request ran out of time (`expired`) | 這次連接逾時了，沒有建立任何東西。請再按一次。 | This attempt timed out and nothing was created. Press again. |
| E13 | Another connection method is in progress for this person (new reason `offer-pending`, S1.5) | 你有另一個用配對碼的連接還沒完成。請先在 Hub 完成或停止它。 | Another connection with a pairing code is still in progress for you. Finish or stop it on the Hub first. |
| E14 | Outcome unknown (`unknown`) | 無法確認結果。請按「檢查這次連接」，不要重新開始。 | The result could not be confirmed. Choose Check this connection; do not start again. |

E12 is only correct when nothing was issued; when a fleet was issued the existing `issued`/`expired` wording stays. E13 replaces today's behaviour where this case surfaces as E14: `approve()` throws `conflict` when the person has a live pairing offer (`service.ts:267-268`). That is the most likely cause of the first re-join failure in the review (the test person had an unexpired 「連接我的 Fleet」 offer); it should be confirmed by the acceptance leg A-L6.

### 1.2 Hub: the administrator's 「讓同仁加入」 card

Files: `src/ui/panel-hub.js`, `src/ui/hub-company-join.js`, `src/ui/hub-group-policy.js`, `src/ui/hub-welcome.js`, `src/ui/hub-quick-pairing.js`, the matching string modules.

**Placement.** First card on Administration. Also shown on the Chats welcome page to an administrator while no fleet is connected, replacing the line 「你的 Hub 管理員會幫你配對 Fleet…」, which an administrator must never see.

**Three steps, each with a done mark derived from server state:**

| Step | Done when | Control |
|---|---|---|
| 1 允許同仁用公司帳號連接 Fleet | `company-join.enabled` | The existing switch. |
| 2 誰可以加入 | Group policy state is `enabled` and at least one group allows `pair_fleet` with `maxFleets ≥ 1`; or (Phase B) a live enrolment code exists | Group search box, chips for chosen groups, per-group 「每人最多 N 台」 and the two other permissions, then the existing impact preview and save. The separate 「開啟／關閉」 and 「開啟並儲存」 pair becomes one 「儲存」 that enables the policy when it has at least one group. |
| 3 告訴同仁怎麼加入 | never auto-done | The text 「在 AgEnD 的「設定 → Hub」輸入 {host}，再用公司帳號登入。」 with 「複製這段說明」. `{host}` is the web origin without `https://` and without `:443`. Phase B adds 「建立加入碼」 here. |

Step 3 is disabled with the reason shown until steps 1 and 2 are done.

**Group search (new endpoint, server item S2).** `POST /hub/v1/admin/group-policy/search { q }`.
- Admin only, CSRF, same context as `resolve`. Input feedback only, never authority: choosing a result calls the existing `resolve` with its DN, and preview and apply re-resolve as today (`admin-dto.ts:37`).
- `q`: 2–64 characters after trimming. Refuse control characters.
- AD profile query, base = the configured base DN, scope subtree:
  `(&(objectCategory=group)(groupType:1.2.840.113556.1.4.803:=2147483648)(|(cn=Q*)(sAMAccountName=Q*)))`
  where `Q` is `q` escaped per RFC 4515 (`\ * ( ) NUL` → `\5c \2a \28 \29 \00`). Prefix match only, so the directory can use its indexes. This is the first Hub query that puts user text into a filter; the escaping needs its own unit test with those five characters.
- Attributes `objectGUID`, `cn`, `distinguishedName`. Size limit 20, time limit 5 s. Search continuation references are ignored, not followed (the M-2724 lesson).
- Uses the service bind and spends the existing directory read pool (4 per person, 32 total). The page debounces 300 ms; the server also limits one admin session to 30 searches per minute.
- Response: `{ ok: true, groups: [{ objectId, cn, dn }], truncated }` or `{ ok: false, reason: "unsupported" | "unknown", failure? }` with the same `failure` values as `resolve`.
- When the directory does not support group policy (`groupPolicy !== "ad-direct-guid"`), the answer is `unsupported` and the page keeps today's DN input.
- The DN input stays available under 「用辨別名稱新增」 for groups the prefix search does not find. No member counts are shown; the impact preview remains the place that says who is affected.

**Welcome page.** 「連接我的 Fleet」 (the code-and-fingerprint path) moves into a collapsed 「其他方式」 block. The primary text for someone with no fleet is the same sentence as step 3.

**Paired fleets list.** `GET /hub/v1/admin/overview` gains `label`, `source` and `createdAt` per fleet (S1.2). The row title is the label, the subtitle the owner's name. Active rows first; revoked rows sit under a collapsed 「已撤銷（n）」.

### 1.3 One-button reconnect and Hub-side cleanup

**Fleet side.** A held connection (`revoked`, `rejected`, `refused`, `expired`, `disconnected`, `unsaved` stays as it is) shows one primary button 「重新連接」 and a link 「移除這個連接」.

`POST /api/hub/member/company-join/reconnect { hubId, binding }` (new Fleet endpoint, same gate as `start`) does, as one claimed operation with the `hub-join` presentation:
1. If the binding is not yet disconnected: the existing `disconnect(expected)`.
2. The existing start-over step that retires the binding.
3. The existing `start` with the web origin and label saved for that binding and `expected` = the saved identity digest, so a changed Hub identity still stops at E8.
4. It adds `supersedes` to the push (below) when the old credential is still on disk.

Any failure leaves the state that the completed steps produced and shows the matching message; the button can be pressed again. A binding made by the pairing-code path reconnects through company join only if the Hub advertises `company-join-v1`; otherwise the button opens 「其他方式」.

「移除這個連接」 is today's Disconnect followed by Start over behind one confirmation: 「要移除與「{hubName}」的連接嗎？你分享的 Agent 會停止回答。」

**Hub side: no stale active rows.** Two server changes (S1.4):

- **Leave.** When a paired Fleet disconnects and its member link is up, it first sends `member.leave` on the pinned member link, authenticated by its credential like any member frame. The Hub marks that fleet `revoked`, bumps `generation` and `revocationVersion` exactly as `revoke()` does (`src/hub/pairing.ts:339`), and audits `member.left` with actor `{ kind: "member", fleetId }`. Narrowing only. If the link is down the Fleet disconnects locally as today.
- **Supersede.** The push payload gains optional `supersedes: { fleetId, credential }`, sent only over the pinned member listener. At push the Hub checks that the fleet exists, is `active`, and `sha256(credential)` equals its `credentialHash`; on success it stores only `supersedesFleetId` in the join record, on failure it ignores the field. In the issuance transaction, if that fleet is still active and its owner equals the approved owner, the Hub revokes it in the same transaction, audits `member.superseded`, and does not count it in the per-person limit check. A different owner refuses the join with `denied`.

After these, a stale active row can only come from a Fleet that was disconnected while offline and never reconnected; the admin list's 「最後上線」 is out of scope.

### 1.4 One vocabulary

Scope: every string in `src/ui/hub-strings.js`, `hub-company-join-strings.js`, `hub-quick-strings.js`, `hub-owner-strings.js`, `hub-group-strings.js`, `hub-chat-strings.js`, `hub-grant-strings.js`, `hub-pairing-progress-strings.js`, `hub-read-strings.js`, `settings-hub-setup-strings.js`, the inline strings of `settings-hub-connection.js`, `settings-hub-membership.js`, `settings-hub-company-join.js`, and the Hub lines of `agend hub handoff` (coordinate that last one with M-2917).

| Concept | zh-TW | EN | Replaces |
|---|---|---|---|
| Create the Fleet–Hub relationship | 連接 | connect | 配對, 連線, 加入, 使用; pair, join, use |
| The relationship | 連接 | connection | 配對, 連線, 成員連結; pairing, member link |
| A Fleet that has one | 已連接的 Fleet | connected fleet | 已配對的 Fleet; paired fleet |
| End it from the Fleet | 移除連接 | remove connection | 撤銷連接, 中斷連線, 重新開始; revoke connection, disconnect, start over |
| End it from the Hub | 撤銷 | revoke | (kept) |
| Suspend without ending | 暫停連接 | pause connection | (kept) |
| Repair | 重新連接 | reconnect | 重新配對, 重新開始, 復原這次連接 as a primary action; pair again, start over |
| The Hub's address shown to people | Hub 位址 | Hub address | 公司連結, 同仁連線連結, Hub 連結, 成員傳輸位址 outside setup |
| Legacy code path | 配對碼 | pairing code | 一次性配對碼, 手動配對碼; one-time code, manual pairing code |
| Phase B code | 加入碼 | join code | — |
| Individual exception | 個別邀請 | individual invitation | 例外邀請; invitation exception |
| Let an agent answer Hub questions | 分享 | share | 公開; expose, publish, exposure |
| Shared agents list | 我分享的 Agent | My shared agents | 我的公開 Agent; My exposures |
| Let a person ask | 允許提問 | allow to ask | (kept) |
| The directory account | 公司帳號 | company account | 組織帳號, 目錄帳號; organisation account, directory account |
| The product nouns | Hub, Fleet, Agent | Hub, Fleet, Agent | lower-case `fleet`, `agent` in EN UI text |
| The Hub's administrator | Hub 管理員 | Hub administrator | Hub admin |
| The key check | 金鑰指紋 | key fingerprint | 身分指紋, 成員金鑰指紋, 配對指紋 outside the pairing-code path |

Rules:
- 配對 / pair may appear only inside the 「其他方式」 pairing-code path and in its own messages.
- The member transport address is shown only in Hub setup and in the pairing-code path. Everywhere else people see the Hub address (web origin); the held card shows the Hub name, not `:18602`.
- A button and the dialog it opens use the same verb.
- EN spelling is US (`organization`, `recognize`).
- Internal identifiers, route names and audit actions are not renamed.

**Gate.** A test reads the string modules above and fails when a banned term appears under a key outside an allow-list: zh 配對, 連線 (except 網路連線-type phrases on the allow-list), 公開, 組織帳號, 手動配對碼, 同仁連線連結; EN `pair`, `exposure`, `expose`, `organisation`, `Hub admin`. The allow-list names the pairing-code keys explicitly. The test asserts it checked more than zero keys per module.

### 1.5 Removing the link and the name field

- Admin UI: 「複製同仁連線連結」 and 「連接連結內容」 leave the primary card. **Decision:** the link remains reachable as 「含金鑰指紋的連結（進階）」 inside a collapsed block of step 3, because it is the only out-of-band pin; the API field `companyLink` is unchanged. See open item O2 for deleting it outright.
- Fleet: the input still parses a pasted link, so links already handed out keep working.
- The public `/join-info` page keeps working for existing links.
- The Fleet name field is removed as described in 1.1. `pushPayload.label` stays required on the wire.

## 2. Phase B: enrolment code (「加入碼」)

### 2.1 Security model

**What a code is.** A bearer token that stands for the configured Hub administrator's approval to connect a Fleet, for anyone in scope who presents it before it ends. It is the multi-use form of today's individual invitation.

**What it is not.** It is not an identity, not a credential for the member link, and not a grant to ask or share. With a code and nothing else, nobody can connect anything.

Stated plainly:
- **AD sign-in stays.** Each Fleet is issued only after its owner signs in on the Hub with their company account in that request's browser step.
- **Local consent stays.** Each Fleet's signed-in admin still presses 「以公司帳號登入」 on that Fleet.
- **Pinning stays.** The code travels only after discovery, over the pinned member listener, as the invitation does today.
- **The code replaces only the named-person admin approval** (and, for people in scope, the need for a group that grants `pair_fleet`).

| Aspect | Rule |
|---|---|
| Who creates | Only the configured Hub administrator, the same check as `createInvitation` (`service.ts:118`): directory actor equal to `options.administrator`, current session, company join enabled. |
| Format | 8 characters from Crockford base32 without `I L O U`, shown as `XXXX-XXXX` (40 bits). Input is case-insensitive and ignores `-` and spaces. |
| Expiry | Chosen at creation: 1 hour, end of today (Hub local time), or 7 days. Hard maximum 7 days. No extension; create a new code. |
| Uses | `maxUses` 1–200, default 30. One use = one issued Fleet. |
| Scope | `directory` (any eligible person in the configured directory) or `group` (one AD security group chosen through search/resolve; membership is read fresh at each approval). |
| Fleets per person | `perPersonFleets` 1–8, default 1. Checked against that person's active fleets from every source plus their in-flight reservations. |
| Grants | Connect only. `ask_agents` and `share_agents` still come from group permissions. People on the policy's exclude list for `pair_fleet` are refused, as for invitations. |
| Revocation | The administrator ends a code at once. New pushes and approvals with it are refused; requests not yet issued are ended with reason `authority`; fleets already issued are untouched and are revoked individually as today. |
| Live codes | At most 8 at a time; at most 10 created per hour. |
| Storage | The Hub stores `HMAC-SHA256(key, code)` for lookup and the code sealed with AES-256-GCM for re-display to the administrator until it ends. The key is a new private file `hub/secrets/enrolment-code.key` (0600), created on first use. After a code ends, the sealed copy is deleted. A database copy without the key reveals no live code. |
| Guessing | Wrong codes are counted in a bucket `code:invalid`: more than 10 per minute Hub-wide refuses all code pushes for the rest of that minute (the same shape as `pair:invalid`, `pairing.ts:150`). A push with a wrong code gets one generic answer and creates no record. |
| Audit | `enrolment-code.created`, `enrolment-code.revoked`, `enrolment-code.ended` (expiry or exhaustion, written lazily), and on each use the existing `company-join.identity-approved` and issuance events carry `reasonCode: "code"` and the code id. The code text is never written to audit, notices, logs or URLs. |
| Notices | The person's other sessions and fleets and the administrator are notified per issued Fleet, as for group joins. Provenance is new (2.3). |

**Honest cost.** Approval widens from one named person to every in-scope person who gets the code. If it leaks inside the company, people who were not meant to can connect Fleets under their own names until the code ends, up to `maxUses`. They cannot act as anyone else, cannot read any chat, and cannot ask any agent without its owner's grant. Outside the company the code is useless without a company account. The throttle on wrong codes can be used to block code joins for a minute at a time; group and invitation joins are unaffected.

### 2.2 Data

New component `enrolment-code` version 1 in the Hub database, with the same rollback rule as `company-join`: an older binary cannot read it; roll back by restoring matching state.

```
hub_enrolment_codes(
  id TEXT PRIMARY KEY,            -- uuid
  mac TEXT UNIQUE NOT NULL,       -- HMAC-SHA256(key, normalized code), hex
  sealed BLOB,                    -- AES-256-GCM(code); NULL once ended
  created_by TEXT NOT NULL,       -- personKeyString(administrator)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  per_person INTEGER NOT NULL,
  scope TEXT NOT NULL,            -- canonical JSON: {"kind":"directory"} | {"kind":"group","realm","objectId","dn"}
  revoked_at INTEGER, revoked_by TEXT
)
hub_enrolment_code_uses(
  request_id TEXT PRIMARY KEY,    -- the join request; makes counting idempotent
  code_id TEXT NOT NULL, fleet_id TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL
)
```

`JoinRecord` gains `enrolmentCodeId: string | null` (mutually exclusive with `invitationId`) and `supersedesFleetId: string | null` (1.3). Records without the fields read as `null`.
`hub_group_resources.source` gains the value `code`; its body carries `{ codeId, approvedBy }`.

### 2.3 Protocol and admission

**Push.** `pushPayload` gains `code: string | null` (max 16 characters). `code` and `invitation` together are refused as `invalid`. With a code, `push()`:
1. Spends the `code:invalid` check, normalizes, looks the MAC up.
2. Requires the row to be live (not revoked, `expires_at > now`, `uses < max_uses`). Otherwise: count one invalid, answer `denied`, insert nothing.
3. Inserts the record with `enrolmentCodeId`. No use is counted and nothing is reserved yet: a push needs no AD sign-in, so it must not be able to consume uses.

**Approve.** In `approve()` (`service.ts:243`), a record with `enrolmentCodeId` takes a third branch beside invitation and group:
- Budgets: the per-person `quick:<person>` 5 per minute stays. Instead of `quick:all` 48 it spends `code:<id>` and `code:all`, each 120 per minute.
- Owner eligibility: the existing `prepareOwnerEligibility`.
- Permit: new `groups.prepareCodeEnrollment(resource, { codeId, approvedBy, scope }, context)`. For scope `directory` it needs eligibility only. For scope `group` it performs a fresh membership read for that one group through the existing policy-group reader and refuses with `denied` when the person is not a member or the read is unknown. It applies the same exclude handling as `prepareManualEnrollment`. It returns `{ source: "code", maxFleets: per_person, assertCurrent, commit }`.
- In the approving transaction, in this order: record CAS and `live()`; code row live; `uses + reservations(code) < max_uses`; the person has no other request in flight (unchanged rule, now answering `offer-pending` instead of `conflict`, S1.5); retained ceiling (below); `automaticFleetSlots(...)` counting all of the person's active fleets `< per_person`, else `CompanyJoinLimit`.
- The reservation is the record itself in stage `identity-approved` or `issued` with that code id; it ends with the record.

**Issue.** The existing single immediate transaction (consume CAS, quota, credential, provenance, audit, sealed receipt, notices) additionally runs
`UPDATE hub_enrolment_codes SET uses = uses + 1 WHERE id = ? AND uses = ? AND revoked_at IS NULL AND expires_at > ?` and inserts the `hub_enrolment_code_uses` row. Zero changed rows aborts the issuance with `revoked`. Redelivery and recovery of an issued result find the uses row by `request_id` and count nothing.

**Replay and fences.** A code is deliberately reusable, so it adds no replay protection and removes none. Each request still has its own Fleet key, 30-second proof nonces, PKCE verifier, browser state hash, Origin-bound browser step, record version CAS, session and directory-epoch fences and the 10-minute outer deadline. Presenting the same code twice makes two requests, each needing its own AD approval. A code revoked or ended between approve and issue fails at the `UPDATE` above.

**Policy changes.** `policyUpdated()` keeps ending in-flight requests of excluded people; a code request is not ended merely because the group policy is off. Turning company join off ends code requests like all others and leaves the codes themselves in place but unusable (`enabled()` is checked first).

**Notices.** New link feature `pairing-notices-v3` with `source: "code"` and `codeId`. A v2-only member or cached web client keeps those rows queued, the same rule that v1 links have for manual rows today (`src/hub/pairing-notices.ts:96,133`).

**Metadata.** The Hub's features list gains `enrolment-code-v1` while company join is enabled. A Fleet that is given a code for a Hub without it shows 「這個 Hub 還不支援加入碼。」 and sends nothing.

### 2.4 Capacity: 50 and more Fleets

Today's ceilings and what changes for code joins:

| Limit today | Value | For code joins |
|---|---|---|
| Admission budget, all people | 48 per minute (`quick:all`, `service.ts:251`) | Own buckets `code:<id>` and `code:all`, 120 per minute each. |
| Admission budget, one person | 5 per minute | Unchanged. |
| Retained requests in their 10-minute window | 48 (`service.ts:269`) | Own pool for code requests: 256. The 48 pool keeps serving group joins and quick pairing. |
| Directory reads | 4 per person, 32 at once | Unchanged. A burst above 32 gets `busy`. |
| Fleets on a Hub | 256 (`service.ts:405`) | Unchanged. `maxUses` tops out at 200; creating a code warns when `maxUses` exceeds the free fleet rows. |
| Hub sign-in | 5 per login per 5 minutes | Unchanged. |

**Queueing.** `busy` (backpressure or directory pool) on approve is not an error for the person. The Hub tab keeps the request and retries approve up to 8 times with 2–6 s jittered waits inside the outer deadline, showing 「目前很多人同時加入，正在排隊…」. Only after the last retry does it show E11 with a 「再試一次」 button that repeats approve for the same request.

Target for the acceptance leg: 50 Fleets that start within the same 60 seconds are all connected within 5 minutes with no manual retry.

### 2.5 HTTP

All under the Hub web listener, admin session, CSRF, `requireAdmin` plus the configured-administrator check.

| Route | Body | Answer |
|---|---|---|
| `POST /hub/v1/admin/enrolment-codes` | `{ expires: "1h" \| "today" \| "7d", maxUses, perPersonFleets, scope }` | `201 { id, code, expiresAt, maxUses, perPersonFleets, scope }` |
| `GET /hub/v1/admin/enrolment-codes` | — | `{ codes: [{ id, code \| null, state: "live" \| "expired" \| "exhausted" \| "revoked", expiresAt, maxUses, uses, inFlight, perPersonFleets, scope, recent: [{ label, owner: { name, login }, at }] }] }`; `code` is present only while live; `recent` holds the last 50 uses; ended codes are listed for 7 days. |
| `POST /hub/v1/admin/enrolment-codes/:id/revoke` | `{}` | `200` with the updated row; idempotent. |

Fleet: `start` accepts optional `code` and forwards it in the push. `probe` never validates a code.

### 2.6 UI

- Step 3 of the administrator card: 「建立加入碼」 opens a dialog with three choices (有效到, 最多幾台, 誰可以用) and 「每人最多幾台」 under 「更多」. Creating shows the code in large type with the sentence 「在 AgEnD「設定 → Hub」輸入 {host} 和這組碼。」, a counter 「已加入 n / max」, the recent list, 「複製」 and 「立即停用這組碼」. The list refreshes every 5 s while the card is visible.
- Fleet: the same input (1.1). With a code present the probe line reads 「找到「{hubName}」。加入碼會在你登入後檢查。」.
- Messages after AD sign-in: 加入碼已失效或已用完 (`denied` with a code), 你不在這組加入碼允許的範圍 (`denied` from a group-scope permit), plus E10 and E11.
- Mockups: `docs/evidence/hub-ux-review-m2902/mockups/m3-admin-checklist.png`, `m4-enrol-code.png`, `m1-fleet-one-box.png`, `m5-recover.png`, `m2-fleet-connected.png`. They are sketches; where a mockup and this spec differ, this spec wins (no QR code, no member counts, no short `/j/` link).

## 3. PR split

One owner per core: **Ridge** owns the Hub server (`src/hub/**`); **dev-claude2** owns the Fleet Hub settings UI and its Fleet-side endpoints, and the Hub web UI modules. The one exception is noted on B2.

| PR | Owner | Content | Depends on |
|---|---|---|---|
| **S1** Hub enablers for Phase A | Ridge | S1.1 `name` in public join metadata. S1.2 `label`, `source`, `createdAt` in admin overview. S1.3 `ownerLabel`, `hubName` display fields in the redeem response. S1.4 `member.leave` frame and `supersedes` in push with the issuance-time revoke. S1.5 `approve()` answers `offer-pending` instead of `conflict` when the person has another offer or reservation, and the Hub tab receives that reason. | — |
| **S2** Group search | Ridge | `POST /hub/v1/admin/group-policy/search`, filter escaping, limits, referral handling, fake-AD support in the test wire peer. | — |
| **U1** Fleet one input | dev-claude2 | 1.1 complete (input classification, `probe`, label default, messages E1–E14, Hub-tab auto close, connected card), 1.3 Fleet side (`reconnect`, 「移除這個連接」, `member.leave` send). Passes `code` through to `start` when present. Feature-detects S1 fields so it can merge before S1. | — (S1 for full effect) |
| **U2** Administrator card | dev-claude2 | 1.2 complete (three-step card, group search UI, welcome page changes, fleet list), 1.5 Hub side. Leaves a mount point `#hubEnrolmentCodeSlot` in step 3. | S2; S1.2 for labels |
| **U3** Vocabulary | dev-claude2 | 1.4 complete: string sweep in both languages and the banned-term gate. Last, to avoid rebasing U1 and U2. | U1, U2 |
| **B1** Enrolment code server | Ridge | 2.1–2.5: store, key file, push/approve/issue branches, `prepareCodeEnrollment`, buckets and pool, audit, notices v3, routes, metadata feature, component version and rollback note. | S1 (shares `approve()`), merge S1 first |
| **B2** Enrolment code UI | Ridge | New module `src/ui/hub-enrolment-code.js` and strings, mounted in the U2 slot; Hub-tab queueing text and retry (2.4). Ridge does not edit `settings-hub-company-join.js`; the Fleet input's code handling ships in U1. | B1, U2 |

Order: S1 and S2 and U1 in parallel → U2 → B1 → B2 → U3. Each PR carries its own acceptance evidence before review; alpha twins only.

## 4. Acceptance legs

Rig: a `SAFE_RUN` systemd container as in `~/.cache/rh-hubux` (Hub account, member Fleet accounts, `ad.mjs`), real browser in en-US and zh-TW. Never the live fleet, the pilot or a real directory.

**S1**
- S1-L1 An old Fleet build against the new Hub and a new Fleet against an old Hub both still join (fields are optional both ways).
- S1-L2 Member-side remove while online: the Hub row turns revoked within 5 s, audit has `member.left`, the person's count drops.
- S1-L3 Remove while the Hub is stopped, start the Hub, reconnect: the old row is revoked in the same transaction as the new issue (`member.superseded`), exactly one active row remains, the per-person limit of 1 does not block.
- S1-L4 `supersedes` with a wrong credential or another person's fleet: ignored or `denied`, nothing revoked. Mutation: remove the owner check → the test goes red.
- S1-L5 A live quick-pairing offer for the same person: approve answers `offer-pending`; after stopping the offer the same request can be approved.

**S2**
- S2-L1 Prefix search finds `Owners` by `own`, case-insensitively; a query of 1 character is refused.
- S2-L2 `q` = `*)(cn=*` returns no group and the wire peer receives the escaped filter. Mutation: drop the escaping → red.
- S2-L3 21 matching groups → 20 results and `truncated: true`; a directory that returns continuation references still answers.
- S2-L4 A non-admin and a missing CSRF token are refused; 31 searches in a minute are limited.

**U1** (each in zh-TW and EN, with screenshots)
- A-L1 Fresh Fleet: type `hub.example.test:18601` (no scheme), see the Hub name and suggested label, press once, sign in on the Hub, the tab closes or shows the done text, the Fleet card reads connected with owner and label. Counted: 1 Fleet field, 2 presses.
- A-L2 Paste an existing long link: still joins.
- A-L3 Each message E1–E14 is produced by its real condition at least once (E4 with the rig CA removed from the trust store, E7 with a same-host setup, E8 with a re-keyed Hub) and contains no raw key.
- A-L4 Probe leaves no trace: after 5 probes there is no `company-trust` file, no `company-joins` record, no Hub request row.
- A-L5 Reconnect after an admin revoke and after a member-side remove: one press plus the AD sign-in; form values are not asked again.
- A-L6 Reproduce the review's dead-end sequence (join, admin revoke, reconnect, remove, connect again while the person has an open pairing offer): the person sees E13, not E14, and gets through after stopping the offer. Then the same sequence with the browser closed mid-join (the #3644 case): the next start works.
- A-L7 Old browser tab across the upgrade (SKEW): the old page still works or asks for a reload; no raw keys.
- A-L8 A header token, a guest and a cross-site request are refused by `probe` and `reconnect`.

**U2**
- A-L9 A new administrator's first sign-in shows the three-step card and never the 「向管理員索取配對碼」 line.
- A-L10 From an untouched Hub: switch on, search and choose a group, save, copy the sentence. Counted presses and typed fields are reported; target ≤ 6 presses, 1 typed field.
- A-L11 Step 3 is disabled with a reason until 1 and 2 are done; turning the policy off un-ticks step 2.
- A-L12 The fleet list shows the members' labels, active first, revoked collapsed.
- A-L13 Group search unsupported or failing: the DN input still works and the page says why.

**U3**
- A-L14 The banned-term gate passes, and fails when one banned term is put back (shown once).
- A-L15 A screenshot pass of every Hub screen in both languages; a reviewer reads them against the table in 1.4.

**B1 / B2**
- B-L1 Create a code (today, 30, directory): shown once created and again after a reload; a database copy contains neither the code nor a plain hash of it.
- B-L2 A person outside every allowed group joins with the code; they can connect but have no ask or share permission.
- B-L3 Group-scope code: a member joins, a non-member is refused after sign-in with the scope message.
- B-L4 `maxUses` 2 with three Fleets: the third is refused; two concurrent approvals at `uses = max - 1` issue exactly one. Mutation: drop the `uses = ?` CAS → red.
- B-L5 `perPersonFleets` 1: the same person's second Fleet gets E10.
- B-L6 Revoke between approve and issue: no Fleet is issued; revoke after issue leaves the Fleet connected.
- B-L7 Expiry by the clock; 11 wrong codes in a minute trip the throttle and a right code works again the next minute.
- B-L8 Audit holds created, each use with the code id, revoked or ended; the code text appears in no log, notice, URL or audit row (grep the whole Hub home).
- B-L9 A v2-only member link keeps a `source: "code"` notice queued and receives it after upgrading.
- B-L10 Rollback: the previous alpha refuses to start on the new component and comes up after restoring the pre-upgrade backup.
- **B-L11 Mass join, 20.** A code with `maxUses` 20. Five real Fleets (own accounts, own host names) join through the real UI; fifteen more join through a harness that drives the real Fleet-side join client and the real Hub browser step with fifteen directory people. All 20 connected, `uses = 20`, 20 labelled rows on the administrator's list, the 21st refused.
- **B-L12 Mass join, 50.** Same shape with `maxUses` 50 and 50 directory people, all starts inside 60 s. Pass: 50 connected within 5 minutes, no manual retry, the queueing text was shown at least once, no request ended `expired`, Hub RSS and database size recorded. Repeat once with the administrator revoking the code after about 25: no further Fleet is issued and the counter stops.
- B-L13 The whole B-L12 run with group joins happening at the same time: the 48 pool for group joins is not starved by code joins.

Note on the harness: 50 real Fleet services need about 10 GB in one container (about 200 MB each, measured), so B-L11 and B-L12 use real Fleets for the visible path and the join client for the rest. The harness must use the shipped `dist/hub/join` client code, not a re-implementation, and distinct Fleet origins.

## 5. Re-review plan

When U1–U3, S1, S2, B1 and B2 are in an alpha build, I repeat the review before the owner validates on the Mac.

1. Fresh container from that exact build (pack as `publish.yml` does, private registry), plus an upgrade leg from alpha.13 with connected Fleets.
2. Walk all eight journeys again as a first-time administrator and member, in zh-TW and EN, with the same scripts adapted (`~/.cache/rh-hubux/j1–j19.mts`): setup (with Cairn's M-2917 fixes), first sign-in, opening to colleagues, join by address, join by code, share and ask with a real backend answering, revoke, reconnect, remove.
3. Measure against the targets: join 1 Fleet field and 2 presses; reconnect 1 press plus sign-in; administrator opening ≤ 6 presses; no screen shows two words for one concept; no dead end in the sequences of A-L6.
4. Mass join: watch B-L11 and B-L12 run, and do one 20-Fleet run by hand-driven browsers for five of them.
5. Re-rank the friction list. Anything still ranked 1–3 goes back as findings before the Mac.
6. Report to the leader with a go / no-go for the Mac validation and a one-page checklist the owner can follow on the Mac: certificate and host name preconditions, the address to type, what each screen should say.

## 6. Open items

**Decided 2026-11-11 (leader, for the owner):** O1 yes; O2 keep the long link under 進階; O3 the recommended defaults, which the administrator can narrow; O4 Ridge builds S2 and Cairn co-reviews. The table records the questions as they were asked.

| # | Question | Recommendation |
|---|---|---|
| O1 | Reconnect chains a disconnect and a new join behind one press. The disconnect is a confirmed Settings change today. May the signed-in admin's press count as the consent for both, as a9ccee59 does for joining? | Yes. Same actor, same page, and the action only narrows before it re-joins. Without it a chat Fleet gets a General card in the middle of a reconnect. |
| O2 | Remove the long link entirely, or keep it under 進階? | Keep it under 進階. It is the only way to hand a Hub's identity to colleagues outside the connection itself, and keeping it costs one collapsed block. |
| O3 | Defaults for a new code. | 今天結束, 30 台, 公司目錄裡的任何人, 每人 1 台. |
| O4 | S2 touches the directory code that Cairn has worked on (M-2724). | Ridge builds it as the Hub server owner; Cairn reviews it. |
