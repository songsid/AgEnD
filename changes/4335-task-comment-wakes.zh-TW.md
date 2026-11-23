---
section: Changed
---
- **任務板卡片上的留言或 `@mention` 會再次喚醒 agent。** 別人在卡片上留言，會喚醒負責人；留言裡寫 `@<instance 名稱>`，即使那張卡不是它的，也會喚醒被點名的 agent，形式是一則 `[Task board]` 通知，寫出誰留的言並引用內容。這推翻 #2801「留言不通知任何人」的規則，讓卡片成為可以對 agent 說話的地方（#4335）。留言者本人、已關閉任務板的 agent，以及負責人已讀過的留言都不會喚醒；反引號裡的文字不會被當成 mention。人寫的留言，通知結尾會加上「(a person reads the card; no @ needed)」，agent 就會在卡片上回覆，而不是 @ 一個不是 instance 的人。agent 在同一張卡上互相回覆，最多互相喚醒 4 回合（使用者留言會解除），一則 agent 留言最多喚醒 5 個 agent，卡片負責人也算在內。agent 的留言、mention 和進度，和它的訊息一樣受聯絡許可規則限制：它的對話需要聯絡許可時（來源不明或不是管理員），不會喚醒其他 agent，並會被告知改用 `send_to_instance`；被它喚醒的 agent 會繼承它的來源。預設開啟，既有的 fleet 也一樣：`defaults.task_board.comment_wakes: false` 可恢復舊規則。升級前寫的留言不會補發通知，也不改動任何已儲存的資料。
