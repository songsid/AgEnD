---
section: Changed
---
- **Opening a temporary public link shows each step as it happens (#1512).**
  - The `/dashboard` menu you clicked follows the start step by step, with seconds on each step:
    1. check cloudflared;
    2. download it, in MB of the total;
    3. verify it against the pinned version and SHA256;
    4. start the tunnel;
    5. wait for the public address to answer;
    6. send you the link privately.
  - Steps 1–3 appear only when AgEnD's own cloudflared must be fetched; after the first time it is steps 4–6.
  - A step that fails is marked with its reason, for example "the file did not match the pinned SHA256" or "another tunnel is still running". Running `/dashboard` again retries.
  - The menu is updated at most every 2 seconds (3 on Telegram, where the menu message in General is edited). It never shows the link or the code.
