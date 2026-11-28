# Hub install prerequisites (M-3865)

On a scratch HTTPS Hub with a self-signed certificate, the iOS Safari branch kept showing Share → Add to Home Screen after service-worker registration failed with a certificate SecurityError. The same address already showed the correct warning on desktop. An insecure HTTP address had the same ordering problem on iOS.

The fix lets the existing insecure/certificate explanation take precedence over Safari advice, while keeping an installed app or actual browser install offer intact. No words, styles, permissions, or service-worker caching behavior change.

- [Before, phone English](before-phone-en.png): incorrect Safari advice.
- [After, phone English](after-phone-en.png): existing certificate warning.
- [After, phone Traditional Chinese](after-phone-zh.png): the same existing warning.

These captures use the real Hub UI and HTTP/session routes on loopback, private scratch state, synthetic identities, and Chromium with iPhone Safari user-agent/device emulation. They establish the app's iOS state selection and layout; they do not claim a physical Safari installation test. The browser's actual service-worker registration rejects the scratch certificate. No live Hub, Fleet, directory, model, or OS trust store was used or changed.

Regressions cover the rejected certificate, insecure context with no worker API, and a late certificate rejection after the app is installed. The two negative regressions fail against the previous source. Existing trusted-iOS and desktop installation controls remain in the suite.
