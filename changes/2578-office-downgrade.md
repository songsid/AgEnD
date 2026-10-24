---
section: Fixed
---
- **Office access no longer blocks a downgrade to 2.3.1 or 2.2.6 (#2578).** Settings stores it as `defaults.office_access` / `instances.<name>.office_access`, outside the older dashboard feature map. Existing `dashboard.office` values migrate with a backup. Office remains off unless enabled, with the same confirmation and tool restrictions. Downgrade CI checks both published validators with Office on and off.
