# General as the administrator's proxy: tools, skills and model (M-3689)

Status: audit for the owner. No code. Written 2026-11-25 against the dev tip `c0cb46de3`.

## The short answer

- **General is strong at running agents and weak at permissions.** It can create, configure, start, stop and move
  agents, manage teams, schedules and the task board, and change the dashboard's Look. For contact permissions it
  has one tool that can only *propose*, and no tool that can *read* anything. For the Hub, sign-in, links, updates
  and most Settings it has no tool at all and can only tell the person where to click.
- **Last night's failure is a tool problem, not a model problem.** The ticket tool looks a ticket up by its full
  id. People are shown a 9-character short id. General has no tool that lists held tickets, so it cannot turn one
  into the other. Both Haiku and Sonnet failed this ask on paper, in different ways.
- **The model is not the first thing to change.** On 16 asks, Haiku invented no tool and refused honestly where
  it had none. Sonnet's answers were more complete in five asks, but it reached the same result on every one.
  Fix the tools and the skill text first, then decide about the model with a live walk.

## How this was checked

1. **Inventory, from the code.** General's real instructions, its 72 tools (85 names; two groups are shown as one
   tool each) and its 24 skills were generated from the dev tip, as a fresh fleet's General would get them with
   `tool_set: full`.
2. **A paper walk, 16 asks, two models.** Each model (Haiku 5.5 and Sonnet 5.5) was given exactly those
   instructions, tool schemas and skill files, and one administrator message at a time (9 in English, 7 in
   zh-TW). It wrote the tool calls it would make and its reply. Nothing was executed.
3. **Grading against the code.** I checked each proposed call against the tool's real schema and handler.

**What this is not.** It is not a live General on a rig. No tool result came back to the model, so its recovery
after a refusal was not seen, and a real CLI session has the tool schemas in context instead of reading a file. A
live walk needs a model credential inside a container, which needs the owner's OK. The six transcripts are kept
outside the repository (`~/.cache/rh-m3689` on the fleet host); the asks are listed below.

## 1. Inventory: what a person may ask, and what covers it

"Tool" means General can do it or start it itself. "Tells" means it can only point the person to a place.

| Area | A person may ask | Tool | Skill text | Result |
|---|---|---|---|---|
| Agents | Create, delete, replace, start, stop, pause, wake, restart | Yes | instance-lifecycle | Covered |
| Agents | Change backend, model, tool set, auto-pause, name, description | `update_instance_config` | instance-lifecycle, model-discovery | Covered |
| Agents | Change reasoning effort | Read only (`get_effort`) | web-dashboard | **Gap: no setter** |
| Agents | Read logs, status, usage, cache report | Yes | fleet-health | Covered |
| Accounts | Move an agent to another account | `update_instance_config` (credential profile) | credential-profiles | Covered once the account exists |
| Accounts | Add or sign in an account | None | credential-profiles (`/login`) | Tells. Right: it is a browser sign-in |
| Fleet defaults | Default backend, model, auto-pause, message size | `update_fleet_defaults` | fleet-config | Covered; the skill does not say whether General itself inherits the change |
| Fleet defaults | Anything else in `fleet.yaml` (task board, notifications, access) | None | fleet-config | **Gap** |
| Teams, schedules, decisions, task board cards | All | Yes | scheduling, task-board | Covered |
| Task board | Turn it on or off, set its leader | None | task-board | **Gap** |
| Contact permissions | Approve or decline a held request | `propose_contact_change` (the admin confirms) | web-dashboard, last section | **Broken in practice**, see 3.1 |
| Contact permissions | Show what is held and who it waits on | None | — | **Gap: nothing to read** |
| Contact permissions | Adjust or revoke a grant | `propose_contact_change`, needs a grant id | web-dashboard | **Gap: no way to learn the id** |
| Contact permissions | Clear an agent's retained origin | None | cross-instance-messaging | Tells (the agent's Permissions tab) |
| ClassicBot rooms | Switch a room between restricted and unrestricted | `propose_contact_change` (mode) | web-dashboard, concepts | Covered; the admin confirms |
| Hub | Connect the Fleet, share or pause an agent, who may ask, groups | None (only room tools, as an agent) | hub | Tells. Mostly right: these use the person's company account |
| Access | Add an administrator, allowed users, guests | None | web-dashboard | Tells. Right: it grants authority |
| Links | Open a public link, set its lifetime | None | web-dashboard | Tells |
| Updates | Update AgEnD now or at a time | None | fleet-restart | Tells (`/update`, or the host command) |
| Look | Themes, colours, cards, ambient effects | `get/set_web_settings`, `web_appearance` | web-appearance | Covered |
| Office | Styles and skin packs | Yes | web-dashboard | Covered |

## 2. The walk

"Same" means both models proposed the same calls and conclusion.

| # | Ask (short) | Haiku | Sonnet | Verdict | Gap |
|---|---|---|---|---|---|
| A1 | Approve held ticket `R…` (short id) | Called the tool with the short id | Same, plus an extra `target` field | **Fail, both.** The code refuses both calls | Missing tool; tool too narrow; misleading schema |
| A2 | Show everything that is held | "No tool lists holds" | Same, and named the Hub answer window as the likely cause | Fail, both, honestly | Missing tool |
| A3 | Make the sales room unrestricted | Proposed `mode: legacy` | Same, with a warning about what it loosens | Pass (admin confirms) | The word "legacy" for "unrestricted" made Haiku call it a guess |
| A4 | Clear dev-a's retained origin | "I can't; Permissions tab" | Same | Correct refusal | No proposal kind for it |
| A5 | Let a colleague ask an agent on the Hub, 7 days | Looked the person up; gave the Hub path | Same | Correct refusal | No tool; by design of the Hub session |
| A6 | Pause sharing, keep who may ask | Gave the path; warned against Stop sharing | Same, also warned about the Settings switch | Correct refusal | No tool; by design |
| A7 | Move an agent to another account | Assumed a second account exists | Checked first; a fresh fleet has one, so it stops and explains | Pass (Sonnet), partly (Haiku) | Model completeness |
| A8 | Add an account named "team" | `/login` and the Settings path | Same | Correct refusal | By design |
| A9 | Default model to Sonnet, General unchanged | Change the default, then check itself | Check itself first; unsure whether pinning itself restarts it | Partly, both | Missing skill text |
| A10 | Make a colleague an administrator | "The dashboard or the bot's access list" | The exact Settings path, and a warning about what an admin can do | Correct refusal | By design; model completeness |
| A11 | Public dashboard link for one hour | Two options, one is the Office share | Same, with where to set the minutes | Correct refusal | No tool |
| A12 | Task board on for all, dev-a its leader | "No tool" | Same, and quoted a `fleet.yaml` key | Fail, both, honestly | Missing tool; the key Sonnet quoted is not verified |
| A13 | Lower effort, auto-pause after 30 min | Auto-pause done; effort has no setter | Same, with the Settings path for effort | Half | Missing tool (effort) |
| A14 | Update at 3am, report in the morning | "No tool"; offered a reminder | "No tool"; offered a morning check against a baseline | Fail, both, honestly | Missing tool |
| A15 | New codex agent, worker tools, add to a team | Correct sequence | Same | **Pass, both** | — |
| A16 | Connect the Fleet to a Hub | Gave the steps | Noticed it is already connected, asked to check first | Correct refusal | By design; model completeness |

Totals: 1 pass by both, 2 passes or halves that need a person's Confirm or one missing setter, 3 honest failures
for a missing tool, 1 failure where the tool exists and does not work as people use it (A1), 9 correct "I can't,
here is where" answers. Neither model invented a tool or claimed a permission it did not have.

## 3. Gaps, by cause

### 3.1 Tool exists but fails in real use: approving a held request (the case from last night)

Read in `src/contact-change-proposals.ts` and `src/fleet-manager.ts` (`requestContactChange`):

1. **Full id only.** The ticket is looked up by exact id. Cards and notices show people the first 9 characters.
   A short id is refused.
2. **Nothing to read.** No tool lists pending tickets, grants, room modes or retained origins, so General cannot
   find the full id, a grant id or a revision, and cannot answer "what is held?".
3. **The schema misleads.** The model sees one flat list of optional fields for all four kinds. `target` is
   offered for every kind, but a ticket decision that includes `target` is refused. Sonnet did exactly that.
4. **The refusal is a code.** General gets "Contact proposal not applied: contact-proposal-ticket-unavailable",
   with no next step.
5. **The description is six words.** "General asks; admin confirms. See web-dashboard." The details are the last
   paragraph of a 114 KB skill.
6. **It can refuse for reasons General cannot see:** the target's platform is not Discord or Telegram, there is
   not exactly one General on that connection, or General itself is inside a Hub answer turn.

M-3680 already covers posting a card when a send is held, and approving from Needs you on every link. Items 1 to
5 are separate and stay after M-3680.

### 3.2 Missing tools

| Missing | Why it matters | Suggested shape |
|---|---|---|
| Read contact state | "Why is X blocked?" is the first question an admin asks | One read-only tool: pending tickets (full and short id, from, to, who must decide, expiry), grants, room modes, retained origins |
| Clear a retained origin | The agent stays restricted until someone finds the Permissions tab | A fifth proposal kind; the admin still confirms |
| Set effort | General can read it and not set it | A field on `update_instance_config` |
| Task board switch and leader | Common first-day ask | Fields on the defaults tool, or a proposal |
| Start an update | "Update tonight" cannot be done or scheduled | A proposal the admin confirms, with an optional time |
| Settings outside Look | General cannot read a single non-Look setting, so it cannot even say what a value is | Read-only first; changes as proposals |

### 3.3 Missing skill text

- No short map of "what I can do myself, what I can only propose, what only a person can do". General has to
  read a 114 KB and an 88 KB skill to find one sentence. A small admin skill (a few KB) would serve every ask in
  the walk.
- `update_fleet_defaults`: does General inherit the new default, and does pinning its own model restart it?
- "legacy" is the stored word for an unrestricted room; the text should say so where the mode is described.

### 3.4 Model too weak?

Not shown by this walk. Differences between Haiku and Sonnet were completeness, in A2, A7, A10, A12 and A16:
Sonnet checked a precondition first or gave the exact path. Haiku made one unfounded assumption (A7). Neither
got A1 right, because the tool does not allow it.

### 3.5 Permission too narrow?

With `tool_set: full` no ask was refused for permission. The imbalance is elsewhere: General may delete or
replace any agent with no confirmation, but may not approve one held message. That is a defensible line (contact
approval is a person's authority), but the proposal path has to work for it to be usable.

## 4. Recommendation

1. **Fix the ticket path now** (small): accept the short id; add the read-only contact-state tool; give each
   refusal a sentence and a next step; put the four kinds and their fields in the tool description.
2. **Add a short admin skill** that maps each admin area to "tool", "proposal" or "the person does it here".
3. **Then close the missing tools** in 3.2, in the order: retained origin, effort, task board, update, settings
   read.
4. **Do not change General's default model on this evidence.** After step 1 and 2, run the same 16 asks live on
   a rig with both models. That needs the owner's OK for a model credential in a container. If Haiku then still
   misses preconditions that Sonnet catches, change the default.

## The 16 asks

A1 「leader 說它傳給 dev-a 的訊息被擋住了，票號是 R0a1b2c3d，幫我核准。」 ·
A2 "Why can't notes-bot message dev-a? Show me everything that's being held right now and who each one is waiting on." ·
A3 「把業務群那個 ClassicBot 房間改成不限制，他們的訊息一直被擋。」 ·
A4 "dev-a has been stuck as restricted since yesterday's test. Clear its retained origin so it can message other agents again." ·
A5 「讓王小明可以在 Hub 上問 notes-bot，先給他 7 天。」 ·
A6 "Stop sharing notes-bot on the Hub for now, but keep the list of who may ask it." ·
A7 「dev-a 的 Claude 額度快用完了，把它換到另一個帳號。」 ·
A8 "Add a second Claude account on this machine and call it 'team'." ·
A9 「把整個 fleet 的預設模型改成 sonnet，但你自己（General）維持現在的模型。」 ·
A10 "Make Alex an admin of this fleet so he can approve things while I'm away." ·
A11 「幫我開一個公開連結，讓同事可以看 dashboard，一小時後失效。」 ·
A12 "Turn the task board on for all agents and make dev-a the board's leader." ·
A13 「notes-bot 回答太慢了，把它的 effort 調低，另外 30 分鐘沒事就自動暫停。」 ·
A14 "Update AgEnD to the latest beta at 3am tonight and tell me in the morning whether anything broke." ·
A15 「幫 ~/Projects/site 新增一個 agent，用 codex，工具權限給 worker，再把它加進 web 團隊。」 ·
A16 "Connect this fleet to our company Hub at hub.example.com."

All names and ids are made up.
