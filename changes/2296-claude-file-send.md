---
section: Fixed
---
- **Claude Code 2.1.317's "send files?" approval waits for you (M-2296).** When an agent's connector call would send files from this computer (an email with attachments), Claude asks first, even in the bypass mode agents run in. AgEnD now holds that card for a person: it never answers it, a delivery never presses Enter on it, and the agent shows in Needs you. Before, the plain card was answered No as if it were a dangerous command, and its other forms went unnoticed.
