---
section: Changed
---
- **Web: General can show its own bot, and an uploaded picture can be removed (#1630 follow-ups).**
  - The primary bot now counts as an instance's own bot when only that instance uses it, for example a fleet that keeps the primary for General alone. That instance then shows the bot's avatar and its Discord colour ring. A primary shared by several instances or rooms still shows without a ring.
  - View's **Edit profile** has **Remove picture** when a picture is uploaded. On save, the picture is deleted and the bot's avatar, persona emoji or first letter shows again.
  - The route is `DELETE /api/avatar/<instance>`, signed in like the upload.
