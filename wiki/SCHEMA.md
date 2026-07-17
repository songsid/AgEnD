# AgEnD Wiki Schema

This wiki documents the **AgEnD** project — a fleet orchestration layer for coding agents. It tracks architecture decisions, version changes, design documents, and operational knowledge.

## Wiki location

- Wiki root: `wiki/`
- Raw sources: `raw/`
- Asset/image storage: `raw/assets/`

## Page types

- `source` (in `wiki/sources/`) — one summary page per ingested source (changelog entry, design doc, etc.)
- `entity` (in `wiki/entities/`) — specific things: features, commands, modules, config options, backends
- `concept` (in `wiki/concepts/`) — ideas, patterns, architectural decisions, design principles
- `synthesis` (in `wiki/synthesis/`) — cross-cutting analyses, version comparisons, migration guides

## Tag taxonomy

- `architecture` — system architecture and design patterns
- `feature` — feature descriptions and capabilities
- `bugfix` — bug fixes and their root causes
- `version` — version-specific changes
- `config` — configuration options and fleet.yaml
- `command` — slash commands and CLI commands
- `backend` — CLI backend integration (claude-code, codex, gemini, kiro, etc.)
- `telegram` — Telegram-specific features
- `discord` — Discord-specific features
- `fleet` — fleet management and orchestration
- `security` — permissions, access control, safety
- `performance` — optimization and resource usage

## Page sizing

- Soft cap: 400 lines / ~2,000 words.
- Hard cap: 800 lines.

## Page mutability rules

- `sources/` — **immutable** after ingestion. Raw summaries of original material; never edited after initial write.
- `entities/` and `concepts/` — **living pages**. The single source of truth for active knowledge; continuously updated as new sources arrive.
- `synthesis/` — **living pages**. Cross-cutting analyses that evolve with the wiki.

## Frontmatter requirements

Every page must have: `type`, `title`, `tags`, `created`, `updated`

Plus type-specific:
- `source` pages: `version` (if version-related), `raw`, `ingested`
- Non-source pages: `sources` listing the source-summary pages drawn from
- `source_version` (recommended on concepts/entities): the AgEnD version this page was last synthesized against (e.g. `v2.0.7`)
- `code_refs` (recommended on concepts): list of relevant source files/symbols (e.g. `["src/cost-guard.ts", "src/fleet-manager.ts#handleOutboundFromInstance"]`)

## Index structure

Currently flat: a single `wiki/index.md` listing all pages.

## Workflow customizations

- Sources are primarily from the AgEnD repo: CHANGELOG.md, docs/, soul.md, commit history
- Version-based ingestion: each version's changes become a source page
- Design docs get their own source page + may spawn entity/concept pages
- Use zh-TW for page content when the source is in Chinese; English for code-derived content

## Lint cadence

- Structural lint: after every 5 ingests
- Semantic lint: weekly (triggered by 09:00 daily schedule)
