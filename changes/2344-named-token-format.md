---
section: Fixed
---
- **Reject malformed named-tunnel tokens (#2344).** Token entry validates the decoded Cloudflare credential structure, trims surrounding whitespace and quotes, and explains malformed pastes without exposing credentials.
