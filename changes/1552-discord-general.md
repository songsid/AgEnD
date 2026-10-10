---
section: Fixed
---
- **Wizard-created Discord connections now bind the General channel correctly.** `planQuickstart` was writing `general_channel_id` at the top-level of the connection (introduced in c25045b0), but the runtime reads it from `channel.options.general_channel_id`. The wizard now writes to the correct location. Existing fleet.yaml files with the old top-level field are still supported via a fallback in `discordGeneralChannelId()`. (#1552)
