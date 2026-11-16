# A colleague's own Codex or Claude answering Hub @mentions, without a Fleet (M-3159)

Status: evaluation note for the owner's decision. Nothing is built and nothing was run. Facts come from a source
survey of `release/2.3.5-alpha` at `93c6e9fb7` and from Cairn, who knows the Runtime. Written with Cairn.

## 1. The question

The owner wants a colleague's own Codex or Claude to answer when it is @mentioned on the Hub, without that colleague
installing a full Fleet. An MCP connection (`hub-mcp-agent.md`) cannot do it: the Hub cannot push a question into a
desktop app, so that design can only offer "answers when connected". The idea here: pair the 2.4 **Runtime** to the
Hub instead of to a Fleet, and have the Hub run one turn on the colleague's computer for each @mention.

## 2. Recommendation

**Yes, build it on the Runtime, paired directly to the Hub, in its one-question-at-a-time mode only.**

- The Runtime is already the small piece the owner is asking for: a runner on the person's computer that dials out,
  runs the person's own CLI with the person's own login, and needs no Fleet, no chat platform and no tmux.
- Its one-shot mode runs each question as a separate, unattended CLI run that cannot ask for approval. That is the
  right shape for "nobody is there to approve".
- The Hub does not have the receiving side. That is the real work, and Cairn's judgment is that the largest part is
  the turn owner and answer handling, which a Fleet supplies today. It is a feature-sized build, not a setting.
- **Two limits the owner should know before deciding**: the Runtime runs on **Windows only** today, and it needs the
  Hub to have a **certificate the computer trusts**, the same precondition as the MCP design. The pilot's
  self-signed Hub will not work.

For users this should have one plain name. Proposed: **Personal agent** / 「個人 Agent」: "an agent that runs on
your own computer and answers with your own Codex or Claude".

Not recommended: a web-only Fleet with one agent. Cairn notes it would be the faster prototype, because the
controller already exists, but it is still a whole Fleet with a General and a daemon, which is the "slim
single-agent AgEnD" the owner ruled out on 2026-11-13.

## 3. What can be reused, and what is missing

| Piece | Today | For a Hub-paired personal agent |
|---|---|---|
| Runner on the person's computer | Exists. Dials out over a secure WebSocket, keeps a machine credential, restarts at sign-in | Reuse as it is |
| Running one question | Exists: one CLI process per question, with a time limit (5 minutes) and one at a time per computer | Reuse |
| The person's own CLI login | Exists: uses the Windows user's Codex or Claude login; refuses if signed out; never falls back to someone else's account | Reuse. The person's own AI quota pays |
| Install | Exists: one PowerShell command, hash-checked, no administrator rights, needs Node already installed | Reuse; the Hub must serve it |
| Version report | Exists: version, build and capabilities on connect | Reuse |
| **Receiving side on the Hub** | Missing. Only a Fleet accepts a Runtime | New: the Hub hosts the connection |
| **Pairing** | Pairing is approved by a Fleet administrator | New: the person's company sign-in is the approval, within what the Hub administrator allows |
| **Agent record** | A Hub agent always belongs to a paired Fleet | New kind: an agent that belongs to a person and a computer |
| **Turn runner** | The Fleet decides when to run, tracks the turn, and collects the answer | New on the Hub. Largest piece (Cairn) |
| **Answer return** | Hub answers come back through a Fleet tool. The one-shot run reports output and a finished status, not "the final answer" as such | New: take the finished run's output as the answer. Needs a small trial to confirm it is clean for both CLIs |
| **Delivery proof** | The Runtime keeps a job journal; the Hub tracks room deliveries | New: join the two, so a question is never run twice and a lost one shows "No answer" |
| **Approvals** | Long-lived sessions show permission cards that wait for a person | Not needed in one-shot mode. Needed only if long-lived sessions are added later |
| **Updates** | Self-updates from the Fleet it is paired with | Conflicts with a rule; see section 6 |

The hand-off tracking from #3944 helps the long-lived session path (it knows whether a queued message was taken). It
does not extract answers, so it matters for a later phase, not the first.

## 4. Running with nobody there

One-shot mode is unattended by design. Proposed rules, all of which exist as CLI settings today except where marked:

- **No enforced sandbox, no Codex (M-3224).** On a Windows computer where Codex's sandbox cannot enforce the
  one-folder rule, Codex is shown as unavailable for a personal agent, with the reason; nothing is installed or
  changed on the computer to make it work. Claude stays eligible there, because its configuration has no shell.
  Proven so far (hosted runner, 2026-11-16, #4046): Windows 11 Enterprise 10.0.26200 on **ARM64**, Codex 0.167.0,
  Claude Code 2.1.325; the shared folder reads, and reads outside it, writes and network from commands are
  refused. **Not yet proven: x64**, which is what colleagues' computers are, and a real model turn with a real
  sign-in. The install page states a version only after it is proven.
- **Read-only.** Codex runs in its read-only sandbox. Claude runs with read tools only and permission prompts off.
  Anything that would need approval is refused, not queued.
- **One folder.** The agent sees one folder the person chooses. The installer creates an empty default
  (`Hub agent` in the person's profile); the person puts in what the agent should know. The home folder, a drive
  root and system folders are refused **(new)**.
- **Nothing of the person's own setup.** Run without the person's connectors, MCP servers, skills and hooks, as the
  room assistant does, so a Hub asker cannot reach the person's mail or drive through their CLI **(to confirm in the
  trial; needed)**.
- **No AgEnD tools.** It answers; it does not post on its own, and it has no way to contact other agents. The
  contact-limit idea needs nothing here.
- **The person's quota, the person's limit.** A daily number of answers set by the person (suggested default: 50)
  **(new)**, plus the usual "who may ask".
- **One at a time, five minutes at most** per question; the rest wait.
- **People ask; agents do not (first version).** A personal agent answers a person's direct question or a
  person's @mention, including a post shown as "person via agent" (M-3118), which counts as that person. An
  @mention written by an agent on its own is not delivered: the owner's quota should not be spent by other
  agents before the daily limit exists. Personal agents are left out of @all, and an @agent in their answer
  starts nothing. Agent-to-agent asks can be opened in phase 2, with the existing chain and rate limits
  (decided with the builder, M-3224).

What this does not protect, plainly:

- **The folder is what you share.** Anyone allowed to ask can get the agent to quote anything in that folder.
- **Claude's read-only setting is a tool list, not an operating-system sandbox** (Cairn). With no shell and no
  connectors the exposure is small, but it is weaker than Codex's sandbox. Pre-launch item.
- **Question text can try to steer the agent.** Read-only and no tools limit the result to a bad answer.
- **A sleeping or switched-off computer does not answer.** The agent shows "answers when connected" and questions
  wait, as in the MCP design.

## 5. Install

- Hub → Agents I share → **Add a personal agent** shows one command, valid for 15 minutes and tied to the signed-in
  person. Running it installs the runner, pairs it to this Hub and creates the default folder.
- **Having Codex or Claude Code run that command is possible** once the Hub serves it: the person pastes "run this"
  into their CLI. It is the same command either way, so this is a convenience, not a second path. It does not sign
  the person in to their CLI and does not install Node; the installer stops with instructions if Node is missing.
- Back on the Hub page the computer appears with the CLIs it found. The person picks Codex or Claude, names the
  agent, writes the one-line description and chooses who may ask, as for any shared agent.
- The Hub administrator decides who may add personal agents, off by default, like the MCP switch.

## 6. Following the Hub's version

- **Seeing versions**: easy. The runner already reports its version, so these computers can appear in the M-3130
  list with the same "Needs update" states.
- **Updating**: today a managed runner updates itself from the controller it is paired with: checked by hash, never
  downgraded, only when idle. Paired to the Hub, that means **the Hub hands program code to colleagues' computers**.
  M-3130 set the opposite rule for Fleets: only published versions, no code from the Hub.
- **Recommendation**: keep the M-3130 rule. Phase 1 does not self-update: the Hub shows "Needs update" and the person
  runs the install command again. Later, the runner updates from a published release, checked against the published
  hash, with the Hub only naming the version. That needs the Runtime published as its own release artifact, which
  does not exist yet.

## 7. Phases

| Phase | What | Size |
|---|---|---|
| 0 | Trial on a test rig (Cairn): a one-shot run with the person's setup switched off gives a clean final answer for Codex and for Claude; confirm the read-only flags and the folder rule | Small |
| 1 | The Hub hosts the Runtime connection. Pairing by company sign-in. The "personal agent" kind. One question, direct or by @mention, runs one turn; the run's output is the answer. States: ready, working, answers when connected. Windows only. Update by re-running the command | Large |
| 2 | Delivery proof and recovery (never run twice, "No answer" with a reason), daily limit, @all handling, these computers on the admin version list and overview | Medium |
| 3 | Updates from a published release. More than one computer per person. Mac and Linux runners | Medium to large |
| Later, only if asked for | A long-lived session that remembers earlier questions. It needs an approval surface on the Hub and the #3944 tracking | Large |

Phase 1 should follow the room features and wait for the Hub's trusted certificate.

## 8. How it sits with the other designs

- **MCP agent** (`hub-mcp-agent.md`): step 1, the app as the person's hands, is unchanged and still useful: it is
  how a desktop user reads and posts. Step 2, the "answers when connected" inbox, becomes the fallback for people
  who cannot run the runner (Mac today). On Windows the personal agent replaces it, because it can be pushed to.
- **Hub General**: unrelated. It runs on the Hub's account, never on a colleague's computer.
- **Contact limits** (`hub-agent-contact-limits.md`): a personal agent is outside every Fleet and has no AgEnD
  tools, so it cannot contact any other agent.

## 9. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| P1 | Build it on the Runtime paired to the Hub? | **Yes.** |
| P2 | Windows only at first? | **Yes, if the colleagues in mind use Windows.** If they are mostly on Mac, this needs a Mac runner first and the order changes. |
| P3 | Read-only, one folder, no approvals? | **Yes.** No long-lived session in the first version. |
| P4 | May the Hub hand the runner its updates? | **No.** Keep "no code from the Hub"; update by re-running the command until a published release exists. |
| P5 | Name | **Personal agent** / 「個人 Agent」. |
| P6 | MCP step 2 (the inbox) | **Hold it** until we know who cannot use a personal agent. |
