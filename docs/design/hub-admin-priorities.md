# Hub administration: what a company Hub still needs, in order (M-3188)

Status: a ranking for the owner's decision. Nothing is built. "Today" means a source survey of
`release/2.3.5-alpha` at `27b57d5cd`; nothing was run. Effort: S = days, M = one to two weeks, L = several weeks,
for one builder with review.

## 1. The order, in one table

| # | Item | Today | Value | Effort | Needs first |
|---|---|---|---|---|---|
| 1 | **Health and certificate alerts** | No warnings at all | IT: high | S–M | Nothing |
| 2 | **Forwarding to Discord or Telegram** | Browser notifications only | Users: highest | M | Nothing |
| 3 | **Backup and restore** | Nothing | IT: high | M–L | Nothing |
| 4 | **AD offboarding, finished** | Access stops; nothing is cleaned up | IT: high | M | Nothing |
| 5 | Audit view and export | Recorded, but nobody can see it | IT: high | S–M | Nothing |
| 6 | A second administrator | Exactly one administrator | IT: medium–high | S–M | Nothing |
| 7 | Retention on the Administration page | Works, set only on the Hub computer | IT: medium | S | Nothing |
| 8 | Announcements | Nothing | Users: medium | S | Nothing |
| 9 | Usage caps | Per-minute limits only | Owners: medium | M | The overview's counts |
| 10 | Hub General | A one-to-one "Hub assistant" exists | Admin: medium | M per step | G1–G7 decided |
| 11 | The connector (M-3185) | Spec, second draft | Agents: high, not a Hub item | L | Its own cards |
| 12 | Roles and department administrators | A model, switched off | IT: medium | L | 6; a re-scope |
| 13 | File type and size rules | Sensible fixed limits | Low | S | Nothing |
| 14 | Personal agent | Evaluation note | Users: medium | L | Trusted certificate; Windows |
| 15 | Public launch | Not started | The end goal | L+ | 1, 3, 4, 5, 12 and the pre-launch list |

**Recommended first four: 1, 2, 3, 4.** Item 5 is small enough to ride along with 4.

Why this order: 1 is cheap and prevents an outage that will otherwise happen on a known date. 2 is what makes
rooms work for people who do not keep a browser tab open, which is the owner's goal for managers. 3 is the only
item where waiting can lose everything. 4 is the first question a company's IT will ask.

## 2. Each item

### 1. Health and certificate alerts

- **Today.** The Hub's browser certificate is self-signed and lasts 30 days. Its expiry date is shown on a
  Settings card on the Hub computer; nothing warns anyone. The health check only says the Hub process is ready:
  it does not test the AD connection, the database or the disk. A failed retention run writes one log line.
- **Gap.** An administrator learns of a problem when colleagues cannot sign in.
- **Proposal.** A "Needs attention" list at the top of Administration → Overview, and the same items as a message
  to the administrator's own Fleet. First set: certificate expires in 7 days or less (with the Renew action); AD
  not reachable for 15 minutes; disk nearly full; retention did not run; no backup in 7 days (after item 3).
- **Value.** Prevents the commonest outage. **Effort** S–M. **Needs** nothing.

### 2. Forwarding to Discord or Telegram

- **Today.** A question to an agent reaches it through its Fleet. An @mention of a **person**, an answer to their
  question, an invitation or a direct message reaches them only as a browser notification, so only with the Hub
  open. No setting, no email, no push.
- **Gap.** The owner's decision ec27e4c2 has managers using the Hub from Telegram or Discord through their own
  agents. Today nothing tells them there is something to answer.
- **Proposal.** Per person, on by default for people with a connected Fleet: the Hub tells the person's Fleet, and
  the Fleet's General tells them in their own chat. **Default content: who, which room, and a link; not the
  message text.** A person can choose to include the text.
- **Cost.** With the text included, room content leaves the company network to Discord or Telegram. That is why
  the default is notice-only.
- **Value.** Highest for users. **Effort** M (Hub side and Fleet side). **Needs** nothing; reuses the path that
  delivers questions.

### 3. Backup and restore

- **Today.** Nothing. No command, no page. Everything, room files included, is in one database file plus a
  revision file and a key file that must match. Restoring an old database file alone is refused by design. The
  only guidance is one line of setup text telling the administrator to keep a private backup.
- **Gap.** A failed disk or a bad update loses every room, file, share and connection, and every Fleet must
  connect again.
- **Proposal.** A scheduled backup (daily, keep 7) to a folder the administrator chooses, a **Back up now**
  button, the last backup's time on the overview, and a restore that is run on the Hub computer with the Hub
  stopped. Restore brings the three files back together and says plainly what is lost since that backup.
- **Cost.** A backup that includes the key lets whoever holds it read everything. Recommended: the backup is
  protected by a passphrase the administrator sets; without the passphrase there is no restore.
- **Value.** High for IT. **Effort** M–L, because a restore has to be rehearsed, not assumed. **Needs** nothing.

### 4. AD offboarding, finished

- **Today.** The safe half exists. Every use of the Hub asks AD again; a disabled or expired account is marked
  disabled, its sessions end, and questions to or from that person's agents are refused. What does not happen:
  - Nothing checks on a schedule, so a person who never comes back still looks active in every list.
  - Their Fleets stay connected, their shares and room memberships stay, their uploads stay.
  - A room whose only manager left has no manager until an administrator notices and joins it.
  - "Removed from the allowed group" stops sharing and connecting only at the person's next action, and never
    ends their sign-in or room memberships (`hub-teams-as-subjects.md`, section 1.3).
- **Proposal.** A daily AD check of everyone known to the Hub. When an account is disabled: end the Fleet
  connections, stop the shares, remove the person from rooms (their past messages stay, shown as from a former
  member), and for each room they alone managed, make the longest-standing member the manager and tell the room.
  An administrator sees a "People who left" list with what was done, and can undo within 30 days if AD was wrong.
- **Cost.** An AD mistake or a short suspension now removes someone from their rooms. Hence a grace period before
  the clean-up runs (recommended: 7 days disabled) and the undo.
- **Value.** High for IT. **Effort** M. **Needs** nothing; the handover is cleaner once item 6 exists.

### 5. Audit view and export

- **Today.** More than expected: a tamper-evident log of actions already records who did what (sign-ins, room
  actions, administrator changes, retention changes), and there is a read endpoint. But there is no page, no
  export, and no way to name an auditor: the function exists and nothing calls it. A person who is not an auditor
  sees only records about their own agents.
- **Proposal.** Administration → Audit: a filterable list (person, action, date) and an export to CSV. **Actions
  only**: the stored text of questions and answers is never shown or exported here.
- **Value.** High for IT, and nearly free because the recording is done. **Effort** S–M.

### 6. A second administrator

- **Today.** One administrator, set when the Hub is created. The roles model (Administrator, Manager, Member) is
  merged and switched off.
- **Gap.** One person on leave stops every administrative action, and the offboarding of that one person is a
  special case.
- **Proposal.** Only "more than one administrator", by name or by AD group. Not the roles screen.
- **Value.** Medium to high. **Effort** S–M. This is the useful first slice of item 12.

### 7. Retention on the Administration page

- **Today.** Works: message text and files are removed after a set number of days, and action records after
  another (suggested 7 and 30). The setting is only on the Hub computer's own Settings page. Rows remain with the
  text gone. No per-room setting.
- **Proposal.** Show and change it in Administration → This Hub, and tell members in each room: "Messages and
  files here are kept for {0} days." Per-room retention only if someone asks.
- **Value.** Medium. **Effort** S.

### 8. Announcements

- **Today.** Nothing. No banner, no everyone room. `@all` means all agents in a room, not all people.
- **Proposal.** One banner an administrator writes, shown to every member at the top of the Hub until its end
  date, in up to two languages. Later, if wanted, the same text through item 2 to people's chats.
- **Value.** Medium: maintenance windows and rule changes. **Effort** S.

### 9. Usage caps

- **Today.** Per-minute limits on agent posts, search, sign-in and uploads; a limit on Fleets per person; a limit
  on room assistants running at once. No daily number per person, group or agent. The overview counts questions
  per day and per agent.
- **Proposal.** Start with the cap that protects someone's money: a daily limit on questions **to** each shared
  agent, set by its owner, and a daily limit per person on the Hub's own assistant, set by the administrator.
  Per-department caps wait for teams and roles to settle.
- **Value.** Medium now, higher as use grows. **Effort** M.

### 10. Hub General

- **Today.** A private "Hub assistant" conversation per person is shipped. The spec (`hub-general.md`) adds
  help and who-to-ask, read-only lookups, administrator questions and administrator actions, in four steps.
- **Value.** Medium: it makes administration easier, it does not add an ability. Its administrator steps become
  more useful after items 1, 4 and 5 exist, because those are what it would report on. **Effort** M per step.

### 11. The connector (M-3185)

Not a Hub administration item: it is a Fleet-wide change that benefits every agent. It should run as its own
track with its own builder and should not compete with this list. Its Hub door (desktop apps) waits for the
Hub's trusted certificate.

### 12. Roles and department administrators

- **Today.** The model exists and is off; no screens. Group permissions (preview) and teams with team leads cover
  part of the need.
- **Recommendation.** Do item 6 now. Re-scope the rest before launch against what rooms and teams actually need;
  it will be smaller than the original design. Department administrators come out of that, not before it.
- **Effort** L.

### 13. File type and size rules

- **Today.** Fixed and sensible: 20 MB per file, 10 files and 50 MB per message, a short list of document and
  image types, images checked against their real format. Not adjustable.
- **Recommendation.** Leave it until a company asks. Then: let an administrator lower the sizes and switch types
  off, never add types. **Effort** S.

### 14. Personal agent

Blocked on two things outside this list: a certificate the colleague's computer trusts, and Windows only
(`hub-personal-agent.md`). Rank it again when the certificate exists.

### 15. Public launch

Last because it depends on most of the above (1, 3, 4, 5, 12), on the trusted certificate and domain, on Entra
sign-in, and on the pre-launch list in `hub-product-plan.md`.

## 3. Things the survey turned up that are worth knowing

- The certificate lasts **30 days** and nothing warns before it ends.
- The audit log is already being written, with stored question and answer text beside it, and **no one can be
  made an auditor**.
- A database backup taken by copying the one file **will not restore** unless the two files beside it are copied
  at the same moment.
- A person removed from an allowed AD group is refused sharing and connecting at their next action, but **keeps
  their sign-in, rooms and teams**, nothing is disconnected ahead of time, and a Fleet that came in by join code
  or invitation is never re-checked. Details and the fix are in `hub-teams-as-subjects.md` (M-3191).

## 4. 給擁有者的摘要（zh-TW）

**建議先做四項：**

1. **健康與憑證到期提醒**（小）。現在憑證 30 天到期，沒有任何提醒；AD 連不上、磁碟快滿也不會通知。做成管理頁最上方的「需要處理」，同時通知管理員自己的 Fleet。
2. **把通知轉到 Discord／Telegram**（中）。現在有人 @ 你，只有開著 Hub 網頁才看得到。預設只送「誰、哪個房間、連結」，不送訊息內容，避免內容離開公司網路。
3. **備份與還原**（中到大）。現在完全沒有；硬碟壞掉就全部重來。每日自動備份、立即備份按鈕、在 Hub 主機上還原。備份要用管理員設定的密碼保護。
4. **AD 離職處理補完**（中）。現在帳號停用後已經不能登入、不能提問，但 Fleet、分享、房間成員都還留著，沒有人管理的房間也不會交接。加上每日檢查、自動收回、房間交給最資深的成員、30 天內可復原。

**順便做：稽核紀錄的檢視與匯出**（小到中）。紀錄其實已經在寫了，只是沒有畫面、不能匯出、也無法指定稽核人員。只匯出「動作」，不含對話內容。

**之後的順序：** 第二位管理員 → 保留期限搬到管理頁 → 公告 → 用量上限 → Hub General → 角色與部門管理員（上線前重新評估範圍）→ 檔案規則 → 個人 Agent（等正式憑證）→ 對外上線。

**連接器（M-3185）** 不是 Hub 的管理功能，建議另開一條線、另一位開發者，不和這份清單搶順序。
