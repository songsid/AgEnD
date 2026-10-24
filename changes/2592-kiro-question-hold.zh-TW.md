---
section: Fixed
---
- **kiro：訊息不再意外回答 agent 的提問（#2592）。** 當 kiro V3 的 agent 向你提問時，kiro 會用一張「Question」卡片取代輸入框，上面有編號選項和「Type a different answer…」。AgEnD 先前把這個畫面當成空閒的輸入框：下一則訊息被貼進去、變成打字的答案並送出，agent 就把你的訊息當成一個沒人看過的問題的答案。現在這張卡片會被擋住，和 kiro 2.34.0 的「Input requested」卡片一樣（#2587）：在你於 instance 畫面裡回答或取消之前，不會送出任何訊息、也不會按任何鍵；期間收到的訊息會等候，卡片消失後才送出；一分鐘後 AgEnD 會在 instance 的話題和 General 說明它正在等一個提問。這張卡片在 kiro-cli 2.33.1 與 2.34.0 都一樣。
