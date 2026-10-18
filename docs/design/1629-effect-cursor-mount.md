# #1629 actual personal cursor integration

> Current policy: [#2118 default playback](canvas-worker-default-playback.md#immediate-startup-and-live-reference-pr-3-of-3)
> supersedes this slice's empty-page calibration and hard OS-motion/Save-Data prerequisites. The original evidence below
> describes that earlier slice. Playback now starts while the host learns a live cadence; the shared device motion option
> is off by default. Isolation, protected pixels, caps and sticky safety remain.

The session-only app owner connects the fifth personal slot to the reviewed host
cursor controller. This is local signed-in playback; public link, View, polling
transport and header-token pages have no app owner. Per-platform identity and the
visibly shared web-only operator bucket are unchanged. Try remains separate work.

## Exact source and authorization

The existing authoritative owner metadata read already includes all five slots.
The personal source now projects fx.cursor in its status snapshot and supplies an
immutable `{id, generation, hotspot}` receipt. It never makes a cursor Worker
frame descriptor or Pause/Resume target. Four normal region descriptors, priority,
frame caps, safety history and profiles are unchanged.

The app reuses its single metadata scheduler and runtime loader. Before and after
`cursorImageSettled`, the core rechecks the exact current receipt, including its
hotspot and source generation. Same-id old success/failure cannot publish or mark
a new generation unavailable. The physical image operation still belongs to the
shared loader/controller until body cancellation and decode settle. No Settings
read supplies runtime metadata and no replacement controller resets capacity.

An ordinary image refusal marks only that cursor selection unavailable, preserving
its saved id/reference and four region contributions. Shared-effect withdrawal
blocks the next image authorization, even if old metadata was cached. It does not
promise to erase an already-applied image until a new authorization is attempted.
Clear uses the existing authorized preference write; no new claim, export, sharing
or retention grant is created. Unreadable preferences fail closed as before.

## Host lifecycle and gates

The app creates one controller after the shared runtime owns its episode, supplies
the immutable receipt and the exact settled binary read, and disposes it with the
same app owner. Late construction is released immediately if the app ended. A
missing/unsupported cursor controller leaves Chat and four region playback intact.
Session end, pagehide, consent loss or identity loss cannot restore a late cursor.

Cursor playback follows the existing effects/show/preview-consent/safe/public/
reduced-motion/SaveData/visibility gates, and pauses for host menus/dialogs. It
conservatively requires the existing runtime facilities too; this adds no separate
unsupported-browser exception. Stock sidebar/split dragging temporarily restores
stock resize cursors, then rereads the chosen image after the drag ends. The
existing host class observer detects this transition; no new polling/observer is
added. Explicit descendant pointer/text/resize declarations retain their rules.

Controller status notifications are deduplicated before notifying Settings and
cannot re-enter the controller. Runtime metadata invalidation remains driven by
the existing preference revision and explicit Reload/Save. Cursor has status and
Clear, not Worker Pause/Resume or fabricated profiler samples. Settings itself
fetches no runtime images/code and creates no playback.

The verified app.css rule, static32KiB/square64px PNG, native dimensions/hotspot,
normal-priority container-only inheritance, `, auto` fallback and physical
settlement remain the reviewed controller contract. No author HTML/DOM/CSS,
Worker, new frame, inline style or CSP relaxation is used for the cursor. Human
owner choice does not create an agent foreground exemption; the existing custom
CSS restriction on agent foreground effects remains intact.

## Verification limits and rollback

The checked-in actual product recipe uses Shell/Fleet/Chat/Settings, built private
library/preferences/service/preview and a synthetic local session, not real
platform credentials or the complete auth server. It checks static APNG output,
frame capacity unchanged, no cursor Worker read, drag fallback/restore, unshare at
the next image read with cached metadata, retained saved reference/Clear, status,
and sign-out while active. Chromium/Firefox/LinuxWebKit do not prove real Safari.

Rollback withdraws the driver/controller import, served cursor asset and cursor
status copy together. Saved preferences and content identity need no migration;
the shared Chat/four-region runtime continues. Hung physical read/decode keeps its
reservation; do not release it early to make a retry appear successful.
