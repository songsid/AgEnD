---
section: Added
---
- **Messages that send you to another topic link to it (#1990).** The link opens the place on Discord and Telegram. On Telegram the link sits on the word itself (a tappable "General" or instance name). On Discord it is the channel mention (`#general`).
  - **A reply that sends you to General** ends with "→ General" linked to it. This covers a General-only command typed in an instance topic, `/profile` outside General, `/web` outside General, and a message in a topic no instance is bound to.
  - **An instance's own notices that point at General** carry the same link: "stopped normally" and "waiting for interactive input".
  - **General's notices that name an instance** link its name to the instance's topic: the restart and assist prompts, "parked on a dialog", "not taking the answer" and "an unrecognised prompt".
  - **Cross-instance status lines in a topic** link the other side: the target's line links the sender's topic, and the sender's line links the target's.
  - **No link** where the reader might not open it: in a ClassicBot room, for an instance of another bot, or on the web dashboard (links there come next). Text from an agent or a pane can never create a link.
