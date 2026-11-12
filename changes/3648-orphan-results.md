---
section: Fixed
---
- **A tool result the Log read after its call could be shown as interrupted (#3648).** The Log's live read starts in the middle of a turn, so a tool's result can arrive without its call; when that turn ended in the same read, the result was re-reported as "interrupted". It stays done now. In the chat, a `reply`'s result read this way still ties its step to the delivered message, and only a reply's own result does (another tool's result that mentions a `chatId` no longer does).
