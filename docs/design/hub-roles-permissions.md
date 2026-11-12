# Hub 自訂角色與權限（設計提案）

狀態：擁有者已決定（2026-11-13，D1–D7 全部照建議）。只有設計，沒有程式。先做第一、二階段，排在 alpha.2 之後；伺服器模型（附錄 A）等 B2（#3706）合併後由 Hub 伺服器的負責人審閱。
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
| 查看團隊名單 | 範圍內每個人：是否登入過、連接了幾台 Fleet、分享了幾個 Agent、最後活動時間 | 沒有。管理員只看得到 Fleet 清單 |
| 查看團隊用量 | 範圍內每個人近 30 天提問、被問、已回答的次數，以及最常被問的 Agent | 沒有。擁有者只看得到自己 Agent 的近期提問 |
| 核准連接申請 | 讓範圍內、還沒有連接權限的人連接一台 Fleet | 只有管理員的「個別邀請」 |
| 核准提問申請 | 代替擁有者核准「向某個 Agent 提問」的申請，只限擁有者已交給主管核准的 Agent | 沒有。只有擁有者自己允許 |

### Hub 管理（整個 Hub）

| 權限 | 意思 | 現況 |
|---|---|---|
| 管理已連接的 Fleet | 查看全部 Fleet、撤銷 | 管理員 |
| 管理加入方式 | 公司帳號連接的開關、加入碼（#3706）、個別邀請、手動配對碼 | 管理員 |
| 指派角色 | 把角色指派給個人或 AD 群組、移除指派 | 管理員（今天是「群組權限」頁） |
| 查看稽核紀錄 | 讀 Hub 的稽核紀錄與安全通知 | 管理員（安全通知）；稽核紀錄沒有畫面 |
| 編輯角色、Hub 設定 | 新增或修改角色的權限；目錄、網址、保留天數 | 管理員。**只屬於「管理員」角色，不能加到其他角色** |

沒有放進清單的：

- **看別人的對話內容。** 不做成權限。問了什麼留在擁有者 Fleet 的聊天裡，Hub 的管理頁今天就看不到，這份提案不改變這一點。
- **花費與額度的數字。** Hub 沒有這些資料：額度留在各自的 Fleet，Hub 只有概略狀態（`src/ui/hub-quota.js:19-21`）。「查看團隊用量」只有次數。要看花費是另一個題目（要 Fleet 回報用量），不在這份提案內。

## 4. 內建角色的預設

| 權限 | 管理員 | 主管 | 成員 |
|---|---|---|---|
| 和 Agent 對話 | ✓ | ✓ | ✓ |
| 分享 Agent | ✓ | ✓ | ✓ |
| 連接 Fleet | ✓（8 台） | ✓（2 台） | ✓（1 台） |
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
2. **只能指派自己權限以內的角色。** 有「指派角色」的人，能指派的角色必須是自己目前所有權限的子集，範圍也必須在自己的範圍之內。管理員不受限。
3. **不能改自己的指派。** 新增、移除、延長自己的角色都要另一位有權限的人來做。
4. **第一位管理員拿不掉。** 設定檔裡指定的那一位（今天的 `config.administrator`）永遠是管理員，只有在 Hub 主機上才能更換。這是救援用的：就算角色全被改壞，仍有一個人進得來。
5. **至少一位管理員。** 移除最後一位管理員的指派會被拒絕（第 4 點已經保證，這是畫面上的說明）。
6. **伺服器每次重新判斷。** 權限不放在登入階段裡。每個要求都重新查一次角色與 AD 成員資格，和今天的 `requireAdmin()`、`requirePerson()` 一樣；被移除的人下一個要求就失效。

### 稽核

每一筆都寫進現有的稽核紀錄（`HubAuditRecord`：誰、什麼時候、做了什麼、結果）：

- `role.created`、`role.changed`、`role.deleted`：含變更前後的權限。
- `role.assigned`、`role.unassigned`、`role.assignment-expired`：對象、角色、範圍、指派者。
- `team.read`、`usage.read`：誰看了哪個範圍的名單或用量（比照現有的 `exposure.activity-read`）。
- `join-request.approved` / `.declined`、`ask-request.approved` / `.declined`。
- 被拒絕的嘗試也記（例如想指派超出自己權限的角色）。

另外，**任何 Hub 管理類權限的變更，都會出現在所有管理員的「通知」頁**，和今天「有新的 Fleet 連接」一樣要按確認已讀。

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

升級時自動做一次，不需要管理員操作，做完的結果和升級前的權限**完全相同**：

| 現在 | 搬過去之後 |
|---|---|
| 設定檔的管理員 | 「管理員」角色，指派給這個人，標記為「第一位管理員」，不能移除 |
| 群組權限裡的每一條規則（群組 + 三項權限的組合 + 每人幾台） | 指派：AD 群組 → 對應的角色。三項全有就是「成員」；只有部分的，各產生一個自訂角色（例如「成員（只能對話）」），最多 7 種 |
| 個別禁止 | 原樣保留，優先於角色 |
| 群組權限「從未開啟」的舊 Hub | 維持舊行為（登入的人都能對話，連接要管理員核准），直到管理員第一次開啟角色 |
| 個別邀請、加入碼、手動配對碼 | 不變。它們是一次性的核准，不是角色 |
| 擁有者對某人的「允許提問」 | 不變。那是擁有者的授權，不是 Hub 的角色 |

「群組權限」頁改名為「角色與權限」；「讓同仁加入」卡片的步驟 2 不變（它其實就是「把成員角色指派給 AD 群組」的捷徑）。

可以退回：搬移前的設定保留一份，角色功能有開關；關掉就回到今天的行為。

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

## 附錄 A：Server model (for the Hub server owner's review)

English, for implementation review. Nothing here is built.

### A.1 Document

One sealed, revisioned document next to today's group policy, written through the same preview → digest → compare-and-swap path (`src/hub/group-policy/store.ts`, `admin-control.ts`):

```
RolePolicy {
  realm, generation, revision,
  state: "legacy" | "enabled",
  roles: Role[]            // ≤ 16
  assignments: Assignment[] // ≤ 256
  denies: Deny[]           // unchanged from HubGroupPolicy
}
Role { id, name, builtin: "admin" | "manager" | "member" | null, permissions: Permission[], maxFleets: 0..8 }
Assignment {
  id, roleId,
  subject: { kind: "person", person } | { kind: "group", group, dn },
  scope:   { kind: "hub" } | { kind: "group", group, dn },
  startsAt, expiresAt | null, assignedBy, assignedAt
}
Permission = "ask_agents" | "publish_agents" | "pair_fleet"
           | "team.view" | "team.usage" | "team.approve_join" | "team.approve_ask"
           | "fleets.manage" | "join.manage" | "roles.assign" | "audit.view"
           | "hub.admin"            // edit roles + Hub settings; builtin admin only
```

The three existing capability names are kept so `evaluateGroupPolicy` callers (`authorization.ts`, `resources.ts`, `welcome.ts`) keep their meaning.

### A.2 Evaluation

A pure function, same contract as `evaluateGroupPolicy` (`model.ts:35`): unknown directory facts never become an allow and never an authoritative removal; a person-level deny wins.

```
can(policy, subject, permission, target?, facts) → { outcome: allow | deny | unknown, authoritative, via: assignmentIds[], maxFleets }
```

- Subject matches an assignment when it names the person, or names a group in `facts.groups`.
- Hub-scoped permissions need a `scope.kind === "hub"` assignment.
- Team permissions need `target` (a person): allowed when some matching assignment's scope group contains the target, by a fresh membership read of the target. This is a second directory read per request; see question Q2.
- `requireAdmin()` becomes `require("hub.admin")`, and each admin route moves to the narrowest permission (`fleets.manage`, `join.manage`, `roles.assign`, `audit.view`). The sealed `config.administrator` always evaluates as admin without a directory group read (break-glass).

### A.3 Invariants (each needs a test)

1. A role other than builtin admin can never contain `hub.admin`; the writer refuses it, not only the UI.
2. `roles.assign` holder: the assigned role's permission set ⊆ the actor's effective set, and the assignment's scope ⊆ one of the actor's scopes. Checked in the write transaction against the same revision the preview used.
3. An actor cannot create, remove or extend an assignment whose subject is the actor (person subjects), nor one whose group subject the actor is currently a member of when it would add permissions to the actor.
4. Removing the last hub-scoped admin assignment is refused; the sealed administrator is not an assignment and cannot be removed here.
5. Migration is exact: for every (person, capability) the decision before equals the decision after, on a fixture matrix of rules × denies × states.
6. Every write, and every refused write, produces one audit record in the same transaction (the existing `audit` unavailable → refuse rule).

### A.4 New reads (phase 2)

- `GET /hub/v1/team?scope=<group>`: members of the scope group from the directory, joined with `hub_people` (signed in), fleets (count by owner), exposures (count by owner), and last activity. Paged; needs a group member listing the directory layer does not expose today (it resolves a person's groups, not a group's members).
- `GET /hub/v1/team/usage?scope=<group>&days=30`: counts from `hub_messages` grouped by `asker` and by `owner` (`stage` answered vs not). Bounded by content retention: with a short `contentDays`, older rows are gone, so the window is `min(30, retention)`.

### A.5 Questions for the server owner

- Q1. One document (roles + assignments) or roles sealed and assignments in tables? Assignments change far more often than roles; a table makes expiry and paging simple, but then the preview digest must cover both.
- Q2. Cost of fresh group facts on every admin-class request, and of the per-target membership read for team permissions. Is a short, non-authoritative cache acceptable for reads (`team.view`) while writes stay fresh?
- Q3. Listing a group's members: is a bounded LDAP member read acceptable (size limit, paging, nested groups not expanded), or should phase 2 only show people who have signed in to the Hub?
- Q4. B1/B2 join codes are "configured admin only". Under roles, is `join.manage` enough to create a code, or should creation stay with `hub.admin`?
- Q5. Does anything on the member link (the Fleet side) need to learn about roles, or does it stay server-only as today?
