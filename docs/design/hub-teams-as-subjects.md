# Hub teams wherever an AD group can be named (M-3191)

Status: spec for the owner's decision. Nothing is built. "Today" means a source survey of `release/2.3.5-alpha` at
`27b57d5cd`; nothing was run.

## 0. The need, and the short answer

Real product-line teams are not AD groups: AD stops at departments, and a product line takes people from several.
So a Hub team, a list people keep themselves, must be usable wherever an AD group can be named: who may use the
Hub's abilities, who may ask an agent, who may share.

**Teams are already halfway there.** A team can be named today for "who may ask" an agent and for "who can start
rooms". It cannot be named in the administrator's allowed list (chat with agents, share agents, connect a Fleet),
in a join code, or in roles. And only the administrator can create a team, with a single lead. This spec closes
those gaps and defines what leaving a team does.

## 1. Today

### 1.1 Teams

| | Today |
|---|---|
| What a team is | A name, one lead, and a hand-picked list of people (up to 200; up to 200 teams). Nothing is taken from AD |
| Who creates, renames, deletes, sets the lead | The administrator only |
| Who edits the list | The lead (and the administrator) |
| Leads | Exactly one. A lead cannot name another |
| "Department" | Every team must name one AD group as its department. It is only a label; it adds nobody |
| Who can be added | Anyone in the company directory with an enabled account, even before their first sign-in. Checked when added, not again later |
| A member whose account is disabled | Stays on the list. A disabled lead shows a warning |
| Switch | None of its own. Teams are on whenever the Hub is |

### 1.2 Where a subject can be named, and whether a team works there

| Place | AD group | Team | When a removal takes effect |
|---|---|---|---|
| Sign-in to the Hub | No: the directory sign-in filter only | No | Filter or disabled account: at the next request |
| Allowed list: chat with agents, share agents, connect a Fleet, Fleets per person | Yes | **No** | Group: at the person's next action. Nothing is disconnected ahead of time |
| Join code scope | Yes | **No** | Never: checked only when the code is used |
| Individual invitation | A named person | n/a | Never re-checked against any group |
| Who may ask a shared agent | Yes | **Yes** | At the next question |
| Who can start rooms | No | **Yes** | At the next attempt |
| Adding people to a room | Yes, as a one-time copy | Yes, as a one-time copy | Never: it is a copy |
| Roles (merged, switched off) | Yes | **No** | n/a |

### 1.3 The removal finding, stated precisely

My M-3188 note said a person removed from the allowed AD group keeps access. From the code, precisely:

- **Sign-in never looks at the allowed list.** Anyone the directory filter matches, with an enabled account, can
  sign in, see rooms they are in, and message people.
- The allowed list governs three abilities, and those are checked at each use. So removal from an allowed group
  **does** stop chatting with agents, sharing and connecting, at the person's next action.
- What it does **not** do: end their session, remove them from rooms or teams, take back room-creation rights, or
  disconnect anything ahead of time. And a Fleet that came in by **join code or invitation is never re-checked**
  against any group.

So the gap is not one bug. It is that "allowed" is checked in some places and not others, and only when the
person next acts.

## 2. Design

### 2.1 One rule: a team can be named wherever a group can

| Place | Change |
|---|---|
| Allowed list (chat with agents, share agents, connect a Fleet, Fleets per person) | **New.** A row can be an AD group, a team, or a person |
| Join code scope | **New.** "Anyone in the company", an AD group, or a team |
| Who may ask a shared agent | Exists |
| Who can start rooms | Exists |
| Roles: who holds a role, and over whom | **New, with the roles re-scope.** "Manager of team X" is the natural scope |
| Later features with a people list (Hub General "who can use it", the MCP switch, announcements) | Use the same picker from the start |

Rules that keep it simple:

- **Same picker everywhere**: An AD group / A team / A person.
- **Combining.** A person gets the union of what their groups and teams allow; the highest Fleet limit applies.
  A person exclusion still wins over everything, as today.
- **No extra AD reads.** Team membership is the Hub's own list, so a team check is instant.
- **Sign-in stays with AD.** A team never lets someone sign in who is not in the company directory with an
  enabled account. Company identity is unchanged.

### 2.2 Who manages a team

The owner's direction: managers manage their own teams.

| | Proposal |
|---|---|
| Who can create a team | Chosen by the administrator: **Administrators only** (default), or named people and AD groups (for example the managers' group). The creator becomes its first lead |
| Leads | One to five. Any lead can add or remove members, add or remove another lead, rename the team, and delete it. The last lead cannot leave without naming another |
| Administrator | Can do all of this for any team, and sees every team |
| Department | Optional, and still only a label. A product line that spans departments leaves it empty |
| Members | Unchanged: anyone in the company directory with an enabled account, up to 200 |
| Seeing a team | Any signed-in person can see a team's name and leads. Only its leads, its members and administrators see the list |

**What this hands to a lead, plainly.** Adding someone to a team gives them everything that team was given: the
agents the team may ask, and, if the administrator put the team on the allowed list, sharing and connecting a
Fleet. A lead therefore admits people to those abilities without the administrator. What limits it: members
must be company people; every roster change is recorded with who made it; the allowed list shows each team's
size and leads; and the administrator can remove a team from the list at once.

### 2.3 Leaving a team

Because the Hub owns the list, it can act at once, which AD groups cannot offer.

**When a person is removed from a team (or the team is deleted), the Hub re-checks that person immediately:**

| What they had through the team | What happens |
|---|---|
| Asking agents shared with the team | Stops now. Questions already delivered are still answered |
| Chat with agents, share agents (allowed list) | Stops now, unless another group, team or their own row still allows it. Their shares show "Paused: no longer allowed" to them and to the administrator |
| A connected Fleet (allowed list, or a team join code) | Disconnected now, unless something else still allows it. It reconnects by itself if they are allowed again within 30 days |
| Starting rooms | Stops now |
| Rooms they were added to with the team | **They stay**, because rooms copy the list. The person removing them is shown those rooms and can remove them there too in the same step |
| Their past messages and files | Stay |

**Offboarding (the AD account is disabled).** A disabled person stays on the list for the grace period in M-3188
item 4, shown as "Account disabled" and not counted, and has no access meanwhile (sign-in already refuses). After
the grace period they are removed from every team. If they were a lead: the other leads carry on; if they were
the only lead, the longest-standing member becomes lead and the administrator is told.

**A team with nobody left** keeps its name and what it was given, shows "No members", and the administrator is
told. Nothing is deleted silently.

### 2.4 Closing the removal gap for groups and teams

Three changes, which apply equally to AD groups and teams:

1. **Act on removal, not on the next action.** For teams, at once (2.3). For AD groups, a check of each
   connected person every hour and at each sign-in: someone no longer allowed has their Fleets disconnected and
   shares paused then, not whenever they next try.
2. **Re-check join codes.** A Fleet that came in by a code scoped to a group or team keeps that scope and is
   re-checked like any other. A code for "anyone in the company" and an individual invitation stay as they are:
   the administrator named them on purpose.
3. **An optional stricter Hub.** A new administrator choice, off by default:

   | | EN | zh-TW |
   |---|---|---|
   | Setting | Who can use this Hub | 誰可以使用這個 Hub |
   | Default | Everyone in the company directory | 公司目錄裡的所有人 |
   | Stricter | Only the groups, teams and people on the allowed list | 只有允許清單上的群組、團隊與人員 |

   With the stricter choice, being on the allowed list is checked on every request, like the disabled-account
   check. A person who leaves every allowed group and team is signed out and cannot sign in.

What this costs:

- **The hourly AD check is load on the directory**: one lookup per connected person per hour. On a large Hub it
  should be spread across the hour.
- **The stricter choice can lock people out by mistake**: delete a team that was the only thing allowing twenty
  people and they are signed out. The delete step must say so before it happens (2.5).
- **A lead's mistake is immediate.** Removing the wrong person disconnects their Fleet at once. The 30-day
  automatic reconnect is the safety net.

### 2.5 Copy

Allowed list (Administration → Manage → Company sign-in joining):

| | EN | zh-TW |
|---|---|---|
| Add button | Add a group, team or person | 新增群組、團隊或人員 |
| Picker tabs | AD group · Team · Person | AD 群組 · 團隊 · 人員 |
| Team row | {team} · Team · {n} members · Lead: {name} | {team} · 團隊 · {n} 位成員 · 負責人：{name} |
| Team row hint | Its leads decide who is on this team. | 團隊成員由負責人決定。 |
| Abilities (existing) | Chat with agents · Share agents · Connect a Fleet | 和 Agent 對話 · 分享 Agent · 連接 Fleet |

Teams:

| | EN | zh-TW |
|---|---|---|
| Setting | Who can create teams | 誰可以建立團隊 |
| Choices | Administrators only · Administrators and these people or groups | 只有管理員 · 管理員和這些人員或群組 |
| Leads | Leads (up to 5) | 負責人（最多 5 位） |
| Add a lead | Make {name} a lead | 將 {name} 設為負責人 |
| Last lead | Name another lead before you leave. | 離開之前，請先指定另一位負責人。 |
| Department | Department (optional) | 部門（選填） |
| Used for (each part only when it applies) | This team is used for: asking {a} agents · starting rooms · the allowed list | 這個團隊用在：提問 {a} 個 Agent · 開房間 · 允許清單 |
| Used for, nothing yet | This team isn't used anywhere yet. | 這個團隊還沒有用在任何地方。 |
| Rooms note | People added to a room with this team stay in that room when the team changes. | 跟著這個團隊加入房間的人，團隊名單變動後仍會留在房間裡。 |
| Disabled member | Account disabled | 帳號已停用 |

Removing a member:

| | EN | zh-TW |
|---|---|---|
| Title | Remove {name} from {team}? | 要將 {name} 從 {team} 移除嗎？ |
| Body | They lose what this team gives them right away: {list}. | 他們會立刻失去這個團隊給的權限：{list}。 |
| Still allowed | They can still {list}, through {source}. | 他們仍然可以{list}，因為 {source}。 |
| Rooms | They are in {n} rooms they joined with this team. | 他們有 {n} 個房間是跟著這個團隊加入的。 |
| Buttons | Remove from the team · Remove from the team and those rooms · Cancel | 從團隊移除 · 從團隊和這些房間移除 · 取消 |

Deleting a team:

| | EN | zh-TW |
|---|---|---|
| Body | {n} people will lose: {list}. {k} of them will no longer be able to use this Hub. | {n} 位成員會失去：{list}。其中 {k} 位將無法再使用這個 Hub。 |

For the person affected:

| | EN | zh-TW |
|---|---|---|
| Share paused | Paused: you are no longer allowed to share agents. Ask your team lead or the Hub administrator. | 已暫停：你目前不能分享 Agent。請洽團隊負責人或 Hub 管理員。 |
| Fleet disconnected | This Fleet was disconnected from the Hub: you are no longer on a team or group that may connect. | 這個 Fleet 已經和 Hub 中斷連接：你不在可以連接的團隊或群組裡。 |

## 3. Cards

| Card | What | Size | Needs |
|---|---|---|---|
| T1 | Teams on the allowed list: a row can be a team; union with groups; exclusions still win; the picker; the impact preview counts team members | M | Nothing |
| T2 | Managing teams: several leads, a lead can name leads, department optional, "Who can create teams", the "used for" line (no room count: a room does not record which team its people came from until T3) | M | Nothing |
| T3 | Leaving a team acts at once: immediate re-check, paused shares, disconnect with 30-day reconnect, the remove and delete dialogs; rooms record which team a person was added with, which the dialogs and a room count on the "used for" line then use | M | T1 |
| T4 | AD groups act on removal: the hourly and sign-in check; join codes scoped to a group or team are re-checked; team as a join code scope | M | T1 |
| T5 | "Who can use this Hub": the stricter choice, with the lock-out warning | S–M | T1, T3 |
| T6 | Offboarding on team lists: disabled shown, removal after the grace period, lead handover | S | M-3188 item 4 |
| T7 | Teams in roles: who holds a role, and "manager of team X" | with the roles re-scope | T2 |

Order: T1 and T2 first (they are what the owner asked for and do not depend on each other), then T3, then T4.

## 4. Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| TQ1 | Who can create teams? | **Administrators only by default**, with a setting to add people or AD groups (the managers). |
| TQ2 | How many leads? | **Up to five**, each able to name another. One lead is a single point of failure. |
| TQ3 | Must a team name a department? | **No.** Optional label. |
| TQ4 | May a lead's team be put on the allowed list, so the lead decides who can connect a Fleet? | **Yes, the administrator's choice per team.** It is the point of the feature; the cost is in 2.2. |
| TQ5 | When someone leaves a team, do they leave the rooms they joined with it? | **No, but offer it in the same step.** Rooms are conversations; removal should be someone's decision. |
| TQ6 | Should "allowed" also gate using the Hub at all? | **Offer it, off by default** (T5). Most pilots want everyone able to sign in and be invited to rooms. |
| TQ7 | A Fleet disconnected by a removal | **Reconnect by itself within 30 days** if the person is allowed again. After that they connect again by hand. |

## 5. 給擁有者的摘要（zh-TW）

**現況：** 團隊已經可以用在「誰可以問這個 Agent」和「誰可以開房間」。還不能用在管理員的「允許清單」（和 Agent 對話、分享 Agent、連接 Fleet）、加入碼、角色。而且團隊只能由管理員建立，只有一位負責人，還必須掛一個 AD 部門。

**要做的：**

1. **允許清單可以放團隊**：清單上每一列可以是 AD 群組、團隊或個人，選擇器處處相同。
2. **主管自己管團隊**：管理員決定誰可以建立團隊；一個團隊最多 5 位負責人，負責人可以增減成員、指定其他負責人；部門改成選填。
3. **離開團隊立刻生效**：團隊名單是 Hub 自己的，所以移除成員的當下就收回提問、分享與 Fleet 連接（30 天內重新加入會自動恢復）。跟著團隊加入的房間不會自動退出，但移除時會列出來，可以一併移除。
4. **補上 AD 群組的漏洞**：先說明清楚——被移出允許的 AD 群組後，分享與連接其實會在「下一次使用時」被擋，但不會主動中斷，用加入碼進來的 Fleet 也永遠不再檢查。改成每小時與每次登入檢查並主動中斷；加入碼的範圍也會持續檢查。另外提供一個預設關閉的選項：「只有允許清單上的人可以使用這個 Hub」。

**要注意的代價：** 把團隊放進允許清單，等於讓團隊負責人決定誰可以連接 Fleet 和分享 Agent。每次名單變動都會留下紀錄，管理員可以隨時把團隊移出清單。

**建議順序：** T1（允許清單放團隊）與 T2（主管管理團隊）先做，再做 T3（離開立刻生效）、T4（AD 群組主動檢查）。
