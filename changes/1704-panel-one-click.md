---
section: Changed
---
- **Web: "Open in panel" runs the HTML preview in one click (#1704).** Clicking **Open in panel** on an HTML card now opens the panel and starts the preview there, with no second **Preview** click. If this device hasn't allowed previews yet, the panel shows the **Allow previews** offer, and allowing it starts the preview straight away. Where previews can't run (`web.preview: false` or a public link), the panel opens with nothing running, as before. A newer version of the page in a later reply is still only offered, and nothing runs on its own when a page loads.
