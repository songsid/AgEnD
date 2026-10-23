---
section: Changed
---
- **Settings → Guests looks like the rest of Settings, and every change to someone's access is recorded (#2348).**
  - The people with access, and the people seen in chat, are flat rows split by a rule.
  - Each row shows a round letter avatar, the agents as square outlined chips, and its state on the right in colour: green when signed in, blue for a code sent, red when the DM failed. On a phone the state goes under the name.
  - An edited row has the straight bar across the full width, and nothing is a rounded box.
  - On a phone, an agent's name and "last seen" no longer break mid-word.
  - Each saved change to a person's access writes `guest_grant_changed` to the event log: who saved it, whether it applied at once or was confirmed in General, the agents added and removed, and the sessions a removal ended. The section's new **Recent changes** list shows these and the sign-in codes sent, to admins only (never a guest, never over the public link). Removals and narrowings, which apply at once, used to leave no record.
