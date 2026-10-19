---
section: Added
---
- Windows 可以在 PowerShell 用一行指令安裝：`powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"`。它會下載 Windows 安裝腳本、檢查內容，經過一次 Windows 系統管理員確認後執行，不會改動你的執行原則。WSL 需要重新開機時，重開後再執行同一行即可接續。安裝頁、README 和入門指南都改成先介紹這一行；自己下載腳本再執行的方式仍然可用。
