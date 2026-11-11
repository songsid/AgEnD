---
section: Fixed
---
- **Windows desktop shortcuts are created on Windows whose system language isn't Chinese (#3632).** On an English, Japanese or European Windows, 「AgEnD 儀表板」 and 「AgEnD 重新啟動」 were never created (Windows could not save their Chinese names). They are now saved under a temporary name and then put in place; an existing shortcut is kept if that fails.
