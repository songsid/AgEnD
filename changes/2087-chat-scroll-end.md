---
section: Fixed
---
- **Web chat: wheeling down to the bottom stops where you stop (#2087).** The view no longer tugs once more at the end. The "Latest" pill took 38 px of room at the bottom of the thread and gave it back as you reached the bottom, and within 48 px of the bottom the view counted as "following", so the next change in size (the working line, a prompt, a picture) pulled it the rest of the way down. The pill now takes no room, and only a view at the very bottom follows. A new message still follows you when you are near the bottom.
