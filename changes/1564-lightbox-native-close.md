---
section: Fixed
---
- **Web chat: the image viewer always cleans up when it closes (#1564).** If the browser closed the image viewer by itself, the chat behind it could stay unable to scroll. Every way of closing it now does the same thing: the page scrolls again and focus goes back to the image you opened.
