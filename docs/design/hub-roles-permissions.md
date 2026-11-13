# Hub 自訂角色與權限（設計提案）

狀態：擁有者已決定（2026-11-13，D1–D7 全部照建議）。只有設計，沒有程式。先做第一、二階段，排在 alpha.2 之後。Hub 伺服器的負責人已審閱伺服器模型（2026-11-13，只讀原始碼 `7ae6a667`），六項修正已併入附錄 A 與第 3、4、6、8 節；產品決定沒有變動。
來源：#3743 第 2 項（2026-11-13 的決定）、M-2986 流程板的發現 2 與 3、卡片 M-2990。
對照的原始碼：`release/2.3.5-alpha` @ `8da18b33`。

## 1. 要解決什麼

Hub 現在只有兩種人：

- **管理員**：設定檔裡指定的那一位（`config.administrator`）。`requireAdmin()` 每次都比對這一個人（`src/hub/sessions.ts:68,188-190`）。只能有一位，換人要改密封的設定。
- **其他人**：能做什麼由「群組權限」決定，只有三項：和 Agent 對話、分享 Agent、連接 Fleet（`src/hub/group-policy/model.ts:7`）。

主管想做的事（看團隊誰加入了、核准申請、看用量）沒有任何畫面，也沒有能授予的權限。固定加一個「主管」角色，下一個需求（專案負責人、稽核、第二位管理員）又要再改一次，所以改成**可設定的角色**：角色是一組有名字的權限，指派給個人或 AD 群組。

## 2. 建議的做法（摘要）

1. **權限清單固定、角色可自訂。** 權限由產品定義（共 12 項，見第 3 節）；管理員把它們組成角色。
2. **內建三個角色**：管理員、主管、成員。主管與成員的權限可以調整；管理員不能改、不能刪。
3. **指派 = 對象 × 角色 × 範圍。** 對象是個人或 AD 群組。「團隊」類的權限一定要有範圍，範圍是一個 AD 群組（Hub 沒有自己的組織圖，AD 群組就是團隊）。
4. **不能自己升級。** 「編輯角色」與「Hub 設定」只屬於管理員，不能加到其他角色；能指派角色的人只能指派自己權限以內的角色。
5. **分三階段做**，每一階段都可以單獨上線（第 9 節）。第一階段不增加任何新能力，只把現有的管理員與群組權限搬進角色模型，並允許多位管理員。

畫面示意（zh-TW，設計示意，不是現有畫面）：

- 角色編輯：`docs/evidence/hub-roles-m2990/r1-role-editor.png`
- 主管的「我的團隊」：`docs/evidence/hub-roles-m2990/r2-team-view.png`

## 3. 權限清單

每一項都對應現在已有的能力，或 #3743 決定要做的能力。「現況」欄說明今天是誰能做。

### 自己使用（沒有範圍）

| 權限 | 意思 | 現況 |
|---|---|---|
| 和 Agent 對話 | 可以向別人允許自己提問的 Agent 提問 | 群組權限 `ask_agents` |
| 分享 Agent | 可以把自己 Fleet 的 Agent（之後含 ClassicBot 聊天室，#3743 第 1 項）分享到 Hub | 群組權限 `publish_agents` |
| 連接 Fleet（每人最多 N 台） | 可以用公司帳號連接自己的 Fleet；N 是 1–8 | 群組權限 `pair_fleet` + `maxFleets` |

### 團隊（範圍：一個 AD 群組）

| 權限 | 意思 | 現況 |
|---|---|---|
| 查看團隊名單 | 範圍內每個人：是否登入過、連接了幾台 Fleet、分享了幾個 Agent、最後一次提問或回答的時間。名單要從 AD 讀群組成員，讀不完整時照實標示「名單不完整」 | 沒有。管理員只看得到 Fleet 清單 |
| 查看團隊用量 | 範圍內每個人近 30 天送出的提問次數、收到的提問次數、收到回答的次數，以及最常被問的 Agent。只有次數 | 沒有。擁有者只看得到自己 Agent 的近期提問 |
| 核准連接申請 | 讓範圍內、還沒有連接權限的人連接一台 Fleet | 只有管理員的「個別邀請」 |
| 核准提問申請 | 代替擁有者核准「向某個 Agent 提問」的申請，只限擁有者已交給主管核准的 Agent | 沒有。只有擁有者自己允許 |

### Hub 管理（整個 Hub）

| 權限 | 意思 | 現況 |
|---|---|---|
| 管理已連接的 Fleet | 查看全部 Fleet、撤銷 | 管理員 |
| 管理加入方式 | 公司帳號連接的開關、加入碼（#3706）、個別邀請、手動配對碼 | 管理員 |
| 指派角色 | 把角色指派給個人或 AD 群組、移除指派 | 管理員（今天是「群組權限」頁） |
| 查看稽核紀錄 | 讀 Hub 稽核紀錄的「誰、什麼時候、做了什麼」與安全通知。**讀不到任何對話內容**，管理員也一樣 | 管理員（安全通知）；稽核紀錄沒有畫面 |
| 編輯角色、Hub 設定 | 新增或修改角色的權限；目錄、網址、保留天數 | 管理員。**只屬於「管理員」角色，不能加到其他角色** |

沒有放進清單的：

- **看別人的對話內容。** 不做成權限。問了什麼留在擁有者 Fleet 的聊天裡，Hub 的管理頁今天就看不到，這份提案不改變這一點。
- **花費與額度的數字。** Hub 沒有這些資料：額度留在各自的 Fleet，Hub 只有概略狀態（`src/ui/hub-quota.js:19-21`）。「查看團隊用量」只有次數。要看花費是另一個題目（要 Fleet 回報用量），不在這份提案內。

## 4. 內建角色的預設

| 權限 | 管理員 | 主管 | 成員 |
|---|---|---|---|
| 和 Agent 對話 | ✓ | ✓ | ✓ |
| 分享 Agent | ✓ | ✓ | ✓ |
| 連接 Fleet | ✓（8 台；搬移過來的第一位管理員見第 8 節） | ✓（2 台） | ✓（1 台） |
| 查看團隊名單 | ✓（全部） | ✓（範圍內） | |
| 查看團隊用量 | ✓（全部） | ✓（範圍內） | |
| 核准連接申請 | ✓ | ✓（範圍內） | |
| 核准提問申請 | | 預設關閉，可開 | |
| 管理已連接的 Fleet | ✓ | | |
| 管理加入方式 | ✓ | | |
| 指派角色 | ✓ | | |
| 查看稽核紀錄 | ✓ | | |
| 編輯角色、Hub 設定 | ✓ | 不能有 | 不能有 |

管理員預設沒有「核准提問申請」：誰能問一個 Agent 是擁有者的決定，管理員今天也不能代替擁有者允許。

一個人可以同時有多個角色，權限取聯集；範圍各算各的（在「RD 一部」是主管，不代表看得到「RD 二部」）。現有的「個別禁止」（`denies`）保留，而且優先於任何角色。

## 5. 指派

- **對象**：個人（用姓名搜尋，沿用 #3743 第 3 項的搜尋），或 AD 群組（沿用「讓同仁加入」的群組搜尋）。
- **範圍**：只有含「團隊」權限的角色需要。範圍是一個 AD 群組；「整個 Hub」只有管理員可以選。
- **到期**（選填）：到期後自動失效，適合代理主管。現有的 `HubDeputy` 草稿就是這個形狀（角色、範圍、起訖、指派者，`src/hub/types.ts:177`）。
- **AD 群組成員每次重新查**，和現在的群組權限一樣：查不到（目錄暫時連不上）時，不新增任何權限，也不把「查不到」當成「已移除」。
- **儲存前先顯示影響**：誰會多出權限、誰會失去、哪些分享會暫停。沿用群組權限現有的「先檢查、再用檢查結果的摘要儲存」（`previewDigest`）。

## 6. 誰能改角色、稽核、不能自己升級

### 誰能改

| 動作 | 需要的權限 |
|---|---|
| 新增、修改、刪除角色 | 編輯角色（只有管理員） |
| 指派或移除指派 | 指派角色 |
| 把人加到某個角色對應的 AD 群組 | 不在 Hub 裡：AD 的群組管理者 |

### 防止升級的規則

1. **「編輯角色」「Hub 設定」不能授予。** 只有內建的管理員角色有，自訂角色的編輯畫面上是鎖住的。所以沒有人能做出一個「幾乎是管理員」的角色再指派給自己。
2. **只能指派自己權限以內的角色。** 逐項比對，不是合起來比：每一項權限，指派者自己都要在**同一個範圍**（同一個 AD 群組，或自己是整個 Hub）有這一項，連接 Fleet 的台數也不能超過自己的。在「RD 一部」能看名單、在「RD 二部」能看用量的人，不能把兩項一起指派在「RD 一部」。Hub 無法證明「群組 A 是群組 B 的一部分」，所以不做這種推論。指派的到期日不能晚於指派者自己那一項權限的到期日。
3. **不能改自己的指派。** 新增、移除、延長自己的角色都要另一位有權限的人來做。唯一的例外是第 8 節那一次：第一位管理員替自己開啟對話、分享、連接這三項預設；只限這三項、只限他本人，會留稽核並通知所有管理員。
4. **第一位管理員拿不掉。** 設定檔裡指定的那一位（今天的 `config.administrator`）永遠是管理員，只有在 Hub 主機上才能更換。這是救援用的：就算角色全被改壞，仍有一個人進得來。
5. **一定有一位管理員。** 第 4 點的第一位管理員永遠在，所以其他管理員的指派都可以移除，包括最後一筆。第一位管理員仍然要通過 AD 的帳號檢查（帳號停用就進不來），只是不看群組。
6. **伺服器每次重新判斷。** 權限不放在登入階段裡。每個要求都重新查一次角色與 AD 成員資格，和今天的 `requireAdmin()`、`requirePerson()` 一樣；被移除的人下一個要求就失效。

### 稽核

每一筆都寫進現有的稽核紀錄（`HubAuditRecord`：誰、什麼時候、做了什麼、結果）：

- `role.created`、`role.changed`、`role.deleted`：含變更前後的權限。
- `role.assigned`、`role.unassigned`、`role.assignment-expired`：對象、角色、範圍、指派者。
- `team.read`、`usage.read`：誰看了哪個範圍的名單或用量（比照現有的 `exposure.activity-read`）。
- `join-request.approved` / `.declined`、`ask-request.approved` / `.declined`。
- 被拒絕的嘗試也記（例如想指派超出自己權限的角色）。

另外，**任何 Hub 管理類權限的變更，都會通知當時所有的管理員**（不只是第一位），出現在「通知」頁，要按確認已讀。通知的對象在變更當下一起記錄；之後失去管理員角色的人就讀不到。

規則 1 之外，**五項 Hub 管理類權限全部只能指派給個人**（決定 D2）。伺服器在兩個地方都擋：指派時，以及修改一個已經指派給 AD 群組的角色時。

## 7. 安全上的代價（照實說）

| 改變 | 代價 | 減輕的做法 |
|---|---|---|
| 可以有多位管理員 | 今天只有一個帳號能改 Hub；之後任何一位管理員的 AD 密碼外洩，後果都一樣大。Hub 登入維持只用 AD 密碼（#3743 第 4 項） | 管理員名單出現在通知頁；建議管理員只指派給個人 |
| 角色可以指派給 AD 群組 | 能在 AD 改這個群組成員的人，就能決定誰有這個角色。Hub 的權限邊界延伸到 AD 的群組管理 | 畫面在儲存前明講；**建議含 Hub 管理類權限的角色只能指派給個人**（決定點 D2） |
| 主管看得到團隊名單與用量 | 同仁的加入狀態、活動時間、提問次數，會被主管看到。這是新的可見範圍，今天連管理員都看不到每人的提問次數 | 只有次數、沒有內容；每次查看留稽核；同仁在自己的 Hub 首頁看得到「誰可以看到我的使用情況」 |
| 主管可以核准連接 | 多了一群能讓人連進 Hub 的人。今天只有管理員能發個別邀請 | 只限範圍內的人；對象仍要用自己的 AD 帳號登入、仍受個別禁止限制；每筆核准通知管理員 |
| 主管可以代為核准提問 | 擁有者的同意被代理。做錯的話，等於主管能讓任何人問團隊裡任何 Agent | 預設關閉；只對擁有者自己打開「交給主管核准」的 Agent 生效；擁有者隨時可以撤銷任何一筆 |
| 權限判斷變複雜 | 從「是不是那一個人」變成「角色 × 範圍 × AD 成員」，出錯的面積變大 | 判斷函式是純函式、集中一處、查不到就拒絕；第一階段不增加任何新能力，先把模型做對 |

## 8. 從現在的管理員與成員搬過來

升級時自動做一次，不需要管理員操作。做完的結果和升級前**完全相同**：每個人的每一項權限、每人可連接的台數、群組權限的狀態（從未開啟、已開啟、已暫停）都不變，已暫停的分享也維持暫停。

| 現在 | 搬過去之後 |
|---|---|
| 設定檔的管理員 | 「管理員」角色，指派給這個人，標記為「第一位管理員」，不能移除。**他今天沒有自動的對話、分享、連接權限（要靠群組），搬過去之後也一樣**；要套用管理員角色的新預設（含 8 台），由他自己在角色頁按一次「套用新的預設」，儲存前會顯示影響 |
| 群組權限裡的每一條規則（群組 + 三項權限的組合 + 每人幾台） | 一筆指派：AD 群組 → 角色，**台數記在這一筆指派上**（0–8，原樣保留）。三項全有就是「成員」；只有部分的，各對應一個「沿用」角色，最多 7 種。同一個人符合多筆時，台數取最大值，和今天一樣，不相加。成員 1 台、主管 2 台是之後新指派的預設，不會改動搬過來的數字 |
| 個別禁止 | 原樣保留，優先於角色 |
| 群組權限「從未開啟」的舊 Hub | 維持舊行為（登入的人都能對話，連接要管理員核准），直到管理員開啟「自己使用」這三項的權限設定為止。這和今天第一次儲存群組是同一個動作，儲存前一樣會顯示誰會失去原本的使用權。升級後角色功能本身就是開啟的（可以指派第二位管理員），但不會因此改變任何人的使用權 |
| 個別邀請、加入碼、手動配對碼 | 不變。它們是一次性的核准，不是角色 |
| 擁有者對某人的「允許提問」 | 不變。那是擁有者的授權，不是 Hub 的角色 |

升級後，第一位管理員會在「通知」頁看到一則一次性的通知：「角色與權限」現在可以使用了，而且目前沒有任何人的權限因此改變。這則通知要按確認已讀（決定：2026-11-13，升級後角色功能預設開啟）。

「群組權限」頁改名為「角色與權限」；「讓同仁加入」卡片的步驟 2 不變（它其實就是「把成員角色指派給 AD 群組」的捷徑）。

關閉角色功能是一個**往前的**變更，不是還原：關閉後回到「只有第一位管理員 + 三項群組權限」的行為，但已經做過的禁止、撤銷、暫停都保留。不會把升級前的設定整份蓋回來，因為那樣可能讓已經收回的權限或已撤銷的 Fleet 復活。要退回舊版程式是另一件事（資料庫備份與還原），不在這份提案內。

## 9. 分階段

| 階段 | 內容 | 新增的能力 |
|---|---|---|
| **一、角色模型** | 權限清單、三個內建角色、搬移、角色編輯畫面、指派給個人或 AD 群組、稽核、多位管理員 | 只有「可以有第二位管理員」與「可以把管理工作拆開授予」 |
| **二、主管的團隊檢視** | 團隊範圍、「我的團隊」頁、名單與用量次數 | 查看團隊名單、查看團隊用量 |
| **三、申請與核准** | 同仁申請連接、申請提問；主管或擁有者核准 | 核准連接申請、核准提問申請 |

第三階段有一個前提要先決定：今天「新對話」只列出**已經允許你提問**的 Agent，所以沒有東西可以申請。要讓人申請，擁有者得先選擇把 Agent「列出來讓人申請」（決定點 D4）。

## 10. 擁有者的決定（2026-11-13）

七項都照建議決定。

| # | 問題 | 決定 |
|---|---|---|
| D1 | 權限清單（第 3 節的 12 項）要增減嗎？ | 照清單。不做「看對話內容」，不做花費數字 |
| D2 | 含 Hub 管理類權限的角色，可以指派給 AD 群組嗎？ | 不可以，只能指派給個人。團隊類與自己使用類可以指派給群組 |
| D3 | 管理員以外的人可以編輯角色嗎？ | 不可以（第 6 節規則 1）。之後有需要再開 |
| D4 | 主管可以代替擁有者核准提問嗎？ | 可以，但預設關閉，而且擁有者要逐個 Agent 打開「交給主管核准」 |
| D5 | 同仁要不要看得到「誰可以看我的使用情況」？ | 要。主管看得到的資料，本人應該知道 |
| D6 | 三個階段都做，還是先做到第二階段？ | 先做一、二（排在 alpha.2 之後）。第三階段等 #3743 第 3 項（依群組允許提問）上線後再看還需不需要 |
| D7 | 主管預設可以連接幾台 Fleet？ | 2 台（成員 1 台、管理員 8 台） |

## 附錄 A：Server model

English, for implementation. Nothing here is built. Reviewed by the Hub server owner on 2026-11-13 against source `7ae6a667` (read-only; no tests, builds or directory access). The six required amendments from that review are folded in below; A.8 records the answers to the open questions. Phase 3 (requests and delegated approval) was not cleared by that review and needs its own end-to-end protocol review.

### A.1 Storage

One canonical JSON document (roles + assignments + denies) in the existing Hub SQLite policy transaction, written through today's preview → digest → compare-and-swap path (`src/hub/group-policy/store.ts`, `admin-control.ts:147-187`). Not a second sealed file: a cross-store transaction is unnecessary risk.

```
RolePolicy {
  realm, generation, revision,
  rolesActive: boolean,                               // roles on / off; separate from `state` below
  state: "never-enabled" | "enabled" | "suspended",   // the three existing states, kept: they govern the three self-use permissions only
  everEnabled: boolean,                               // the existing latch: no return to never-enabled
  roles: Role[],             // ≤ 32: 3 built-in + up to 7 "carried-over" + custom
  assignments: Assignment[], // ≤ 256
  denies: Deny[]             // unchanged
}
Role { id, name, kind: "admin" | "manager" | "member" | "carried-over" | "custom", permissions: Permission[], defaultMaxFleets: 0..8 }
Assignment {
  id, roleId,
  subject: { kind: "person", person } | { kind: "group", group, dn },   // group = immutable realm + GUID
  scope:   { kind: "hub" } | { kind: "group", group, dn },
  maxFleets: 0..8 | null,    // per assignment; null = the role's default. Carried-over rules keep their exact number
  startsAt, expiresAt | null, assignedBy, assignedAt
}
Permission = "ask_agents" | "publish_agents" | "pair_fleet"
           | "team.view" | "team.usage" | "team.approve_join" | "team.approve_ask"
           | "fleets.manage" | "join.manage" | "roles.assign" | "audit.view" | "hub.admin"
```

The preview digest binds the proposed document, the existing resource inventory and the directory observations it was computed from, not only two revision numbers.

### A.2 Evaluation

A pure function with the contract of `evaluateGroupPolicy` (`model.ts:35`): unknown directory facts never become an allow and never an authoritative removal; a person-level deny wins; overlapping fleet limits combine by MAX, never SUM.

```
can(policy, subject, permission, target | null, facts, now)
  → { outcome: allow | deny | unknown, authoritative, via: assignmentIds[], maxFleets, nextExpiry }
```

- `never-enabled` keeps its distinct `legacy` outcome and source in the self-use evaluator, for `pair_fleet` too, with today's behaviour at each legacy call site. It is never collapsed into `allow`: that could turn manual pairing into automatic pairing.
- `now` is an input: an assignment expires without a document revision, so the result carries `nextExpiry` and expiry is settled idempotently (audit `role.assignment-expired`).
- Scope constrains team permissions only. The three self-use permissions of a role are unscoped: they apply to the subject itself, whatever scope the assignment carries (a manager scoped to one AD group still chats, shares and connects as themself).
- Hub-management permissions need a `scope.kind === "hub"` assignment. Team permissions need a target person: with a hub-wide assignment the target may be any currently eligible person (fresh eligibility); with a group scope the target needs a fresh membership read in that scope group.
- The configured root administrator evaluates as admin without a group read. It still passes today's session and person-eligibility checks: break-glass skips group membership, not disabled-person validation.
- Existing owner ask grants stay an independent AND gate. Team, usage and audit permissions confer no right to ask.

### A.3 Authorization is an operation permit

Not a route rename. Each protected operation captures: actor and session, the exact permission with its target and scope, policy revision and generation, the authorization epoch, the directory facts used, and the time. It rechecks after any I/O and immediately before the effect or disclosure.

- Role loss invalidates in-flight operations, member leases and protected SSE emissions, including notice streams that are already open. `isCurrent` on the session checks the cookie only and is not role authority.
- Inventory to convert, beyond `requireAdmin()`: `group-policy/admin-context.ts:31`, `group-policy/authorization.ts:116` and its manual-enrolment path (`:285`), the code and invitation controls in `join/service.ts`, `session-directory-transition.ts:36,57,102`, `settings-commit.ts:329`.
- The actual approver's identity is kept. Never rewrite `approvedBy` to the root to satisfy an old proof.
- Codes and invitations issued by someone who later loses `join.manage`: the issuer's current permission is proved **before first issuance** of each admission, so no new Fleet is admitted after the role is lost; the code or invitation is listed as "issuer no longer permitted" until an admin revokes or re-issues it. What is already committed is not touched: `redeem()`'s re-delivery of an already committed, exact key / owner / credential-bound result still succeeds, and Fleets already joined through that code keep their provenance and stay connected until someone revokes them explicitly, exactly as code expiry and code revocation behave today. No issued Fleet is silently turned into released capacity.
- Admin actions the twelve permissions do not name stay with `hub.admin` until one is mapped explicitly: fleet / exposure / asker freeze and explicit Resume, person denies, policy-wide state switches, and the roles on / off control. No residual action reaches a custom operator role by default.
- Directory Save by an admin other than the root: that acting admin proves (re-authenticates) their own identity and must be eligible in the candidate directory; the candidate-directory eligibility proof for the configured root is still required, so the break-glass account survives the change. The recorded actor is the acting admin, never rewritten to the root.
- The final synchronous and audit-required fences of the current code stay as they are.

### A.4 Invariants (each needs a test)

1. `hub.admin` exists only in the built-in admin role; the writer refuses it elsewhere.
2. All five Hub-management permissions (`fleets.manage`, `join.manage`, `roles.assign`, `audit.view`, `hub.admin`) are persons-only. The writer checks this when assigning, and when editing a role that group assignments already reference.
3. Delegation authority is the actor's **held bundle**, not the result of `can()`. The bundle is what the actor's live assignments carry after the fresh checks (actor eligibility, group membership, assignment time window). The self-use `state` does not enter it: on a never-enabled or suspended Hub an admin can still assign the member role.
   - **Holders of `hub.admin`**, the configured root included through its immutable virtual admin bundle, may assign any role to **other** people, with any scope and any fleet limit up to 8. The root's bundle is for delegating to others only; it never implies self-use for the root (A.5).
   - **Other holders of `roles.assign`** are bounded per permission, never on flattened unions: they must hold that permission on the identical scope (same realm + GUID) or hub-wide; `maxFleets` granted ≤ theirs; `expiresAt` granted ≤ the expiry of their own authority for that permission; no subset inference between groups. A person-level deny on the actor removes that permission from their bundle.
   - Self-target guards (item 4) apply to everyone, admins included.
   - Editing a role is a grant to every current assignee of that role. It needs `hub.admin`, goes through the same preview (who gains what), re-runs the persons-only check (item 2), and is refused when it would add a permission to the editing actor through any assignment they hold.
   - `team.approve_join` and `team.approve_ask` belong to phase 3. Until that phase and its protocol review land, the writer refuses both bits in any role, so there is no first-introduction path to reason about.
4. No self-increase: an actor cannot create, extend or widen an assignment naming themself, nor a group assignment that would add permissions to themself. Unknown self-membership refuses the write. One named exception, not a general bypass: the configured root may activate the three self-use defaults for itself (A.5), once, through its own operation with its own audit action and admin notice; no other permission, scope or subject can pass through it.
5. The root administrator is counted as an effective admin. Any auxiliary admin assignment may be removed, including the last one.
6. Every write and every refused write produces one audit record in the same transaction (audit unavailable → refuse).

### A.5 Migration and switching off

One atomic, idempotent cutover: a single marker plus, in the same commit, the matching old snapshot, the role policy, the resource / provenance / pending-join consequences, the audit record and the authorization revision; links refresh after. Independent durable rollback floors and fail-closed recovery are preserved. Crash points to pin: before and after commit, floor and audit; repeated migration.

Losslessness, tested on a matrix of all three old states × overlapping rules × zero quota × denies × manual, code and invitation grants. The assertions cover decisions and quota and provenance:

- each group rule → one assignment to the role with that capability set, its `maxFleets` on the assignment;
- `suspended`, the ever-enabled latch, retained resource state and explicit Resume are carried unchanged;
- the configured administrator → root admin, with **no** self-use permissions added (today it has no automatic ask / publish / pair exception). In `can()` the root's management permissions are evaluated separately from the self-use bits: a blanket "built-in admin has everything" evaluation would re-add them by accident and is not allowed. The D7 defaults (member 1, manager 2, admin 8) apply to assignments made after migration. The root gets them only through the configured-root-only activation named in A.4.4 (`role.root-self-use-activated`, previewed, audited, notified), or when another admin assigns them.

State table. `rolesActive` and `state` are independent: no transition of one changes the other, and neither touches the ever-enabled latch.

| `rolesActive` | `state` | Management | Self-use |
|---|---|---|---|
| true | never-enabled | by roles | `legacy`, as today. Self-use bits on assignments are stored but not evaluated, and the editor says so |
| true | enabled | by roles | by assignments, denies win |
| true | suspended | by roles | denied (suspended), as today |
| false | any | configured root only | as the row above for that `state`, by forward projection |

Automatic migration sets `rolesActive = true` and leaves `state` exactly as it was. `never-enabled → enabled` stays its own previewed, audited self-use activation (today's first group save), whose preview shows the loss of legacy access. Turning roles on or off never performs it. The cutover commit also records one acknowledgeable notice for the configured root: roles are now available and nobody's access has changed. It is written once, by the migration marker, and not again on later off / on.

Switching roles off is a new monotone transition, not a snapshot restore. It flips `rolesActive` and never touches `state`: `suspended` keeps its one meaning (the self-use policy is suspended) and the ever-enabled latch is untouched, so off is not encoded as a suspension. With roles off, management returns to the configured root only, and team and Hub-management permissions confer nothing (their assignments stay stored, inert). The self-use rules keep working by forward projection of the current document: each assignment's three self-use permissions and its fleet limit, plus current denies, revocations and suspensions. Restoring a saved pre-migration snapshot could resurrect removed permissions or revoked resources, so it is not offered. Turning roles back on is a reactivation of the current document, not a restore: a previewed, audited new policy and authorization revision that re-reads the current time and subject / target facts, keeps every assignment revoked, removed or expired in the meantime and every resource suspension, and never revives old permits, leases or SSE streams. A binary downgrade is a separate schema and backup operation. Crash points and repeated disable are pinned like the migration.

### A.6 Phase 2 reads

Disclosure boundary: authorize the requested scope first; then apply a fresh target-membership check to every returned row or page. Unknown membership neither leaks a roster nor counts as removal; the page is labelled incomplete.

- **Member list.** Needs new work: a bounded group-member reader (immutable group binding, stated direct / nested semantics, LDAP paging and ranged `member`, size and time limits, referrals refused, incomplete → unknown). Today's `resolve` (2) and suggestion (20) limits are not a member enumeration API. If the first delivery lists only people known to the Hub, the page must say it does not include people who never signed in.
- **Directory cost.** The policy reader admits 4 per person and 32 in total, and person eligibility has its own 4 / 32; each call opens, binds, searches and closes. Batch and bound the reads; no per-row unbounded LDAP fan-out. A cached positive group fact used to disclose a roster is authority and must be fresh; only already-authorized snapshots may be cached for presentation.
- **Usage counts.** `hub_messages` rows are not purged by the retention timer today (it purges audit content, events and attachments: `compose/server.ts:517-527`), so the window cannot be "min(30, content retention)". Phase 2 defines its own bounded metadata window and retention for these rows. Counts are defined on recorded events: questions accepted in the window, and answers accepted in the window (`stage_at` is mutable and a stage can change after answering, so `stage == answered` is not a historical counter). Deduplicate by room and idempotency identity; attribute by the recorded asker and owner; index by owner / asker / time; never read question or answer payloads.
- **Last activity** = the person's last accepted question or answer. `hub_people.last_checked_at` is a directory verification time, not activity.
- **"Who can see my usage"** (D5) is computed from the same permission and scope rules, and labels unknown or incomplete membership as such.

### A.7 Audit and notices

- `audit.view` is metadata only and gets its own read path. It is not mapped onto the existing auditor flag, because that flag also authorizes `readContent()` (`audit/index.ts:344-348`). Negative tests: no conversation payload for any role, admin included.
- Role-management notices go to every effective admin at the time of the change, not only owner + configured administrator as the pairing notices do today. Recipients are recorded transactionally with the change; reads re-check current authority; removal or expiry of the role ends access to the notice.

### A.8 Answers from the server review

- **Q1 storage.** One canonical document in the existing SQL / CAS transaction; expiry against an injected clock (A.1, A.2).
- **Q2 directory cost.** Bounded admission as in A.6; no relaxed freshness for anything that discloses.
- **Q3 member listing.** A bounded member reader is feasible new work; a Hub-known-only list is a valid, explicitly partial first delivery (A.6).
- **Q4 join codes.** `join.manage` covers create, list (including the sealed-code reveal), revoke and invitations. The issuer's current permission gates first issuance only; committed results and joined Fleets follow the existing provenance and explicit-revocation rules, with the recorded approver kept (A.3).
- **Q5 member link.** Phases 1 and 2 stay server-side on the existing authorization epochs, leases and link refresh; no role names cross the member link.
