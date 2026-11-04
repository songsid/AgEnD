---
section: Fixed
---
- **Stopping a native Windows agent stops its CLI; when the per-PC agent limit is reached, AgEnD says so and names the agents holding the slots.**
  - **`stop_instance` stops the CLI.** It used to only disconnect AgEnD from a native Windows pane: the CLI kept running on the Windows computer, unsupervised, still holding one of its agent slots, while the tool answered "stopped". It now closes the pane, confirms the CLI exited, and frees the slot. If the exit cannot be confirmed, the stop fails with that reason instead of saying "stopped".
  - **The limit refusal is named.** A message refused because the computer already runs its maximum number of agents now says that limit and which agents hold the slots, marking one whose outcome is unknown, instead of the generic "could not receive this message". (#3002)
