---
section: Fixed
---
- Every open dashboard tab no longer rebuilds the fleet's whole status on the fleet's loop for its own 10-second heartbeat (#1956): the status is built once per tick and sent to every open stream, each guest's projection made from that build for its own scope. With five tabs open on a 40-agent test fleet, a heartbeat tick went from five builds (about 42 ms) to one (about 11 ms).
