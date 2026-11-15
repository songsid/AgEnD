# The AgEnD connector: one extension point for every agent and desktop app (M-3185)

Status: second draft. On 2026-11-15 the owner chose the direction after comparing OpenClaw and Manus: a module is
its own MCP server process behind the connector, skills stay as SKILL.md, listing is static, sources are ours first
and curated later, approvals and isolation are AgEnD's own. Nothing is built.

Facts about today's server come from a source
survey of `release/2.3.5-alpha` at `616e8f75d` and from Sentinel's narrow source checks for M-3184 (the full audit
has not run), and from Cairn's M-3183 work (draft #4004, not yet merged).

## 0. The idea in one paragraph

Every agent in a Fleet already talks to one AgEnD program, whatever its CLI: the AgEnD connector (our MCP server).
Today a new ability, such as reading SharePoint files or using a browser, is installed into each CLI separately, so
it works on some backends and not others, and nobody can see or control it from AgEnD. The design: a new ability
is a **module**, an ordinary MCP server that runs as its own process **behind** the connector. The connector
becomes a gateway: agents still see one connector, and it passes each call to the right module. A module is
installed once with AgEnD, switched on per agent in Settings, works the same on every backend, asks for approval
through AgEnD, and can also be reached by a person's desktop Claude or Codex app through the same connector.

Names used here: **AgEnD connector** / 「AgEnD 連接器」, **module** / 「模組」.

## 1. Today's connector (survey)

| Topic | Today |
|---|---|
| Shape | One small stdio program per CLI process (`src/channel/mcp-server.ts`). It holds no tool logic; it forwards each call over the agent's local socket to the Fleet process, which checks permission and runs the handler |
| Who is calling | Known from which agent's socket the call arrived on. The agent cannot claim to be another agent |
| Registration | AgEnD writes the connector into each CLI's own configuration at launch: seven backends, seven different files and wrappers (Claude Code, Codex, Grok, Muse, Kiro, OpenCode, Antigravity) |
| Tools | 83, in one registry (`src/channel/mcp-tools.ts`) |
| Tool sets | `full` 83, `coordinator` 83, `general` 81, `worker` 63 (the default), `standard` 54, `minimal` 9. Set per agent (`instances.<name>.tool_set`) or as the Fleet default |
| Feature switches | Five "dashboard access" switches (appearance, task board, web settings, office, office packs) hide a group of tools and also refuse them. This is the nearest thing to a module today |
| Listing, on alpha today | **Waits on live state.** Each listing asks the Fleet process whether the Hub is available (`hub_room_status`), with a 45-second limit, and drops the four Hub tools if not. At startup this could outlast a CLI's own deadline |
| Listing, with M-3183 (#4004, draft) | Built at once from the tool registry, the agent's tool set and its dashboard switches, with no Hub lookup. Hub tools the agent is allowed stay listed; a call refuses clearly if the Fleet is not connected. Measured: 2.9 to 8.8 ms, even while a Hub status request is left hanging. The `worker` list is 63 tools, 70,100 bytes in Cairn's run. Sentinel's M-3184 packet (#4007) measured 55 definitions, 57,747 bytes, identical with no Hub, a Hub up and a Hub silently down, and a listing in about 2 ms; why the two counts differ is not yet reconciled. Bytes, not tokens |
| List changes | Re-announced when the socket drops or returns and when a dashboard switch changes; with M-3183, no longer when the Hub state changes. Which CLIs pick up a change mid-session is not measured (Claude Code is known to need the announcement after a timeout) |
| On-demand loading | None. No "find a tool" mechanism of our own |
| Approvals | No general flow. A few tools return "pending" and wait for an administrator's yes in General or in the web's Needs you list (Windows agent create and settings, Kiro migration). They do not hold the call open (Sentinel). The chat adapters have an unused approval method. Claude Code runs with its own permission prompts switched off |
| Other ways to extend | Bundled skills (22), published per backend into each agent's skills folder by role. A person's own skills and MCP servers reach an agent only by accident of each CLI's configuration; AgEnD has no setting for them |
| For outside apps | Nothing. No HTTP connector, no app sign-in. `hub-mcp-agent.md` (M-3158) proposes one on the Hub |
| Browser, computer use | Nothing in AgEnD. SharePoint exists only as a skill in one person's own Claude folder |

**Context cost per backend.** Measured once, on 2026-10-31, by capturing requests; versions have moved since, and
M-3184 does not cover token size, so these need re-measuring before any number is promised:

| Backend | What reaches the model |
|---|---|
| Claude Code | Tool descriptions are deferred: the model looks a tool up when it needs it |
| Codex, catalog models | Deferred. With a custom provider or an unknown model: every description on every request (77 KB for `full`, 60 KB for `worker` at the time) |
| Grok | Deferred |
| Muse | **Everything, every request**: about 84 KB at the time. No switch found to defer |
| Kiro, Antigravity, OpenCode | Not measured |

So adding modules costs nothing in context on three backends and costs every request on Muse and on any backend
that behaves like it.

## 2. Module model

**A module is an MCP server in its own process, plus a manifest.** MCP is the module interface (the Manus-style
standard), so a module can be one we write or an existing MCP server we wrap. Modules are not code loaded into the
Fleet process (the OpenClaw style): a module that crashes or hangs fails one call.

```
agent's CLI ── connector (stdio, per agent) ── Fleet process = gateway ──┬─ Core and Hub tools (inside the gateway)
                                                                        ├─ module process: SharePoint files
desktop app ── connector (section 7) ─────────┘                         ├─ module process: Browser
                                                                        └─ module process: …
```

### 2.1 The manifest

The manifest is a small file AgEnD reads **without starting the module**. It has two parts.

| Part | Fields | Where it comes from |
|---|---|---|
| **Recorded from the module** | Server name and version; each tool's name, description and input shape; a fingerprint of all of that | Captured by asking the module for its tool list **once**: when we build AgEnD (shipped modules) or when an administrator adds or updates it (later sources). Never at listing time |
| **Added by AgEnD** | Name and one-line description in EN and zh-TW; how to start it (program and version, fixed); what it needs (a Hub connection, a Microsoft sign-in, a desktop, a platform); risk of each tool (reads only / changes things / needs approval, section 6); which callers each tool serves (section 7); tools left out; default on or off; one process for the Fleet or one per agent; time limits; its skill | Written by us for shipped and catalog modules; chosen by the administrator for a server they add |

How a module's own tool list maps to what an agent sees:

- **Names.** A tool appears as `<module>_<tool>`, for example `browser_open`, so two modules cannot collide and
  logs show where a call went. Core and Hub tools keep today's names.
- **Descriptions and input shapes** are passed through as recorded. The gateway does not rewrite them; for a
  server someone else wrote, an administrator sees them before switching the module on.
- **Left out.** A manifest can leave tools out (a wrapped server often has more than we want). A tool that is not
  in the manifest does not exist for agents, whatever the module says.
- **Every tool must have a risk.** For a shipped module the build fails if one is missing. For a server an
  administrator adds, an unclassified tool is "needs approval each time" until they choose.

### 2.2 Core and Hub stay inside the gateway

Today's 83 tools, the four Hub tools among them, are Fleet functions: they act on the Fleet's own state and its Hub
link. They stay in the Fleet process, described by the same kind of manifest so that listing, Settings and
approvals treat everything alike. Moving them into separate processes would add risk and gain nothing. "A module
is a process" applies to everything new.

### 2.3 The gateway: routing

1. The agent calls a tool on its connector. The connector forwards it to the Fleet process, as today.
2. The gateway finds the tool in the manifests and checks, in this order: the caller is who its socket says; the
   module is on for this agent and not off for the Fleet; the agent's tool set and switches allow it; the module's
   needs are met; the tool's approval rule (section 6).
3. It passes the call to the module's process, starting it if needed, with the caller's identity attached by the
   gateway. The module never learns identity from the agent, and never sees another module.
4. The result goes back the same way. The log records the agent, the module, the real tool and the outcome.

These checks run in the gateway for every way in, including "find on demand" (section 5) and desktop apps
(section 7). A hidden tool is not a refused tool; the gateway refuses (Sentinel).

**One process or several.** The manifest says which: **one for the Fleet** when the module keeps nothing per
agent (SharePoint files), or **one per agent** when it does (a browser, with each agent's own profile and
sign-ins). Calls to one process run one at a time unless the manifest allows more.

### 2.4 Starting, stopping, restarting

| Rule | Proposed value |
|---|---|
| **Lazy start** | A module process starts on the first call that needs it, never at Fleet start and never for listing |
| Start limit | 20 seconds to start and answer the opening handshake; otherwise the call fails with "could not start" |
| **Idle stop** | Stopped after 10 minutes with no call; the next call starts it again |
| **Crash** | Calls in progress end with a clear failure. The next call starts a fresh process |
| Repeated failure | 3 failed starts or crashes within 5 minutes: the module shows **Not working** in Settings, calls are refused at once with that reason, and it is tried again after 5 minutes or when an administrator presses **Try again** |
| **Its own restart** | Restarting or stopping one module does not restart the Fleet, the agents or other modules |
| **Its own update** | A module's version can change while the Fleet runs: the gateway waits until the module is idle, swaps the process and the manifest together, and announces the new tool list. Shipped modules change version with an AgEnD release at first; the catalog (section 2.6) lets one module move between releases |
| Fleet stop or update | Module processes stop with the Fleet and are started again on demand |

### 2.5 Time limits

Two limits exist today that the gateway must stay inside: the connector gives up after 45 seconds, and Codex gives
a tool 90 seconds.

- **A call answers within 30 seconds.** If the module has finished, the agent gets the result.
- **If it has not**, the agent gets "Still working. The result will arrive as a message.", and the result is
  delivered to the agent when it is ready, the same route an approved action uses (section 6).
- **Hard limit** per call, from the manifest: 5 minutes by default, 30 at most. At the limit the gateway asks the
  module to cancel, waits 5 seconds, then stops the process.
- **What the agent is told** depends on the tool's risk. A read: "Timed out. Nothing was changed." A tool that
  changes things: "Timed out. It may have partly happened; check before trying again."

### 2.6 Catching drift between the manifest and the module

The manifest is a recording, so the module can come to differ from it: a wrong version on disk, a server that
changes its tools after an update, or a server that changes them on purpose. A changed description matters as
much as a changed tool, because the model reads it.

| When | Check | If it differs |
|---|---|---|
| **Building AgEnD** | A test starts every shipped module and compares its live tool list with the manifest | The build fails. A shipped module cannot reach users out of step |
| **Each process start** (not at listing) | After the handshake the gateway asks the module for its tool list and server version, and compares the fingerprint with the manifest | **Shipped or catalog module**: it does not run; it shows "Not working: does not match this AgEnD version", and the log has the difference. **Added by an administrator**: the module is paused and the administrator sees what changed (new, removed and changed tools, with the old and new descriptions) and chooses **Accept** or **Keep off**. Nothing is accepted on its own |
| **Each call** | The tool must be in the manifest | Refused by the gateway. The module is not asked |
| **While running** | The module announces that its tools changed, or answers "no such tool" for one the manifest has | Treated as a start check: compare, then the same outcomes |
| **Before starting** | The program on disk matches the fixed version and file hash in the manifest | It is not started |

Listing still never asks a module. If a start check fails after the list was shown, the agent has tools that now
answer "Not available: this module is not working"; the list does not change under it.

### 2.7 Where modules come from

1. **Shipped with AgEnD** (now). We write or wrap them, test them, and record their manifests at build time.
2. **A curated catalog** (later, like Manus's): a list we maintain and ship, each entry an exact version with its
   hash and a manifest we recorded and classified. An administrator picks from it; installing fetches that one
   published version.
3. **A server an administrator adds** (later still): any MCP server, by exact version. Fleet administrators only.
   Its manifest is recorded when it is added, and every tool starts as "needs approval each time".

No open marketplace, and no module or manifest sent from the Hub. A wrapped server someone else wrote runs their
code under the Fleet's OS account in all three cases; the catalog only means we looked at that version.

### 2.8 First modules

| Module | What it gives an agent | Runs as | Default | Notes |
|---|---|---|---|---|
| **Core** | Today's AgEnD tools: reply, messaging, tasks, schedules, decisions | Inside the gateway | Always on | Still shaped by the agent's tool set |
| **Hub** | The four Hub room tools that exist (M-3118) | Inside the gateway | On when the Fleet is connected to a Hub | Listing already fixed by M-3183 |
| **SharePoint files** | List, read (including protected Excel), download, see who a file is shared with | One process for the Fleet | Off | Today a skill for one CLI. Needs a Microsoft sign-in, approved through AgEnD |
| **Browser** | Open a page, read it, click, fill in, take a picture | One process per agent | Off | A wrapped existing browser server is the likely start; own profile per agent |
| **Computer use** | See and operate the desktop of the AgEnD computer, or of a paired Windows computer | One process per agent | Off | The riskiest. Needs its own short design first |

Today's five dashboard switches are modules in all but name. They move into the same list later, so there is one
place to look.

### 2.9 Skills

Skills stay as they are: a `SKILL.md`, published into each agent's skills folder, which the CLI brings into
context only when it is relevant (as OpenClaw and Claude do). A skill is text that teaches; the module is the
ability. A module's manifest can name one skill, and AgEnD's existing publisher gives it only to agents that have
the module on. For a backend with no skills folder, the same short text is what `agend_find_tool` returns with the
module's tools (section 5).

### 2.10 What process isolation is, and is not

- It **is** protection against a crash, a hang or a memory leak in one module, and it lets one module restart or
  update alone.
- It is **not** a sandbox. A module process runs under the Fleet's OS account and can read what that account can
  read. The gateway starts it with a minimal environment (no Fleet secrets, its own data folder), which limits
  accidents, not intent. An operating-system sandbox for modules belongs on the pre-launch list.

## 3. The tool list: fixed and fast

The M-3183 lesson, as a rule: **listing tools never waits on anything.**

- The list is built from two things only: the module manifests on disk, and the agent's saved settings. Both are
  there when the connector starts.
- Listing does not ask the Fleet process, the Hub, a module process or the network, and does not start a module.
- A module that is switched on but cannot work right now **stays listed**. Calling its tool returns "not
  available" with the reason, for example: "Not available: this Fleet is not connected to a Hub." The agent can
  say so in its answer. This is what M-3183 already does for the Hub tools; the module model makes it the rule
  for every module.
- The list changes only when a person changes the agent's modules in Settings. The connector announces the change;
  a CLI that does not pick it up mid-session gets it at the agent's next restart, and Settings says so.
- A manifest that cannot be read leaves the rest of the list untouched, and Settings shows that module as "Not
  working".

What this costs: an agent sometimes sees a tool it cannot use at that moment, and spends one call to find out.
That is cheaper than a list that can hang or change under the model.

## 4. Choosing modules per agent

Where: Settings → an agent → Workspace → the existing **Tools & modes** card gets a **Modules** list. The Fleet
default sits beside the default tool set in Settings.

| | EN | zh-TW |
|---|---|---|
| Heading | Modules | 模組 |
| Hint | Extra abilities for this agent. They work the same on every AI backend. | 這個 Agent 的額外能力。不論使用哪一種 AI，用法都一樣。 |
| Row | **SharePoint files**: read files on the company SharePoint. | **SharePoint 檔案**：讀取公司 SharePoint 上的檔案。 |
| Row state, working | On | 已開啟 |
| Row state, something missing | On · Needs a Microsoft sign-in | 已開啟 · 需要登入 Microsoft |
| Row state, off by the Fleet | Off for this Fleet | 這個 Fleet 已關閉 |
| Row state, failing (section 2.4) | Not working · Try again | 無法運作 · 再試一次 |
| Row state, changed (section 2.6) | Changed since it was added · Review | 加入後內容有變動 · 檢視 |
| After a change, when a restart is needed | Applies when this agent restarts. | 這個 Agent 重新啟動後生效。 |
| Fleet default hint | New agents start with these modules. | 新的 Agent 會從這些模組開始。 |

- **Basics on by default**: Core always; Hub when the Fleet is connected to one. Everything that reaches outside
  the Fleet (SharePoint, Browser, Computer use, anything from the catalog) is off until someone switches it on.
- A module with a missing need shows what is missing, with the one action that fixes it.
- A Fleet administrator can switch a module off for the whole Fleet; agents then cannot turn it on.
- Agents shared on a Hub: modules that reach outside are **off while the agent answers a Hub question**, unless
  its owner ticks otherwise. Same reasoning as the contact limit (`hub-agent-contact-limits.md`): a Hub asker
  should not be able to drive the owner's browser or SharePoint through a shared agent.

## 5. Context cost: load on demand where the CLI does not

Two ways to show tools to a model:

- **All listed**: every tool with its full description. Right for CLIs that defer on their own (Claude Code,
  Codex catalog models, Grok): they already load a description only when needed.
- **Find on demand**: the list holds the everyday tools in full, plus two small tools:
  - `agend_find_tool`: "what can I do about X?" returns matching tools with their descriptions.
  - `agend_use_tool`: runs one of them by name.

  A short index, one line per switched-on module, goes into the connector's opening instructions so the model
  knows what exists.

Proposed rule:

| Backend | Default |
|---|---|
| Claude Code, Codex with a catalog model, Grok | All listed |
| Muse, Codex with a custom model, and any backend not yet measured | Find on demand |

- "Everyday tools" are the ones an agent needs on almost every turn (reply, messaging, reporting a result, the
  task board). Starting point: today's `minimal` set plus reporting and tasks. Target for Muse: from about 84 KB
  per request to under 15 KB. To be measured, not assumed.
- Per agent, under Advanced: **How tools are shown** / 「工具的顯示方式」: Automatic / All listed / Find on demand
  (自動 / 全部列出 / 需要時再找). Automatic follows the table.
- Both ways use the same fixed manifests, so the listing rule in section 3 holds for both.

What this costs:

- One extra step the first time an agent uses a module tool, and a model can fail to look for a tool it would
  have used had it been listed. Core tools stay listed for that reason.
- The CLI no longer checks the input shape; the connector must, and must return a readable error.
- Any per-tool view in the CLI shows only "agend_use_tool". AgEnD's own log must name the real tool.
- `agend_use_tool` must run the real tool's own caller and permission checks, not a check on the wrapper (Cairn).
  Cairn sees no blocker in our own path, but it is unproven, and Muse's and Kiro's limits are unknown: card 1e
  starts with a trial.

## 6. Approvals through AgEnD

Why AgEnD's own flow: agents run unattended, Claude Code runs with its own prompts off, and each CLI asks
differently. A module tool marked "needs approval" is approved in one place, the same way on every backend.

**How it works**

1. The agent calls the tool. It returns at once: "Waiting for approval. You will get the result as a message."
   The call is not held open (the existing pattern, per Sentinel).
2. A request appears in the web's **Needs you** list and as a message with buttons in the Fleet's Discord or
   Telegram General. It shows the agent, the module, and exactly what will happen, in plain words.
3. A Fleet administrator presses a button. The press must come from a verified person, as for other go-aheads.
4. On **Approve**, AgEnD runs exactly what was shown and sends the result to the agent as a message. The agent
   does not call again, so what was approved is what runs.
5. On **Don't allow**, or after 30 minutes with no answer, the agent is told so and can say so.

| | EN | zh-TW |
|---|---|---|
| Title | {agent} wants to use {module} | {agent} 想使用 {module} |
| Detail, example | Open `https://example.com/report` in the browser and read the page. | 用瀏覽器開啟 `https://example.com/report` 並讀取頁面。 |
| Buttons | Approve once · Always allow for this agent · Don't allow | 同意這一次 · 這個 Agent 一律同意 · 不同意 |
| Expired | Not approved in time. Nothing was done. | 沒有在時間內同意，沒有執行任何動作。 |

**Three approval shapes**, chosen by the module for each tool:

- **Each time**: one request per action. For rare, weighty actions (sending a file out, changing sharing).
- **Always allow, within a scope**: the administrator's "always" is remembered for that agent and that scope,
  such as one website or one SharePoint site. Listed in Settings, removable there.
- **A session**: for computer use and long browser tasks, where a request per click is unusable. "Let {agent}
  control the desktop for this task, up to 30 minutes", with a Stop button while it runs.

**Signing in is an approval too.** SharePoint needs a Microsoft sign-in code. Today the agent prints the code in
chat. As a module, the same Needs you request carries the code and the link, and the person signs in on their own
device.

What this costs, plainly:

- **Approval fatigue.** Too many requests train people to press Approve. Hence "always allow" scopes and sessions,
  and reads that need no approval at all.
- **"Always allow" is a standing permission.** Text an agent reads on a web page or in a file can then steer it
  within that scope without anyone being asked.
- **A session is trust for its whole length.** During a computer-use session the agent can do anything the
  desktop account can do.
- **One account for all.** A module signed in as the Fleet owner acts as the owner for every agent that has it.
  An agent with SharePoint reads what the owner can read.

## 7. Desktop Claude and Codex apps on the same connector

One connector, three ways in. The module manifest says which callers each tool serves.

| Way in | Who the caller is | What it reaches | Transport |
|---|---|---|---|
| A Fleet agent (today) | The agent, known by its socket | Core and the agent's modules | Local stdio |
| A person's app, to their own Fleet | The signed-in Fleet person | "Talk to my agents": list them, send a message, read the answer, see the task board. Modules marked for apps | On the AgEnD computer: a local command the app runs, no network. From another computer: the Fleet's web address, with the web sign-in |
| A person's app, to the Hub | The signed-in company person | The **Hub module** as a person: rooms, asking shared agents, people search | The Hub's address, with company sign-in |

**How `hub-mcp-agent.md` folds in.** Its step 1, the app as the person's hands on the Hub, is the third row: the
Hub module with a person as the caller. Everything in that spec about sign-in, consent, "Wang via Codex", the
administrator's and room's switches, limits and costs stands; only the framing changes from "an MCP service on the
Hub" to "the Hub door of the AgEnD connector". Its tools become the Hub module's person-facing tools, and the four
Fleet-agent room tools are the same module's agent-facing tools. Its step 2 (the inbox) stays on hold, as P6 in
`hub-personal-agent.md` recommends.

**The second row is new**, and is the cheaper one to build first: a person's desktop app on the AgEnD computer can
use a local command, which needs no certificate and no network sign-in. It gives the owner's stated goal for
managers ("ask the agents they are authorized to ask") a desktop form without waiting for the Hub's certificate.
Today the connector is stdio only and a caller's identity is the agent's own socket (Cairn). A door for a person
needs its own binding: the signed-in session decides which agents the caller owns or may ask; a name sent by the
app is never trusted.

What an app caller must never get: the tools that let an agent act as the Fleet (create or delete agents, change
settings, approve requests). An app can ask an agent; it cannot be an administrator.

What this costs: the same as section 9 of `hub-mcp-agent.md`. What the app reads leaves to that app's AI
provider; a token on the person's computer acts as them; posts are written by an AI under a person's name.

## 8. What stays as it is

- **Tool sets.** They keep shaping Core. Replacing them with modules is a later clean-up, not a condition.
- **Skills.** Still `SKILL.md`, brought in only when relevant (section 2.9).
- **Each CLI's own MCP servers and tools.** AgEnD does not remove them. The point is that new abilities no longer
  have to be installed there.
- **Personal agents** (`hub-personal-agent.md`): they run with no AgEnD tools, so no modules.

## 9. What the whole design costs

- **One place to fail.** If the connector or the Fleet process is down, every ability is down, on every agent.
  Separate module processes and per-call time limits keep one module from taking the rest with it.
- **Wider reach for every agent.** Today a browser exists only where someone installed it. With modules, any agent
  is one switch away from the browser, SharePoint or the desktop. Defaults are off, the switch is an
  administrator's, and risky tools need approval, but the reach is still wider than today.
- **AgEnD becomes the only gate** where the CLI's own prompts are off. A mistake in our approval flow has no
  second check behind it.
- **We own the modules.** Each module we write is ours to keep working as SharePoint, browsers and desktops
  change. A wrapped server shifts that work to its authors and adds outside code under the Fleet's OS account;
  process isolation does not contain it (section 2.10).
- **Descriptions are instructions to a model.** A wrapped server's tool descriptions reach the model as written.
  Recording them and stopping on any change (section 2.6) is the guard; it depends on someone reading them.
- **More moving parts.** Each module is a process to start, watch and stop. The first call after an idle period
  is slower, and a per-agent module costs memory for each agent that uses it.
- **Find on demand** trades context for an extra step and some missed tools (section 5).

## 10. Phases and cards

| Card | What | Size | Depends on |
|---|---|---|---|
| 1a | Manifest format and the gateway's registry. Core and Hub described by manifests. Listing reads manifests and saved settings only; every check runs in the gateway; a missing need answers "not available" | M | M-3183 |
| 1b | Module processes: lazy start, routing with the caller attached, the 30-second answer and hand-off for long calls, hard limit and cancel, crash and repeated-failure rules, idle stop, per-Fleet and per-agent processes. Proven with a small test module | L | 1a |
| 1c | Drift: manifest recording at build time, the build test, the check at each process start, the version and hash check before starting | M | 1b |
| 1d | Settings: the Modules list per agent and the Fleet default, with the states in section 4 | M | 1a |
| 1e | Measure the catalog per backend (bytes per request, every backend we ship), trial "find on demand" on Muse, then build it with the Automatic rule | M | 1a, M-3184 |
| 2a | Approvals: a stored request, Needs you and chat buttons, run-on-approve, expiry, "always allow" scopes in Settings | L | 1a |
| 3a | SharePoint files module, with sign-in through an approval request. The first new ability on every backend | M | 1b, 1c, 2a |
| 3b | Browser module, wrapping an existing browser server at a fixed version | L | 3a |
| 3c | Computer use: its own design first (session approval, live view, Stop), then the module | L | 2a, 1b |
| 4a | A person's desktop app to their own Fleet, by a local command | M | 1a |
| 4b | The same from another computer, by the Fleet's web address and sign-in | M | 4a |
| 4c | The Hub door: `hub-mcp-agent.md` step 1 as the Hub module for a person | L | 1a, the Hub's trusted certificate |
| 5a | The curated catalog: entries with exact version, hash and our manifest; install, update when idle, remove | L | 1c |
| 5b | A server an administrator adds: record its manifest, classify tools, review on change | L | 5a |
| 6 | Clean-up: dashboard switches become modules; decide whether tool sets do too; an operating-system sandbox for module processes before launch | M | 1d |

Suggested order: 1a → 1b → 1c → 2a → 3a gives the owner one new ability working on every backend, in its own
process, with approvals, which proves the model end to end. 1d and 1e run alongside. 4a can go any time after 1a.

## 11. Open questions, with recommendations

| # | Question | Recommendation |
|---|---|---|
| C1 | What a module is, and where modules come from | **Decided 2026-11-15**: an MCP server in its own process with a manifest. Shipped with AgEnD first; later a curated catalog; servers added by administrators only. No open marketplace. |
| C2 | Which module first? | **SharePoint files.** The skill exists, the need is real, and its sign-in exercises the approval flow. Whether we write it or wrap an existing server is the builder's call after looking at what exists for protected Excel. |
| C3 | A tool whose module cannot work right now: listed and refusing, or hidden? | **Listed and refusing with the reason.** It is what keeps listing fixed and fast. |
| C4 | Who approves? | **Fleet administrators**, on the web and in Discord or Telegram. Not the agent's team lead agent, not another agent. |
| C5 | On approval, does AgEnD run the action, or does the agent call again? | **AgEnD runs it** and sends the result. What was shown is what runs. |
| C6 | "Always allow" scopes? | **Yes**, per agent and per scope, visible and removable in Settings. Without them approvals become noise. |
| C7 | Modules while a shared agent answers a Hub question | **Outside-reaching modules off by default**, owner can allow per agent. |
| C8 | "Find on demand" default | **Automatic by backend**, from measurements; a per-agent override under Advanced. |
| C9 | Desktop apps: which door first? | **The person's own Fleet by local command (4a).** No certificate needed. The Hub door waits for the Hub's certificate. |
| C10 | Do tool sets become modules? | **Not now.** Decide after modules have shipped and the Settings card can be judged as a whole. |
| C11 | The words "connector" and "module" in the product | **Keep both** / 「連接器」「模組」. In Settings the row names carry the meaning ("SharePoint files"), so the words matter little. |
| C12 | Computer use on whose desktop? | **Its own design.** The AgEnD computer is usually a server with no desktop; a paired Windows computer (Runtime) is the likelier target. |
| C13 | Do Core and Hub become separate processes too? | **No.** They are Fleet functions and stay inside the gateway, described by the same manifests. |
| C14 | One process per module, or per agent? | **The manifest decides**: one for the Fleet when nothing is kept per agent, one per agent when it is (browser, computer use). |
| C15 | A server whose tools change after an administrator added it | **Pause it until the administrator reviews the change.** Never accept on its own. A shipped or catalog module that differs does not run at all. |
| C16 | A call that takes longer than a CLI waits | **Answer within 30 seconds; hand off the result as a message.** Hard limit 5 minutes by default, 30 at most. |
| C17 | When does a module update? | **With an AgEnD release at first.** Between releases only once the catalog exists, only to an exact version we listed, and only when the module is idle. |
| C18 | Idle stop | **10 minutes.** Saves memory on a busy host; costs a slower first call afterwards. |
