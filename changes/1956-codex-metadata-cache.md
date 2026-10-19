---
section: Fixed
---
- The fleet's loop no longer re-reads and re-parses codex's models cache (hundreds of KB) for every codex agent on every dashboard status update (#1956). The effort metadata is read once per version of the file: a changed file is read on the next ask, and one changed less than a second ago is read again until it settles. A status build on a 40-agent test fleet went from about 9 ms to 2 ms.
