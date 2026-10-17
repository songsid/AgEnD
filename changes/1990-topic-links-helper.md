---
section: Changed
---
- **Needs-you DMs link into the group only for a member (#1990).** A Needs-you DM used to carry topic links for every fleet admin, and an admin who isn't in the group couldn't open them. Now each admin's membership is checked first, with the fleet's own bot (read-only, cached for 10 minutes). A member gets the links as browser URLs. Anyone else, or any error, gets the same lines without links. On Telegram, a public group's topic links use its @username (`t.me/<name>/<topic>`), so they open for non-members too. This lays the groundwork for messages that send you to another topic to link to it.
