---
section: Changed
---
- **ClassicBot rooms start together with the fleet's agents (#2642).** They used to start only after every fleet agent had started, the chat connections were up, and topics and icons were set. Now they start right after General, in the same startup queue, and at the same pace under memory pressure. A room's messages are routed to it from the start, as before. A full restart works the same way.
