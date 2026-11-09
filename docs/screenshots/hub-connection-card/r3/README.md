# R3 — preserve visible copy around class-like text

The R2 helper recognized a `class=` suffix without tracking HTML context. Three fail-first controls reproduce the reviewer finding: body text, a quoted title, and a quoted ARIA label containing that suffix each hid visible network wording. All three failed before this correction.

The helper now tracks start-tag and quoted-attribute context across the template’s interpolations. It skips only an actual unquoted class/className attribute expression in an `html` template. Conditional CSS classes remain technical; the three visible-copy cases and the existing non-HTML/title/ARIA controls remain inspected. All 99 named-link/card/search tests and test type-checking pass.

No product source changed after the source-cleared R1 head. The R0/R1 browser, Pause/503/Retry and scope-limit evidence carries, including the disclosed untested old-alpha.10-app.css/all-new-JS combination. R2’s original claim was too broad; this addendum supersedes that scanner claim.
