---
name: admin
description: What General can do for the administrator — by itself (a tool), only as a proposal the admin confirms, or not at all (where the person clicks). Load it first for any admin ask; it points to the detailed skill.
roles: [general]
---

## Three kinds of answer

- **Tool**: do it now, then say what changed.
- **Proposal**: General asks and an authorized admin presses Confirm on the card the fleet posts. Say that nothing has
  changed yet and who must confirm.
- **The person does it**: say exactly where they click. Never claim a change you cannot make.

## Map

| Area | The admin asks | How |
|---|---|---|
| Agents | create, delete, replace, start, stop, pause, wake, restart | Tool (`create_instance` … `restart_instance`); see instance-lifecycle |
| Agents | backend, model, tool set, auto-pause, name, description | Tool `update_instance_config` (a change restarts the agent) |
| Agents | reasoning effort | Read with `get_effort`; the person sets it on the agent's Settings page (row ⋯ → Settings) |
| Accounts | move an agent to another account | Tool `update_instance_config` (credential profile), once that account exists; see credential-profiles |
| Accounts | add or sign in an account | The person: `/login`, or Settings → AI accounts (a browser sign-in) |
| Fleet defaults | default backend, model, auto-pause, message size | Tool `update_fleet_defaults`. Check `get_fleet_config` first: an agent with its own value keeps it |
| Fleet settings | anything else (task board, notifications, access) | The person: Settings, then **/** to search the setting by name |
| Teams, schedules, decisions, task board cards | all | Tool (`create_team`, `create_schedule`, `post_decision`, `task`) |
| Contact permissions | what is held, and who it waits on | Tool `contact_state` (read-only) |
| Contact permissions | approve or decline a held message | The person: the held message's own card in General (**Approve once** / **Decline**), if it has one; else proposal `propose_contact_change` kind `ticket-decision` (the short id people see, R + 8 characters, works) |
| Contact permissions | change or remove a standing rule | Proposal `grant-adjust` / `grant-revoke`; the grant_id comes from `contact_state` |
| ClassicBot rooms | restricted or unrestricted | Proposal `mode`: `restricted`, or `legacy` (= unrestricted, 自由) |
| Contact permissions | clear an agent's retained origin | Proposal `origin-clear` {target} (the target from `contact_state`'s retained_origins); an admin confirms, as on the agent's Permissions tab |
| Contact permissions | the target is not on Discord/Telegram | The person: Fleet › Authorizations (授權) or Needs you, in the web dashboard |
| Hub | connect, share or pause an agent, who may ask, groups | The person, with their company account; see hub |
| Access | administrators, allowed users, guests | The person: Settings → Access & security (it grants authority) |
| Links | open a public link, its lifetime | The person: `/web` → Other device, or Settings → Access & security for a fixed link |
| Updates | update now or at a time | The person: `/update` in a chat, or the update notice; see fleet-restart |
| Look, office | themes, colours, cards, effects, office styles | Tool (`set_web_settings`, `web_appearance`, `office_*`); see web-appearance |

## Contact permissions, step by step

0. A held message from an agent, or from a ClassicBot room to an agent, already has a card in General on the target's
   Discord or Telegram: **Approve once** / **Decline**. An administrator who may decide clicks it there; that is the
   decision, with no proposal and no second Confirm. Use the steps below when there is no card (the target is not on
   Discord/Telegram, or the card has expired) or the admin asks you to.
1. `contact_state` (optionally `agent`): `held` lists each waiting message with `short_id`, from, to, the people it
   came from and who decides.
2. `propose_contact_change` with `{ kind: "ticket-decision", ticket_id: "<short_id>", decision: "approve-once" }`
   (or `"decline"`). Add `grant` only when the admin asked for a standing rule.
3. Tell the admin a card is waiting in General for them to Confirm, and that it expires in five minutes.
4. A refusal is a sentence that says what to do next: follow it (read `contact_state` again, or send the admin to
   the web page it names).

Contact approval lets one message through; it does not limit what the receiving agent does afterwards.
