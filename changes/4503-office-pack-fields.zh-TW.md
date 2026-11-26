---
section: Added
---
- 辦公室外觀包多了三個可省略的欄位。座位的 `standFacing`（`up`、`down`、`left`、`right`）讓它變成站著工作的位置：在那裡工作的人會站著面向那一邊，不打字。車上座位的 `worker` 讓它成為那位 agent 的工作位置：他工作時會自己去搭、坐在那裡，其他人不會坐。車站的 `queue` 讓每位 worker 在月台外有自己的等車位置，列車進站才走上月台。呼叫人時（needs、crashed、stuck）worker 一樣會立刻下車、走到服務台。沒用這些欄位的外觀包不受影響。
