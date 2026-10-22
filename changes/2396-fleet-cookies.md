---
section: Fixed
---
- **Independent dashboard sign-ins on one host (#2396).** Fleets on different ports now use their own session, device and setup cookie names. Existing owned browser sessions migrate automatically, while signing out leaves other fleets signed in.
