Visual inspection: PASS for all 12 original PNGs.

Scope: opened each original directly with `view_image`; no montage, resizing, source review, browser action, or test execution. This receipt covers visible rendering in these captures only.

| Screenshot | Observation |
| --- | --- |
| `browser/baseline-desk-light-en-consent.png` | Connection shows `https://127.0.0.1:41480`; update consent explanation shows `https://127.0.0.1:41479`; top banner uses `127.0.0.1`. Text is readable. |
| `browser/candidate-desk-light-en-consent.png` | Connection, update consent explanation, top banner, and Hub navigation show `Rig Hub`. Row text fits without clipping or overlap. |
| `browser/baseline-desk-light-en-confirm.png` | Confirmation title and body show `https://127.0.0.1:41479`; title wraps cleanly; buttons and close control remain visible. |
| `browser/candidate-desk-light-en-confirm.png` | Confirmation title and body show `Rig Hub`; title fits on one line; body, buttons, and close control are readable and unobstructed. |
| `browser/baseline-desk-light-en-notice-banner.png` | Banner uses `127.0.0.1`; update notice attributes the request to `Alice (127.0.0.1)`. Text and actions fit. |
| `browser/candidate-desk-light-en-notice-banner.png` | Banner uses `Rig Hub`; update notice attributes the request to `Alice (Rig Hub)`. Text and actions fit. |
| `browser/baseline-phone-dark-zh-TW-consent.png` | Consent explanation uses `https://127.0.0.1:41479`; banner uses `127.0.0.1`. Chinese text wraps within the card. |
| `browser/candidate-phone-dark-zh-TW-consent.png` | Consent explanation and banner visibly show `Rig Hub`. Chinese text wraps within the card with no clipping or overlap. |
| `browser/baseline-phone-dark-zh-TW-confirm.png` | Bottom dialog title/body use `https://127.0.0.1:41479`. Wrapped title, close control, body, and both buttons are visible. |
| `browser/candidate-phone-dark-zh-TW-confirm.png` | Bottom dialog title/body show `Rig Hub`. Two-line title and body wrap cleanly; close control and both buttons are fully visible. |
| `browser/baseline-phone-dark-zh-TW-notice-banner.png` | Banner uses `127.0.0.1`; notice shows `Alice (127.0.0.1)`. Wrapped notice and action buttons stay within the card. |
| `browser/candidate-phone-dark-zh-TW-notice-banner.png` | Banner and notice show `Rig Hub`, including `Alice (Rig Hub)`. Wrapped text and action buttons stay within the card. |

No visual defect found in the requested name replacement, readability, wrapping, clipping, or mobile dialog scope. The baseline visibly demonstrates the modeled address/hostname display; the candidate visibly replaces it with `Rig Hub` in all requested surfaces. No claim is made about unseen states, longer names, other viewports, or runtime behavior.
