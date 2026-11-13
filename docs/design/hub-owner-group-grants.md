# 擁有者的個人與 AD 群組提問授權

M-3016／#3743 第3項的實作說明。權限決定已核准；不是新增角色權限。ClassicBot 房間分享（M-3014）沿用同一模型，不另建授權資料表或遷移。

擁有者在原本的「允許提問」對話框裡選同仁或 AD 安全性群組。同仁可用姓名或帳號的開頭搜尋；群組沿用「讓同仁加入」的搜尋元件，但走擁有者自己的端點，不取得管理員權限。

- 新授權可選1、7、30、90天，預設7天；伺服器也以90天為上限。既有較長的授權保留原到期日、ID和版本，不縮短、不重新建立，仍可讀取與撤銷（擁有者2026-11-13的決定）。
- 群組綁定目錄領域與不可變的 GUID，不用名稱或 DN 辨識。搜尋結果只是建議；儲存時重新解析並比對 GUID。
- 每次操作重新查直接成員，不含巢狀或主要群組。群組管理者能改變誰可提問，因此儲存前會明說。加入或離開群組在下一次檢查生效；每個人的對話與歷史仍各自獨立。
- 同一個 Agent 同時被個人及群組授權涵蓋時，目錄只顯示一次；優先沿用仍有權限的既有對話，否則使用到期較晚的有效授權。不合併歷史，也不把舊對話換綁到另一個授權。
- 到期、擁有者撤銷或分享版本變更不會復活舊授權。撤銷會結束該授權下的所有對話存取。目錄不明不當成移除，也不改寫授權。
- 群組授權只是擁有者同意的一半；Hub既有的提問、分享及連接權限仍須通過。團隊範圍、用量、稽核權限不會附帶提問權，也不啟用尚未掛載的角色輔助程式。依角色設計`9e0006256`的A.2／A.3執行；`team.approve_ask`仍屬後續階段。

## Shared server contract

`HubGrant.subject` is `{kind:"person", person:PersonKey}` or `{kind:"group", group:PersonKey}`. `objectId` follows the existing AD GUID convention. `subjectLabel` is presentation only. Both subjects bind one exact exposure revision and its owner.

The registered `s3-grant-subjects` migration adds `subject_kind` (default `person`) and `subject_label` to `hub_grants`. Existing personal identity bytes and recorded windows stay intact. Subject kind participates in replacement matching. The migration registry makes an older binary refuse the newer schema; rollback needs the matching pre-upgrade database backup, rather than running old readers over group rows.

`HubCore.grantAccess(ids, asker, context)` captures one operation's exact grants and asker. Group subjects use one fresh `readPolicyGroups` observation for that asker, shared only within this operation, through the selected `HubGroupPolicyStore.withDirectoryRead`. Facts must match the immutable person and their own read interval. Physical4/person32total ownership continues through close. Unknown/partial facts refuse as unavailable; no member enumeration or positive session cache is introduced.

The returned proof has a finite `expiresAt`, at most five seconds from the observation and never beyond a matching grant's recorded expiry. `allows(grant, asker)` binds the exact captured row; final `assertCurrent()` rechecks used rows, windows, server/directory/authorization epochs and the caller. Clock rollback or expiry refuses. It is not an ambient permission.

`HubCore.exposureGrant(exposureId, grantId, asker, context)` combines this with existing operational group permits and the exact grant-to-exposure/owner binding. HTTP contexts use their real cookie session. Durable member phases derive the asker/grant/exposure from the persisted message and the current member link/operation; closing the browser does not cancel an already accepted question. The same proof flows through catalog, rooms, history/files, buttons/poll continuations, dispatch, per-phase authorization, answer release and quota projection.

Impact previews evaluate group candidates against fresh facts for known Hub people only. Unknown membership remains held/unknown, rather than manufacturing `hasAskGrant:false` or enumerating arbitrary directory members. Owner grants remain an independent AND gate with future role scopes.

## Suggestions

`POST /hub/v1/exposures/:id/grant-subjects/search` takes `{exposureRevision, kind:"person"|"group", q}`. It requires the real session, CSRF, same origin and the exact owned published exposure before any directory call, and repeats the fences after the read and final authentication.

Queries use2–64 characters, literal LDAP prefix escaping, at most20 results, a5-second physical search deadline, no referral following, shared physical admission and30 searches per actor/session/minute. People return only immutable key, login and display name; groups return the existing GUID/name/DN feedback shape. A grant commit rechecks the selected immutable identity independently.

## Client and SKEW

The new picker loads only with both the server's `grant-subjects-v1` mark and the client's `grantSubjectsV1`/search method. Otherwise the old exact-login dialog remains. The lazy picker registers its own EN/zh-TW words and imports only existing shared components. Search aborts on replacement/unmount and has a finite client wait; it does not replay a grant. Final browser/retained-asset evidence belongs with the PR, not this implementation draft.
