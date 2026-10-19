---
section: Added
---
- Install on Windows with one line in PowerShell: `powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"`. It downloads the Windows installer, checks it, and runs it as Administrator after one Windows approval prompt, without changing your execution policy. After the restart WSL may need, run the same line again and it resumes. The install page, the README and Getting Started show it first; downloading the script and running it by hand still works.
