---
section: Fixed
---
- **A recovery Enter goes only to the window it was for (#1490):** when a delivery's Enter did not submit, AgEnD waits for the prompt and sends one more Enter. If the window was recovered during that wait, the extra Enter went to the new window and the check that followed judged the new window's pane. These recovery Enters are now fenced to the window and spawn they were for, up to the moment the key is sent, and no proof is read from a replaced window.
