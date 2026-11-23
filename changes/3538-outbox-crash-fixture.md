---
section: Fixed
---
- Make the delivery outbox's crash-recovery test wait for its child fixture to load before dispatch, and run the durable suite outside parallel CI shards without increasing timeouts or adding retries.
