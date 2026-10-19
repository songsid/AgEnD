---
section: Fixed
---
- **Text no longer jitters right after switching to a chat (#2184).** Opening a chat that wasn't kept moved its text: a photo near the bottom grew from nothing as it loaded, and the whole view shifted by a fraction of a pixel each time older messages were filled in above. Photos now keep their size from the start (read from the picture's header, turned the way the photo is), and the view stays exactly where it is while the history fills in. Measured frame by frame in Chromium and WebKit, on desktop and phone: no message on screen moves at all after a switch.
- **More chats come back instantly.** The web chat keeps the last 12 chats you opened (6 on a phone, and fewer when they hold more than 2,400 messages in all), up from 4. Your favourites are let go last.
