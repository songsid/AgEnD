---
section: Fixed
---
- **Windows 安裝程式不再卡在「OpenAI Codex」（#2583）。** Codex 的 install.sh 最後會在終端機上問「Start Codex now? [y/N]」，在安裝程式裡沒有人能回答，這一步就一直轉到逾時。現在每個後端的安裝都在沒有終端機可問的情況下執行（Kiro 重新安裝時問「是否取代」也是同樣的陷阱），Codex 的另外加上 `CODEX_NON_INTERACTIVE=1`。`/login` 替你安裝 Codex 時也會設定。給你複製的指令不變。
