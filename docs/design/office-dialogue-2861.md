# Office: the dialogue box (#2861)

Design by @hxhsandy (#2861). This note describes how AgEnD builds it, on `release/2.3.5-alpha`, for 2.4.0.

## What it is

When a person messages an agent shown in the Office, a visual-novel style box slides up at the bottom of the stage.

- **Heard:** the person's portrait is on the left, with their display name and their words. The words are the first ~120 characters, typed out.
- **Working:** while the agent works, its portrait is on the right with a status line: its own `office_set` line when one holds, else "Working…".
- **Answered:** the agent's reply replaces the status line (the first ~120 characters). The box fades a few seconds later.
- **A queue:** concurrent conversations are kept newest first. The box shows the newest and says "+N" for the rest. When the shown one ends, the next one shows.
- **Clicking the box** is clicking the agent: their profile card opens and the view pans to them. A double-click opens their chat, as a double-click on the person does.
- **Agent-to-agent traffic** is unchanged: props and letters, as today.

## Off by default; nothing changes for existing users

The box is behind one Office bar checkbox, **Dialogue**. It is per browser (`localStorage`, like *Hide paused and stopped*) and off unless ticked. While it is off:

- no stream listener is added and no picture is loaded;
- the canvas draws exactly what it drew before (a test compares the draw calls with the toggle off against a page without the feature);
- the only visible change is the unticked checkbox.

The share page has the same checkbox in the viewer's own browser, also off by default.

## Where the words come from (privacy)

**The signed-in dashboard.** The Office listens to the page's existing `message` stream events: SSE, or the poll on the public link. It reads no new endpoint and asks for nothing new.

- These events are the ones the chat panel already receives. The server sends them only to sessions that can read those chats. Guests have no Office and never reach it.
- So the box shows only text this viewer can already read in the chat log.
- `role: "user"` is a person's message: from the web, Discord or Telegram, or a button click. `role: "agent"` is the agent's delivered reply. `role: "status"` is never shown.
- A message replayed on reconnect, or a poll's catch-up, is not news. Only a message stamped within the last 90 s on the server's clock starts or ends a conversation. The page already tracks that clock through the stream's `clock` events.

**Share links never show message text.**

- The share's `/o/<t>/state` gains `talk`: `{ now, items: [{ instance, kind: "heard" | "answered", at }] }`. It covers only the people the share shows, and only events from the last 2 minutes.
- `talk` carries no sender, no text and no ids. The host keeps the last heard/answered time per instance, in memory only.
- The share page draws the box with the agent's portrait and a faceless visitor, "Someone". The lines are "Received a message", "Working…" and "Replied".
- A page that doesn't know `talk` ignores it.

## Pack format (optional)

```json
"portraits": {
  "default": "portraits/agent.png",
  "byInstance": { "atlas": "portraits/atlas.png" },
  "byUser":     { "discord:123456789": "portraits/owner.png" },
  "npc":        { "npc-elder": "portraits/elder.png" }
},
"dialogBox": { "frame": "ui/box.png", "slice": 12, "background": "#2b1d14", "border": "#c8a165", "text": "#f6ead7", "name": "#ffd27a" }
```

**Portraits.**

- A PORTRAIT is a file name, or expressions by state: `{ "idle": …, "working": …, "needs": … }`, with at least one of them. A missing state falls back to `idle`, then to any one given.
- Portraits are transparent PNGs, at most 1024 × 1536 px. They are drawn bottom-anchored and scaled to the box.
- `byInstance` keys are instance names (at most 500). `byUser` keys are `adapter:id`, as the chat records a person's account (at most 200). `npc` keys are furniture ids the pack defines (at most 128): an NPC's face for the day an NPC speaks.
- `default` is for agents only. A person with no `byUser` portrait is drawn as their initial.

**dialogBox.**

- `frame` is a 9-slice picture, at most 512 × 512 px, with `slice` image px on each side (1–128, default 8).
- The colours are `#rrggbb`. Each is optional, and each defaults to the dashboard's tokens.

**Checks.** Both live in `fleet-office-pack.js`, which the page and the host share.

- The check is strict, as for the rest of a pack: an unknown key, a bad name or a file the pack doesn't send refuses the upload, and says where.
- The host also checks the portrait and frame sizes.

**Loading.** Portraits and the frame are loaded lazily, the first time the box needs one. An Office with the toggle off never fetches them.

**Fallback, in order:**

- **For an agent:** the pack's `byInstance`, then the pack's `default`, then the agent's identity/chat avatar (`avatarOf`: the identity-card picture, a bot avatar or a persona emoji), then its initial.
- **For a person:** the pack's `byUser`, then their initial.
- A face that isn't a portrait is drawn in a square frame where the portrait would stand.
- On the share page there are no `/ui/img` avatars, so it uses the pack's portraits, then initials.

**Rolling back.** As with `levels`, a version before this one refuses a pack that has `portraits` or `dialogBox`, and draws it as Desks with a note. Remove the keys, or re-upload without them, before a rollback.

## What the box respects

- **Hide paused and stopped:** a conversation shows only while its agent is drawn in the current office: the single office, or any tile of All offices.
- **Night/sleep:** while the agent is drawn asleep (paused, stopped, or idle in bed at bedtime), its conversation waits in the queue and isn't shown. It shows once the agent wakes to work, or it expires: 3 minutes without a reply.
- **Reduced motion:** no slide, typewriter or fade. The box appears whole and goes at once.
- **Fullscreen:** the box is part of the canvas, so it is there too.

## How it is drawn

The box is drawn on the Office canvas in screen space (CSS px), after the scene. It doesn't pan or zoom with the scene. A new module, `fleet-office-dialogue.js`, does all of it:

- the conversation store: intake, phases, queue, expiry;
- the layout: the box, the portraits, the text wrapped by measuring, CJK included;
- the drawing.

Drawing on the canvas means no new CSS rule. A tab opened before an upgrade keeps its old `app.css` and still draws the new box correctly. That is the SKEW case the lazy Fleet panel meets.

The words are registered by the module itself, as the Office's strings already are. For screen readers, a visually hidden `aria-live="polite"` region (the existing `sr-only` class) says each line once.

## Tests and smoke

- **Unit tests:**
  - the pack check (shape, limits, refusals);
  - fallback order and the store (fresh/stale messages, the queue and +N, expiry, asleep hold);
  - the share `talk` scope (no text, no sender, scope cut, age cut);
  - the toggle off: no listener, and the same draw calls.
- **Smoke (Playwright, `smoke-2861-office-dialogue.mts`):**
  - the dashboard with a person's message and a reply (desk and phone, light and dark, a pack with portraits and Cozy without);
  - the share page ("Received a message", no text in the DOM or in `/state`);
  - reduced motion;
  - SKEW both ways:
    - old shell assets (`app.js`, `app-shell.js`, `app-stream.js`, `app.css`, `instance-nav.js` from the branch tip) with the new Office;
    - the new host with the old Office modules from the branch tip, which ignore `talk`.
