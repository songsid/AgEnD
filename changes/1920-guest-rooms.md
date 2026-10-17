---
section: Security
---
- **Web: a guest can now also reach a ClassicBot group room they are a member of (#1920). No guest can sign in yet.**
  - **Which rooms:** a Telegram group or a Discord channel run by ClassicBot, on the guest's own connection, counts only while AgEnD has confirmed the guest is in it. For a Telegram group that means a member. For a Discord channel it means a member of its server who can view the channel and read its message history. A private thread also needs the guest to be in it, or to manage threads, as on Discord.
  - **When it is checked:** in the background, never while answering a request. AgEnD checks when it starts, then every 10 minutes, and again when a guest's page reconnects (at most once a minute). A failed check is retried after 1 minute, then 2, 4 and 8, up to every 10 minutes, and a check that keeps failing is logged once. A guest's page retrying can't make AgEnD check a room more than once every 30 seconds.
  - **When access ends:** if the guest leaves the room, it drops out at the next check. If AgEnD can't get an answer for 15 minutes, the room is hidden anyway. If that leaves the guest nothing, their session ends.
  - **Right after a restart:** a guest whose only room hasn't been checked yet is asked to try again shortly. Their session isn't ended.
