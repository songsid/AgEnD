---
section: Fixed
---
- **Web chat: a chat opened cold in Safari starts at the newest message (#2158).** In Safari and other WebKit browsers, the first chat a page opened could stop about 230 px above the bottom, with the newest message partly hidden. While the page loaded, the thread got a little shorter as it settled, and the browser moved the view up to match. The page took that for you scrolling up, so the rest of the history drew in without following the bottom. A view that moves up only because the thread got shorter now stays at the bottom. A scroll of your own still leaves it.
