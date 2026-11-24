# Hub 1:1 chat: the status line while the agent works (M-3596)

**The problem (the user, 2026-11-24).** A Hub one-to-one chat stayed silent from the moment you asked until the answer arrived. You couldn't tell whether your question was waiting or being worked on.

**Why.** The member fleet records the `delivered` and `consumed` receipts only when the agent answers. That's by design: queue acceptance isn't delivery evidence. The thread's work bar only read group-room answer rows. So a 1:1 question had nothing to show.

**What it shows now.** A 1:1 chat has the Fleet chat's work bar for your own question, live:

| State | Words (en / zh-TW) |
|---|---|
| Waiting behind another question | "Waiting: Notes is answering another question first" (or "has N questions to answer first") / 「等待中：Notes 正在先回答另一個問題」 |
| Busy | "Waiting: Notes is busy with other work" / 「等待中：Notes 正在處理其他工作」 |
| Paused / offline | "Waiting: Notes is paused; it gets your question when it resumes" / "…is offline; it gets your question when it's back" |
| Sent, not started | "Sent to Notes; waiting for it to start" / 「已送給 Notes，等它開始處理」 |
| Working | "Notes is working on it" with the time since it got the question / 「Notes 正在處理」 |
| Answered | the answer replaces the bar |

**Where it comes from.** Everything is Hub-side; there is no member or protocol change, and receipts stay evidence-only.

- **Working:** the Hub's own `begin` lease. The member asks for it right before handing the question to the agent. Its time is the lease's issue time.
- **Ahead:** a count of earlier open questions to the same agent. It's a count only, never whose or what.
- **Busy / paused:** the agent's reported `agent.state`, which members already send for every shared agent.
- **Live:** a begin lease pushes the question's answer row to its asker, and a state change pushes `room.changed`.

## Captures

These come from the real Hub (HTTPS and SQLite from the test rig) and its real UI, headless Chromium, with made-up people: Hub Admin asks, Bea Sample asked first, and the agent is Notes.

| View | 1 behind | 2 busy | 3 working | 4 answered | before (same moment as 3) |
|---|---|---|---|---|---|
| Desk, zh-TW, light | `desk-zh-TW-light-after-1-behind.png` | `…-2-busy.png` | `…-3-working.png` | `…-4-answered.png` | `desk-zh-TW-light-before-3-working.png` (no bar) |
| Phone, zh-TW, dark | `phone-zh-TW-dark-after-1-behind.png` | `…-2-busy.png` | `…-3-working.png` | `…-4-answered.png` | `phone-zh-TW-dark-before-3-working.png` |
| Desk, en, dark | `desk-en-dark-after-1-behind.png` | `…-2-busy.png` | `…-3-working.png` | `…-4-answered.png` | `desk-en-dark-before-3-working.png` |
| Phone, en, light | `phone-en-light-after-1-behind.png` | `…-2-busy.png` | `…-3-working.png` | `…-4-answered.png` | `phone-en-light-before-3-working.png` |

Step 3 arrives live: the begin lease is sent while the page is open, and the bar turns to working without a reload.

**Checks recorded by the rig (all four views):**
- **Behind:** the waiting bar with "another question first".
- **Busy:** the waiting bar with "busy".
- **Working:** the working bar with elapsed time (0:02).
- **Answered:** no bar.
- **Before (the base branch):** no bar at any step.
