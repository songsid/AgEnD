# Loose numbered lists (#3558, M-2811)

One agent message (zh-TW and EN) with a loose numbered list (blank lines between items) and a list resumed after a paragraph. It's drawn in the real web chat on the shared smoke fixture: the product's own web server from an in-process FleetManager, a scratch home, loopback only.

- `before-*`: `songsid/main` at the fix's base. Every item is its own list numbered 1. The DOM per message has four `<ol>`, each starting at 1 with one item.
- `after-*`: this branch. One `<ol>` of three items, then `<ol start="4">` after the paragraph.

Cases: desk light zh-TW, phone dark EN.
