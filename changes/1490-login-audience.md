---
section: Fixed
---
- **Guesses on the public link no longer burn or pause a local sign-in code (#1490).** A wrong code typed on the public link used to count against the outstanding local code (five misses withdrew it) and against the shared breaker (twenty misses paused every audience). Public guesses still compare in constant time and still trip a breaker for that public audience; they no longer consume the local code. Matching-audience misses still burn that code.
