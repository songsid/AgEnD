---
section: Changed
---
- **送給忙碌中 agent 的訊息不再記成警告（#2482）。** agent 正在做事時，AgEnD 最多等一分鐘讓它做完，然後把訊息交給它；agent 的 CLI 會在這一輪結束後讀取。在實際的 fleet 上量測，這些「Idle gate timed out」警告全都是這種忙碌中的 agent，所以現在改成 INFO，並記下它已經忙了多久。真正可能有問題的情況仍會警告：一個 agent 被回報忙碌超過一小時、畫面卻十分鐘沒有變化，或者在 agent 根本不忙的時候逾時。
