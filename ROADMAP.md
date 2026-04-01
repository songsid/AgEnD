# AgEnD Roadmap

> Last updated: 2026-04-01 (v1.3.0)
> Produced by multi-agent consensus: Claude Code, Codex, Gemini CLI, OpenCode

## Completed (v1.0–v1.3)

- [x] Multi-backend support (Claude Code, Codex, Gemini CLI, OpenCode)
- [x] Multi-channel support (Telegram, Discord)
- [x] Fleet orchestration (persistent project instances)
- [x] Cross-instance delegation (send_to_instance, delegate_task, report_result)
- [x] Cron scheduling
- [x] Cost guard with daily limits
- [x] Context rotation (auto-refresh stale sessions)
- [x] `/sysinfo` fleet diagnostics
- [x] `safeHandler` async error boundaries
- [x] FleetManager modularization (RoutingEngine, InstanceLifecycle, TopicArchiver, StatuslineWatcher, OutboundHandlers)
- [x] IPC socket hardening (umask TOCTOU fix)
- [x] Platform-agnostic core (all Telegram/Discord specifics in adapters)

---

## Phase 1: Observability & Dashboard

**Goal:** Make fleet operations visible without leaving the browser.

### 1.1 REST API expansion
Extend the existing health server into a full fleet API:
- `GET /api/fleet` — getSysInfo() JSON
- `GET /api/instances/:name` — instance details, logs, cost
- `GET /api/events` — EventLog query (cost snapshots, rotations, hangs)
- `GET /api/cost/timeline` — cost trend data for charting
- `POST /api/instances/:name/restart` — trigger restart

**Effort:** ~200 lines. Data already exists in EventLog (SQLite) and getSysInfo().

### 1.2 Cost analytics dashboard (MVP)
Lightweight web UI served from the daemon:
- Cost trend chart per instance (data from EventLog cost_snapshot)
- Fleet status board (instance list with status/IPC/cost/rate limits)
- Real-time updates via SSE or WebSocket

**Tech stack:** Static HTML + Chart.js, served by health server. No framework needed for MVP.

### 1.3 Task timeline & error viewer
- Task dispatch/completion timeline
- Error log viewer with safeHandler context labels
- Schedule execution history

---

## Phase 2: Engineering Workflow Integration

**Goal:** Make AgEnD part of real engineering workflows, not just a chat tool.

### 2.1 GitHub / GitLab integration
- Trigger agent tasks from issues, PRs, or webhooks
- Report results back as PR comments or issue updates
- Scheduled repo maintenance (nightly triage, dependency updates)

### 2.2 CI/CD hooks
- Fleet as Code — manage instance config via git
- Deploy/update instances via PR merge
- Pre-commit hooks for agent-assisted review

### 2.3 Conversation history & persistence
- Log all inbound/outbound messages to SQLite
- Searchable conversation history per instance
- Cross-session context carry-over

---

## Phase 3: Plugin & Skills System

**Goal:** Let the community extend AgEnD without forking.

### 3.1 Plugin architecture
- Scan `~/.agend/plugins/` for npm packages
- Dynamic `import()` for backend, channel, and tool plugins
- Standard interfaces already exist: `CliBackend`, `ChannelAdapter`, `outboundHandlers` Map

### 3.2 Skills / task templates
- Reusable runbooks (e.g., "security scan", "dependency update", "code review")
- Parameterized task templates with approval flows
- Shareable via npm packages

### 3.3 Policy & permissions
- Per-instance environment/sandbox controls
- Human approval flows for high-risk actions
- Team role-based access control

---

## Phase 4: Ecosystem Expansion

**Goal:** Broaden reach across channels, backends, and use cases.

### 4.1 More channels
- **Slack** (~300-400 lines via Bolt SDK) — enterprise adoption
- **Web Chat** (WebSocket server) — self-hosted control panel
- ChannelAdapter abstraction is proven; new adapters don't touch core code

### 4.2 More backends
- **Aider** (~50-80 lines) — most popular open-source coding agent
- **Cursor Agent** (when CLI mode available)
- **Custom CLI** — document how to implement CliBackend for any tool

### 4.3 Smart backend routing
- Auto-select backend by task type (quick fix → fast model, architecture → strong model)
- Compare cost/latency/success rate across backends
- Routing recommendations based on historical performance

---

## Phase 5: Advanced Operations (Long-term)

### 5.1 Agent swarm coordination
- Automatic task decomposition and delegation
- Agent-to-agent recruitment (code agent → security scan agent → review agent)
- Parallel execution with result aggregation

### 5.2 Fleet-wide knowledge hub
- Shared context across instances (architecture decisions, tech debt, preferences)
- RAG-based retrieval from project documentation
- Learning from past task outcomes

### 5.3 Self-healing fleet
- Auto-restart with model failover on repeated failures
- Rate limit prediction and preemptive backend switching
- Anomaly detection on cost/latency patterns

### 5.4 Control Plane / Data Plane separation
- Data Plane (local): daemon runs near code and secrets
- Control Plane (optional cloud): cross-machine discovery, global scheduling, unified monitoring

---

## Explicitly Deferred

| Direction | Reason |
|-----------|--------|
| Agent marketplace | Ecosystem not mature enough; needs plugin system first |
| Multi-machine distributed fleet | Architecture change too large; focus on single-machine excellence first |
| LINE channel | Complex API, limited global market |
| Native desktop app | High dev cost; web UI covers the need |

---

## Product Positioning

> **AgEnD is not another coding agent. It's the operations layer that makes coding agents work as a team.**

- Backend-agnostic: works with any coding CLI
- Channel-native: Telegram/Discord as human-in-the-loop control plane
- Persistent instances: one instance per project/repo, not throwaway chat threads
- Fleet coordination: delegate, schedule, monitor, and control across projects and backends
