---
section: Fixed
---
- A message waiting for a busy agent no longer holds up the messages behind it. While waiting, it checks every second whether it can be handed to the agent's own input queue, the way it would have been on arrival. Once it can, it goes, and the messages behind it follow in order. Before, a scheduled paste could hold a person's messages and steers for as long as the agent's screen kept moving.
- Cancel now frees the queue right away, even while a delivery is waiting. Your messages that the cancel dropped before they reached the agent are marked ❌, and the chat gets one notice saying they were not delivered. Before, they were dropped silently and only showed later as "could not confirm delivery".
