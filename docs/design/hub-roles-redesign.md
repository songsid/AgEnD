# Hub › Roles and permissions: a redesign after common admin consoles (M-3883)

Status: design for the owner. No product code; build after 2.4.0. Written 2026-11-27 against the dev tip
`0aff702d8`. The "new" pictures are a working prototype inside the real Hub: the page's own script is swapped in
the browser, and everything behind it (sign-in, the roles API, the check and save steps) is the real server.
Captures are in `docs/evidence/hub-roles-redesign-m3883/`.

## The owner's complaints, and what was found

"The UI is odd; copy common templates. Including the tick and selection logic. It is long, and there are too many
capsule boxes."

Measured on today's page, with four roles and nine assignments (made-up people and groups):

| Complaint | Today | Why it feels wrong |
|---|---|---|
| Roles cannot be compared | The list describes each role in a sentence ("Chats with agents, shares agents and connects a Fleet") | To learn what a manager can do that a member cannot, you open each role and read a list |
| Selection is unclear | Assigning takes one kind at a time (a "Who receives it" menu: People or AD groups); what you picked shows as a capsule above the search box; nothing can be ticked or removed in bulk | No list has checkboxes, so there is no select all and no way to remove three people at once |
| Too many capsules | 4 tags on the roles list, 11 on the People view, plus a button on every row ("Assign") | Tags repeat what a column could say once: Built-in, You, the role name |
| Long | A role's row is about 97 px on desktop and 158 px on a phone; a person's row is 114 px | Each row is a card with three lines |
| Scope is buried | "Applies to" comes after the person, as a menu | The scope decides whose manager someone becomes; it is the second most important choice |
| The important notice is a footnote | "The first administrator gets no automatic chat, sharing or Fleet allowance…" sits under the table in small grey text | It tells the administrator they cannot use the Hub yet |
| Names repeat | The page title says "Roles and permissions" under a tab of the same name | |
| AD groups show as raw paths | "cn=Example Engineering,ou=groups,dc=example,dc=test" as a row's name | The group's name is the first part; the path is detail |
| The count of permissions disagrees with the list | "5 / 13" on a role whose page lists 11 or 12 | Two reserved permissions are counted and never shown |

## What common consoles do

From each product's own documentation. The labels below were read through a summarising fetch, so the exact wording
should be checked on the page before it is quoted anywhere else.

| Product | Roles list | Role page | Assigning | A matrix? |
|---|---|---|---|---|
| Microsoft Entra ID | "Select a role name to open the role" | Assignments on the role; eligible and active with start and end dates | From the role: "Add assignments", then "select the users, groups…": one picker for both. Also from the user's page | No |
| Google Workspace | Account › Admin roles | Two tabs: "Admins" and "Privileges" | "Assign admin" › "Assign members": users and groups typed into one field, up to 20 at a time; the scope ("All organizational units", "Edit") and "Set expiration" in the same panel | No |
| GitHub organizations | Built-in roles and custom roles side by side | Permissions grouped under headings; a custom role starts from a base role | By person or team | No |
| Slack | Role types by name | — | One member at a time from the member's menu | **Yes**: the help pages compare roles in a table (roles as columns, features as rows) |
| Notion | "Select a role to see what it covers and who has it" | What it covers, and who has it | "Add or remove members", with a search box | A table of the ready-made roles |

Sources: [Entra: manage roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal),
[Entra: assign roles to users](https://learn.microsoft.com/en-us/entra/fundamentals/how-to-assign-roles-to-users),
[Entra: time-bound assignments](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-how-to-add-role-to-user),
[Google: assign admin roles](https://knowledge.workspace.google.com/admin/users/assign-specific-admin-roles),
[Google: view assignments and privileges](https://knowledge.workspace.google.com/admin/users/view-role-assignments-and-privileges),
[GitHub: custom organization roles](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-peoples-access-to-your-organization-with-roles/managing-custom-organization-roles),
[GitHub: their permissions](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-peoples-access-to-your-organization-with-roles/permissions-of-custom-organization-roles),
[Slack: types of roles](https://slack.com/help/articles/201912948),
[Slack: permissions by role](https://slack.com/help/articles/115001382787),
[Notion: admin roles](https://www.notion.com/help/enterprise-admins),
[Notion: groups](https://www.notion.com/help/create-and-manage-groups).

**What at least three of them share, and this design copies:**

1. Built-in roles are fixed; custom roles sit beside them in the same list.
2. A role's page has two parts: who has it, and what it allows.
3. Assigning starts from the role, with one search for people and groups.
4. The scope is chosen in the same step as the people.

**What none of them documents:** row checkboxes with a bulk action. Those come from ordinary table practice (a
checkbox per row, one in the header for all, an action bar that appears while something is ticked). The Hub already
uses that shape elsewhere ("Share N agents").

## The redesign

### 1. Roles: one table that compares them (`1-matrix`)

- Roles are the columns; permissions are the rows, under the three groups the product already has (Using the Hub,
  Their team, Running the Hub). A ✓ means the role allows it. The last row is each role's Fleet limit.
- Under each role's name, in plain small text: Built-in or Custom, and who has it ("1 person · 1 AD group"). Both
  the name and the count open the role.
- One button: **New role**.
- A permission's one-line explanation shows when the pointer rests on its name; the role's page shows it in full.
- **On a phone** a matrix does not fit. The same data becomes a list of roles, one row each: name, Built-in or
  Custom, who has it, "5 of 11 permissions · Fleet limit 2". The role's page then shows the permissions.
- More roles than fit across: the table scrolls sideways with the permission names staying in view (build detail).

### 2. A role's page: Members and Permissions (`2-role-members`, `3-role-permissions`)

- A text link back ("‹ Roles"), the name, one line of facts (Built-in · Default Fleet limit 2), the description.
- Two tabs, as Google's: **Members · 2** and **Permissions · 5 of 11**.
- **Members is a table**: a checkbox, Name, Type (People or AD groups), Applies to, Ends. An AD group shows its
  name, not its path.
- Pressing a name opens that assignment to change its scope, end date or Fleet limit.
- **Permissions** is the same three groups as short lists with ✓ or –, each with its explanation. Edit permissions
  stays a button on custom and adapted roles.

### 3. Ticking and selecting (`2b-members-selected`)

One rule everywhere a list can be acted on:

- Each row has a checkbox. The header's checkbox ticks or clears all; it shows a dash when only some are ticked.
- While anything is ticked, the bar above the table changes from "2 assigned · **Add people or AD groups**" to
  "**1 selected** · Remove from this role · Clear selection". Nothing else on the page moves.
- A ticked row is tinted.
- Rows that cannot be acted on have a disabled checkbox with the reason beside the name (your own assignment; the
  first administrator, who is set on the Hub's host).
- Removing goes through the same check-then-save step as every role change, so the administrator sees who loses
  what before saving.
- On a phone the header row is hidden, so **Select all** sits in the bar.

### 4. Adding people: one drawer, one search (`4-add-empty` to `4d-add-review`)

Opened from a role ("Add people or AD groups"), so the role is already known and is in the title: Add to "Manager".

1. **Who.** One search box finds people and AD groups together. Each result has a checkbox; several can be ticked,
   across several searches. What is ticked is listed under the results as plain rows ("3 selected": name, and
   sign-in name or "AD group", with Remove). A role that can run the Hub can only go to people; then groups are
   not searched and one line says why.
2. **Applies to.** Two radio buttons with one line each: one AD group (then a search for the group), or the whole
   Hub. A role with no team permissions shows "Whole Hub" as a fact, with the reason, not as a choice.
3. **Optional**, folded: an end date, and a Fleet limit for these people.

The foot of the drawer is always in view: on the left what is still missing ("Choose the AD group this role
applies to.") or the count ("3 selected"), then Cancel and **Review**. Review is the existing check step; it now
lists only what changes, and names a group by its name.

### 5. People (`5-people`)

A table: Name, Type, Roles, Applies to. A filter box, and All / People / AD groups as one three-part switch.
A person's roles are words separated by commas, not tags. "(You)" follows your own name as text. Pressing a name
opens that person's roles, as today.

### 6. The first administrator's notice

It moves from under the table to the top of the page, as a bordered note with a heading that says what is wrong
("You can't chat, share agents or connect a Fleet yet"), one sentence, and the same button. It disappears once
used, as today.

### 7. Smaller things

- The lead sentence under the tabs goes; the page title repeating the tab is the admin page's own and should go
  with it (one line in the shared header, outside this page's script).
- "Roles settings" is a text link beside the sub-tabs, not a "⋯" menu holding one item.
- Seen on the way, already in today's page and outside this design: on a phone the admin tab bar clips its last
  tab ("This Hub").
- The count of permissions uses the permissions the page shows (11), everywhere.

## What it changes in numbers

| | Today | Redesign |
|---|---|---|
| Tags (capsules) in the content, roles list | 4 | 0 |
| Tags, People view (10 rows) | 11 | 0 |
| Buttons on the roles list | 5 (New role + Assign on each of 4 rows) | 1 |
| Steps to give a role to two people and one group | 2 drawers (people, then groups) | 1 drawer |
| Remove three people from a role | open each person, Remove, check, save: three times | tick three, Remove, check, save once |
| Compare two roles | open both, read both lists | one table |

The buttons themselves keep the product's rounded shape; this design does not restyle buttons across the app.
It removes the tags and most of the buttons.

## What stays exactly as it is

- The rules: a role with Hub management permissions goes to people only, for the whole Hub; a team role needs
  an AD group as its scope unless a Hub administrator chooses the whole Hub; at most 50 subjects in one go.
- Every change is checked by the server first, then saved; the prototype uses those two calls unchanged.
- The role wizard (name, permissions, review), the audit tab and the roles settings dialog.
- No new API is needed for anything pictured. The one-box search asks the existing people search and the
  existing group search and shows both answers.

## Build cards (after 2.4.0), each small

| # | Card | Size |
|---|---|---|
| R1 | Roles as a matrix on desktop and a list on a phone; plain-text type and counts; one permission count | S |
| R2 | A role's page: Members table (no selection yet), Permissions lists, text back link; AD groups by name | S |
| R3 | Selection: row checkboxes, select all, the bulk bar, Remove from this role through the existing review | S |
| R4 | The add drawer: one search for people and groups, the selected list, scope as radio buttons, the always-visible foot with what is missing | M |
| R5 | People as a table with the filter and the three-part switch | S |
| R6 | The first administrator's note at the top; the review lists only what changes | S |

R1 and R2 first: they answer "odd" and "long". R3 and R4 answer the selection logic.

## Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | Is the comparison table the roles page, or a second view beside a plain list? | **The page itself.** With three to six roles it fits, and it replaces the sentences |
| Q2 | May several people be removed from a role in one go? | **Yes**, through the same check and save |
| Q3 | Selection on the People tab too (remove a person from every role at once)? | **Not in the first build.** It touches several roles at once; the role's Members table covers the common case |
| Q4 | Keep the lead sentence "What people may do in this Hub. Roles can't read conversations or show spending."? | **Drop it from the page**; keep the second half as a line in the role wizard, where it reassures |

## How it was checked, and what was not

- Today's page and the prototype were both captured in the real Hub (production runtime, HTTPS, SQLite) with
  made-up people and AD groups: desktop (1440 × 1200) and phone (390 × 844), zh-TW and English. A reader
  checked every prototype frame twice for layout defects; what it found was fixed and recaptured.
- In the prototype I ticked rows, ticked all, opened the drawer, searched twice, ticked two people and one group,
  chose a group as the scope and reached the real Review, which the server accepted.
- Not checked: saving from the prototype, the role wizard and audit tab (unchanged), more roles than fit across,
  a screen reader, Safari, a real phone.
- The seeding call was refused once (503) and passed on a rerun; I did not find the cause. It is the rig's
  seeding, not a page shown here.
