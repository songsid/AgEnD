---
section: Fixed
---
- **Office skin packs: three fixes to the agent tools (#2695).**
  - **Check allowance:** `office_pack_check` now has its own hourly allowance: 60 batches and 1 GiB as sent, per agent. Before, an agent could check a full-size batch as often as it liked, and the fleet received and checked it each time.
  - **Leftover pictures:** if the fleet crashed in the middle of replacing a pack, the new version's pictures could stay on disk without being used or counted. They are now removed the next time the fleet reads the packs, including from a deleted pack's kept previous version.
  - **Approving drops:** approving a pending pack change that drops layout entries now applies it only if it still drops exactly the entries its notice named. If an office was edited since then, the approval is refused and the agent has to send the change again.
