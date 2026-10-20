---
section: Changed
---
- **The Windows installer's last step happens in the browser.** Instead of `agend quickstart` in the console, it runs `agend setup`, opens the setup page in your Windows browser, copies the setup code for you and shows it large; you pick Discord or Telegram and paste the bot token on the page. When the page finishes, AgEnD starts and is installed as a service (unless the service already runs). A page that closed unfinished can be opened again with Enter; if no page appears, the installer offers the console setup instead.
