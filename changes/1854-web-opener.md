---
section: Fixed
---
- **`agend web` and `agend view` no longer crash on a machine without a browser opener (#1854).**
  - On a server or WSL without `xdg-open`, the command used to crash right after printing the link.
  - It now prints one line saying no browser could be opened; the printed sign-in page and code still work.
