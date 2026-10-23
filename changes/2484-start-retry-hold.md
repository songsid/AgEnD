---
section: Fixed
---
- A message sent to an instance that is waiting for its automatic start retry is no longer lost. It used to get ❌ after 30 s, even though the retry brought the instance up a minute later. Now it is marked as queued (⏳ on Discord), waits for the retry, and is delivered once the instance is up. It fails only when the retries give up. A message to an instance a person stopped or paused fails as before.
