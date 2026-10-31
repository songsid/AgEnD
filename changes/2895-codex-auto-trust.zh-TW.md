---
section: Changed
---
- Codex agent 不會再卡在 Codex 的「Trust this folder?」提示。AgEnD 會自動信任 agent 的工作區：提示出現且游標在 Trust 上時就按下 Trust，不論這個資料夾是否已預先信任。只回答資料夾信任提示；`skipPermissions` 為 false 時，指令的核准仍會等人處理。daemon.log 會記錄信任了什麼。版面不熟悉的信任提示仍會被擋下。
