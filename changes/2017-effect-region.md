---
section: Fixed
---
- **Web: an effect that can't play in a chat can't be placed there (#2017).** `apply_web_effect`, the dashboard's apply action and a mod's theme placements now refuse an effect whose regions don't include `chat`, with `effect_region` ("This effect's regions do not include chat."). Nothing is written and no change is counted. Before, such an effect was saved, took one of the two chat slots and counted against the change limit, but never played. Such an effect is still a valid upload and a valid personal page, header, sidebar or box choice, and a mod may still carry it as a library entry. A placement saved before this release stays as it was and can still be removed.
