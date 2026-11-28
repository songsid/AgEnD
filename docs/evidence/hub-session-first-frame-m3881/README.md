Hub first-frame session ordering
================================

The shared Shell mounted before the lazy Hub panel read the session. A signed-out
visit could therefore draw the sidebar and Hub name first. A server-rendered
workspace-shaped boot skeleton also survived under the new pending component
when the first Preact root did not consume its different tag.

The Hub entry now waits for its existing shared session before mounting Shell.
The Hub's pre-module HTML and live pending state use the same neutral shared
skeleton. The static placeholder is replaced in the same synchronous Hub mount;
Fleet boot markup is preserved. Signed out renders the existing Hub sign-in
page. Signed in mounts the existing workspace with its panel already available.
No timer, authentication rule, request deadline or extra session request is added.
The URL remains untouched through sign-in, including deep links and queries.
Retained modules without the boundary use the existing reload prompt.

Shared components: Outlet, ui-states, the existing loading.css skeleton shape,
HubSignIn and the signed-in Shell. CSS uses theme and spacing tokens. This follows
docs/design/ui-style-guide.md. Public modules still import Hub code lazily; no
static Fleet imports were added to the Hub graph.

Validation
----------

- The original actual-entry order produces one assertion failure and three
  positive controls on release base0aff702d. The failed assertion observes a
  sidebar while the independent session promise is still unresolved.
- The boot-layer control produces one assertion failure and four positives on
  the initial implementation0ed66264c; it passes after the static/runtime handoff
  correction.
- Five entry controls cover pending/signed-out, signed-in Administration and
  My agents deep links, post-sign-in query preservation and retained-module reload.
- The final entry/CSP/skeleton run passes40tests in four files. Earlier six-suite
  compatibility evidence passes90tests, with overlap. Source and test typechecks
  pass; no total is formed by summing overlapping runs.

Capture scope
-------------

Four current-frame originals are requested: desktop1366×900/light/English and
phone390×844/dark/Traditional Chinese, each loading then signed out. The harness
serves actual production Hub HTML/assets from an owned HTTPS listener and a
fixture Hub. It holds the module request to check the static neutral frame,
releases it, holds the actual session response, captures loading, then releases
that response and captures sign-in. It records DOM commit shapes, geometry,
localized accessible loading labels, one session GET, no foreign requests,
no write requests and no runtime error. No timer is accelerated.

Only one Chromium instance is used with serial contexts and no container. The
run stops if host load exceeds8. Browser, contexts, listeners and temporary TLS
material are closed/removed afterwards. The earlier capture exposed the static
boot layer and is retained privately as diagnostic evidence, not presented as
current. Final images and source bindings are listed in verification.json.

These are fixture-only current-state captures, not before/after browser claims.
The old ordering is established by assertion reversal. Phone evidence is browser
emulation, not a physical device or native keyboard. No live Hub, real directory,
Fleet, vendor or account operation is exercised. This is a display-order fix,
not an authentication/security change or a latency benchmark.

Rollback: revert the entry/boundary/neutral-frame changes and boot markers. There
is no migration, configuration or stored-data change to undo. That restores the
prior visual flash. Main integration follows the stable release line; this PR
makes no separate main delivery claim.

Current originals
-----------------

- [Desktop loading](desk-light-en-loading.png) → [sign-in](desk-light-en-signin.png)
- [Phone loading](phone-dark-zh-TW-loading.png) → [sign-in](phone-dark-zh-TW-signin.png)

Final source capture: `c1349d793ea8c3579257fd76b2d82ee00d5feaf8`; 20/20 checks pass, and all four
originals were individually checked for privacy and readability. The boot
indicator overrides only the shared skeleton's delayed reveal, like the existing
boot placeholder, so it is visible immediately without an animation.
