---
section: Fixed
---
- **Web chat times say the day when it is not today (#1770).**
  - A message from today still shows only its time. One from yesterday shows "Yesterday 17:38", an older one "10/11 17:38", and one from another year "2025/10/11 17:38". Hover a time to see the full date and time zone.
  - Times and days are read in the fleet's time zone (the one chat logs and fleet.log use), not the browser's. The same labels appear on messages, status lines and the preview panel. At midnight the labels update without reloading any preview.
