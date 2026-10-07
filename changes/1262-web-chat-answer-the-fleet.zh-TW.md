---
section: Added
---
- **Web 聊天：可以在 dashboard 上回答 fleet 的提示。** instance 看起來卡住、自行結束，或卡在互動式提示時，Telegram 上的按鈕（*強制重啟* / *繼續等待*、*重啟* / *忽略*、*確認* / *取消*）也會出現在該 instance 的 web 聊天中。兩邊是同一個提示，不是複製品：只算一次回答，哪一邊先按就算哪一邊；另一邊的按鈕會收成結果；過期也是兩邊同時。只有這幾種與 instance 健康有關的提示會出現在 web——`/clear` 確認、登入、Classic 群組核准、tips 與 `/model` / `/effort` 選單仍只留在原本發問的地方。從 dashboard 回答需要已登入的 session 與它的 CSRF token、必須指明 instance，而且必須是該提示自己的按鈕之一。
