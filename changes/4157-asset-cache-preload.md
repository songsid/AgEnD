---
section: Changed
---
- Web dashboard: much faster over a slow link (#4157). Its files are now cached by the browser until the next update, and the modules a page needs are requested all at once instead of level by level. In a test with 150 ms of latency per request, `/ui` loaded its modules in 1 round of requests instead of 21, Settings in 1 instead of 8, and a reload fetched none of them again. After an update or a rollback the files change version, so nothing old is reused. A tab left open across an update shows "This tab is older than AgEnD" with Reload instead of loading a newer file.
