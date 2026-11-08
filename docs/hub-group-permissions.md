# Hub group permissions

中文版：[hub-group-permissions.zh-TW.md](hub-group-permissions.zh-TW.md)

> **Experimental. 2.3.5-alpha.8 and later only, and off by default.** Group permissions let a Hub administrator decide, by Active Directory security group, what signed-in colleagues may do on the AgEnD Hub. Until an administrator turns them on, the Hub behaves as before.
>
> **Draft:** the Hub only offers this once its group enforcement is installed. Until then the editor says *"Turning group permissions on becomes available once the Hub's enforcement is installed."* This page is finished when that lands.

Everyone in your directory can still **sign in** to the Hub. Group permissions decide what each person can **do** after signing in:

| Permission | What it lets a member do |
|---|---|
| **Chat with agents** | Ask the agents their owners have shared with them. The agent's owner still has to give each person access; the group permission alone opens nothing. |
| **Share agents** | Share new agents, or new versions of agents, from their own fleet on the Hub. Each share still needs the owner's own confirmation. |
| **Connect a fleet** | Pair their own AgEnD fleet with the Hub, up to the **Fleets** number set for the group (0–8). With **Fleets** at 0, members can't connect a fleet even though the box is ticked. |

A person who is in several groups gets everything any of their groups allows, and the highest **Fleets** number among their groups that allow **Connect a fleet**. A person listed under **People excluded** is denied what they are excluded from: exclusions win over any group.

## 1. Set up access for a department (Hub administrator)

### Where the editor is

Only the Hub's directory administrator can open it. Either:

- **On the Hub:** open the menu on your account in the sidebar (**Menu**), choose **Administration**, then, on the **Group permissions** card (tagged *Experimental*), choose **Open group permissions**.
- **From your fleet's dashboard** (the fleet that hosts the Hub): **Settings → Fleet → Hub**, then, on the **Group permissions** card, choose **Open on the Hub**. It opens the Hub's editor in a new tab.

Someone who is not the Hub administrator sees *"Only the Hub administrator can see this"* on the Administration page instead. If the Hub is too old to have the editor, the link says *"Group permissions aren't available on this Hub yet. Update the Hub, then try again."*

### Add a group

1. In **Group (distinguished name)**, type the group's distinguished name, for example `CN=Hub-Members,OU=Groups,DC=example,DC=test`.
2. Choose **Add group**. The Hub looks the group up in your directory (*"Looking up the group…"*).

The group must be a **security group** that exists in the directory. The editor says so plainly if it is not: *"No such group in the directory."*, *"That is not a security group."*, *"That is not a distinguished name."*, or *"That group is already listed."*

A new group starts with **Chat with agents** only, and **Fleets** set to 1. Tick **Share agents** or **Connect a fleet** as needed. **Fleets** (how many fleets each member may connect, 0–8) can only be changed while **Connect a fleet** is ticked. **Remove** takes a group off the list.

Nothing changes until you save.

### Check what the change does, then save

As soon as your draft differs from what is saved, the editor checks who it affects and shows **What this change does** (*"Checking who is affected…"* while it works):

| Section | Meaning |
|---|---|
| **Lose actions they can do now** | People who can do something today and won't after you save. |
| **After saving, can't share new or revised agents (already shared ones stay)** | Agents already on the Hub stay shared; only new shares and new versions are stopped. |
| **Shared agents kept as they are** | What people already had, kept as it is: for example, everything that existed before group permissions were first turned on. |
| **Paused by this change** | Fleets, shared agents or chat access that the change pauses (see [Pause and resume](#4-turn-off-pause-and-resume)). |
| **Held, unchanged: N people** | See below. |

If no one loses anything, it says *"No one loses anything they can do now."* If the change would stop **you** from chatting with agents, it warns you first: *"After saving, you won't be able to chat with agents: you are not in a group that allows it."*

**Held.** *"AD did not report group membership for these people. Nothing changes for them now: they gain nothing and nothing of theirs is paused. They are checked again at their next action."* Held people do not stop you from saving. The next time each of them does something on the Hub, the Hub asks the directory again and applies the policy then.

Then choose **Save**, or **Turn on and save** the first time. *"Saved."* confirms it. Saving applies exactly the change the check showed:

- If a group membership in the directory changed since the check, the Hub refuses the save, says *"Something changed since this was checked. Check again."*, and checks again for you. Look at the new result and save again.
- If you waited too long, it says *"This check expired. Check again."*
- If group permissions were saved from another tab or session, or fleets or shared agents changed on the Hub in the meantime: *"Someone else changed group permissions. Reload to see their version."*

## 2. What a colleague sees after signing in

After signing in, a colleague's home page greets them (**Welcome, *name*** — *"What would you like to do?"*) with two cards, **Chat with an agent** and **Connect your fleet**. What the cards say depends on what their groups allow:

| Their access | What they see |
|---|---|
| **Chat and Connect a fleet** | Both cards on. **Chat with an agent** has **Open chats**; **Connect your fleet** shows *"Your fleets: N of M"* and *"Your Hub admin pairs fleets for you. Ask them for a pairing code."* |
| **Chat only** | **Chat with an agent** is on; **Connect your fleet** is off, with the reason *"Connecting a fleet is not included in your access."* |
| **Nothing allowed** | Both off: *"Your account can sign in, but no actions are allowed yet."* *"Contact your Hub admin."* |
| **At their fleet limit** | *"You have connected as many fleets as you may. Manage them, or ask your Hub admin for more."* |
| **Directory not answering** | *"The directory didn't answer, so this can't be checked right now."* with **Retry**. The Hub never falls back to an old answer. |
| **Group permissions never turned on** | Chat works as before; **Connect your fleet** shows only the pairing-code note. |
| **Group permissions switched off** | Both cards off with *"Paused by your Hub admin."*, and *"Your account can sign in, but no actions are allowed yet."* *"Contact your Hub admin."* |

If no agent has been shared with them yet, the chat card says *"No agents have been shared with you yet. An agent's owner has to give you access."* A card that is off says why: *"Your Hub admin has excluded your account from this."*, *"Your directory account can't use this right now."*, or *"Paused by your Hub admin."*

Their own fleets are listed with their state: **Active**, **Paused**, **Revoked**, or **Can't be checked right now**.

## 3. Quick pairing

> **Draft:** quick pairing is not in this release yet. Today a colleague asks the Hub administrator for a pairing code, as the **Connect your fleet** card says. This section is finished when quick pairing lands.

## 4. Turn off, pause and resume

- **Turn the policy off:** **Turn off** in the editor, then save. Until you save, the editor shows *"Not saved"* and *"Turns off when you save; what depends on it is paused."* **Undo** cancels it. After saving: *"Switched off — resources paused"*.

  **Turning off pauses chatting, sharing and connecting for everyone**, the administrator included. Fleets and shared agents that existed before group permissions were first turned on stay registered, but **nobody can ask any agent** until you turn group permissions on again **and** resume chat access in **Paused** (below). Once turned on, group permissions can be switched off but never return to the "never turned on" state.
- **Take a group away:** **Remove** the group, check **What this change does**, then save.
- **Resume something paused:** the editor's **Paused** section lists what was allowed by a group before and is paused now: fleets, shared agents and chat access (*"Allowed by a group before, paused now. Resume one after checking it is still wanted."*). Choose **Resume** on each one you still want (*"Resumed."*). Turning group permissions back on never resumes anything by itself: you decide, item by item.
- **Exclude a person:** **People excluded** is shown in the editor; adding someone to it from the editor is not available in this release.

> **Draft:** revoking a single person's access from the editor, and an owner's own revoke, come in a later release. This section is updated when they land.

## See also

- [Web dashboard](web-dashboard.md): signing in to your own fleet's dashboard.
- [Concepts](concepts.md): host owner, fleet admin and other roles.
