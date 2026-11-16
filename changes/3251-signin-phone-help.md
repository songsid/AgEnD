---
section: Changed
---
- Sign-in page: **How do I open AgEnD on my phone?** now lists the ways in, easiest first. First, the temporary link: send `/web` in General and choose 🌐 Other device. Second, a fixed link set up in Settings → Access & security. Third, a private network such as Tailscale. It no longer suggests the computer's local network address, which never worked, because the dashboard only answers on the AgEnD computer itself. A fleet with no chat connection gets its own list: Allow connections from outside, the fixed link, then a private network with a code from `agend web --code`.
