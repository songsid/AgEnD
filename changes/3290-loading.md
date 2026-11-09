---
section: Fixed
---
- **Dashboard loading states use quiet, content-shaped skeletons (#3290).** The initial app, sign-in session check, search and preview reads, profile and access settings now share grey placeholders. Needs you and Notices wait for their first data instead of suggesting an empty result; populated views stay visible during refresh. The styles support light/dark themes, reduced motion and older cached shells.
