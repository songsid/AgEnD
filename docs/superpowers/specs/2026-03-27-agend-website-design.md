# AgEnD Website Design Spec

## Overview

A landing page for **AgEnD** (Agent Engine Daemon) — an open-source daemon that manages multiple AI coding agent instances, accessible from messaging apps. The website targets developers using AI coding tools, promoting adoption of the open-source project.

## Naming

- **Brand name**: AgEnD (stylized with capitals: **Ag**ent **En**gine **D**aemon)
- **CLI command**: `agend`
- **npm package**: `agend` (to be renamed from `claude-channel-daemon`)
- The brand name is backend-agnostic — AgEnD is not tied to any specific CLI tool

## Tech Stack

- **Framework**: Astro + Tailwind CSS
- **Output**: Static HTML (zero JS runtime)
- **i18n**: English (default at `/`) + Traditional Chinese (at `/zh-tw/`)
- **Deploy**: GitHub Pages via GitHub Actions
- **Location**: `website/` directory in the existing `claude-channel-daemon` repo

## Visual Style

**Dark Terminal** — GitHub Dark color palette, monospace terminal elements, developer-focused aesthetic. Inspired by tmux/Warp landing pages.

- Background: `#0d1117`
- Surface: `#161b22`
- Border: `#30363d`
- Primary text: `#f0f6fc`
- Secondary text: `#8b949e`
- Accent: `#58a6ff`
- Success: `#7ee787`
- Error: `#f85149`
- Dark mode only — no light mode toggle

## Page Structure

Single-page design with these sections:

### 1. Navigation Bar
- AgEnD logo/wordmark (left)
- Anchor links: Features, Quick Start, FAQ (center/right)
- Language switcher: EN / 中文 (right)

### 2. Hero
- Headline: "Your always-on AI engineering team"
- Subheadline: brief description of what AgEnD does
- Terminal demo block showing `agend fleet start` with multiple instances connecting
- CTA buttons: "Get Started" (scrolls to Quick Start) + "GitHub →" (external link)

### 3. Problem
- Side-by-side comparison: "Without AgEnD" vs "With AgEnD"
- Left (red ✗): one terminal = one session, close = lost, no scheduling, no cost control, agents isolated
- Right (green ✓): N projects parallel, always-on daemon, cron scheduling, cost guards, P2P collaboration

### 4. Features
- 6 feature cards in a 3×2 grid:
  - **Fleet Mode** — N agents running simultaneously
  - **Scheduling** — Cron-based task scheduling
  - **Cost Guard** — Daily spending limits
  - **P2P Collaboration** — Agents communicate with each other
  - **Context Rotation** — Auto-refresh stale sessions
  - **Multi-Backend** — Not locked to one CLI

### 5. Quick Start
- 3 steps with numbered circles:
  1. Install: `npm i -g agend`
  2. Configure: `agend init`
  3. Launch: `agend fleet start`

### 6. Architecture
- Simplified diagram: Channel (Telegram) ↔ AgEnD ↔ CLI Backends (Claude Code, future...)
- Shows AgEnD as the orchestration layer between messaging channels and coding agents

### 7. FAQ
- Collapsible Q&A items:
  - Is it free? → Open source, MIT license
  - Which backends are supported? → Claude Code now, more planned
  - Which messaging channels? → Telegram now, Discord planned
  - Does it need a server? → Runs on any machine with tmux

### 8. Footer
- Links: GitHub, npm, MIT License

## Directory Structure

```
website/
├── src/
│   ├── layouts/
│   │   └── Base.astro
│   ├── components/
│   │   ├── Hero.astro
│   │   ├── Problem.astro
│   │   ├── Features.astro
│   │   ├── QuickStart.astro
│   │   ├── Architecture.astro
│   │   ├── FAQ.astro
│   │   └── Footer.astro
│   ├── i18n/
│   │   ├── en.json
│   │   └── zh-tw.json
│   └── pages/
│       ├── index.astro
│       └── zh-tw/
│           └── index.astro
├── public/
│   └── og-image.png
├── astro.config.mjs
├── tailwind.config.mjs
└── package.json
```

## i18n Approach

- All user-facing text lives in `src/i18n/{locale}.json`
- A `t(key)` helper function resolves strings by current locale
- Components are shared between languages — only the data changes
- Language switcher in nav toggles between `/` and `/zh-tw/`

## Deployment

- GitHub Actions workflow triggers on push to `main` when `website/` changes
- Runs `astro build` in `website/` directory
- Deploys `website/dist/` to GitHub Pages
- Initially served at `<username>.github.io/<repo-name>`
- Custom domain can be added later via CNAME

## SEO

- Open Graph meta tags (title, description, image) per locale
- schema.org SoftwareApplication structured data
- `og-image.png` with AgEnD branding for social sharing
