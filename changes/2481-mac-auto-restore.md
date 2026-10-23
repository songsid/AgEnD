---
section: Added
---
- **A Mac restores 2.2.x by itself when the 2.3.x it was upgraded to keeps failing to start (#2481).** 2.2.x's own updater can report such an upgrade as a success, and it does not roll back. Now, when that 2.3.x fails to start 3 times within 10 minutes under launchd and has never run on the host, it puts back the 2.2.x copy the updater kept. launchd then starts it; the plist is unchanged. Safeguards:
  - it happens once per version, and only for the launchd job, never for a fleet you started by hand or stopped yourself;
  - the copy must be a 2.2.x that runs and reports its own version;
  - it is logged, `agend doctor` shows it, and the chat notice (#2490) and the Mac notification say it was rolled back, with the caveat that 2.3.x may already have changed AgEnD's data.
