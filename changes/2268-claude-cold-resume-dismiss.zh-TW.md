---
section: Fixed
---
- **Claude Code 2.1.304：閒置 agent 的「Resume this conversation?」提示又會自動處理，不再卡住（#2268）。** 2.1.304 的閒置提示把 Escape 標成「Esc to dismiss」，而不是「Esc to resume」。這個鍵在兩個版本的作用相同：關掉提示並保留對話。AgEnD 原本只認得「Esc to resume」，所以會停下來等人處理，送往那個 agent 的訊息也都被擋住。現在兩種寫法都一樣按 Escape。其他形狀的畫面仍會等人處理，AgEnD 也絕不會選「Start a new conversation」。
