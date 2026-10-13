---
section: Changed
---
- **The sidebar's instance count sits on the filter headers' row (#1776).**
  - The count (for example `71 / 71`) used to take a row of its own under the Status and CLI headers. It is now at the right end of their row, so the filter area is one row shorter.
  - It stays there when a group is opened or a filter is set. In a narrow sidebar, a header moves down to the next row before the count does. The count reads the same as before, including "shown" when a filter is active.
