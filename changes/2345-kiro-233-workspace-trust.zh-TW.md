---
section: Fixed
---
- **kiro-cli 2.33.0：V3 instance 不再卡在 kiro 新的「Trust this workspace?」提示（#2345）。** 2.33.0 的 V3 引擎在畫面開啟前，會在每個還沒信任過的資料夾問這個問題（家目錄則是每次啟動都問）。AgEnD 先前既不回答也不擋住它，新的 V3 instance 永遠不會就緒，而送進去的第一則訊息會誤選已反白的「Trust, continue」。在 `--trust-all-tools` 下（AgEnD 的預設，本身就是更大的授權），AgEnD 現在只在 kiro 畫出的確切畫面上確認「Trust, continue」，接著照舊回答 trust-all-tools 確認。沒有 `--trust-all-tools`、游標被移到「Don't trust」，或任何其他版面時，提示會留給你在 instance 的畫面裡回答，也不會有訊息送進去。登入畫面、TUI 信任確認與速率限制文字都和 2.32.0 相同（已實機重新擷取），2.33.0 啟動時也不再出現「未測試版本」警告。
