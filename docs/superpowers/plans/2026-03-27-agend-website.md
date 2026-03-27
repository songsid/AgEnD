# AgEnD Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static landing page for AgEnD with Dark Terminal aesthetic, EN + zh-TW i18n, deployed via GitHub Pages.

**Architecture:** Astro static site in `website/` directory. Components are shared across locales; all text lives in JSON files. A `t(key)` helper resolves strings by locale. Pages at `/` (EN) and `/zh-tw/` (zh-TW).

**Tech Stack:** Astro 5, Tailwind CSS 4, GitHub Actions, GitHub Pages

---

### Task 1: Scaffold Astro Project

**Files:**
- Create: `website/package.json`
- Create: `website/astro.config.mjs`
- Create: `website/tailwind.config.mjs`
- Create: `website/tsconfig.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create the Astro project**

```bash
cd /Users/suzuke/Documents/Hack/claude-channel-daemon
mkdir -p website
cd website
npm create astro@latest -- --template minimal --no-install --no-git .
```

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/suzuke/Documents/Hack/claude-channel-daemon/website
npm install
npm install @astrojs/tailwind tailwindcss
```

- [ ] **Step 3: Configure Astro with Tailwind**

`website/astro.config.mjs`:
```js
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  integrations: [tailwind()],
  site: 'https://anthropics.github.io',
  base: '/claude-channel-daemon',
});
```

`website/tailwind.config.mjs`:
```js
export default {
  content: ['./src/**/*.{astro,html,js,ts}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d1117',
        surface: '#161b22',
        border: '#30363d',
        'text-primary': '#f0f6fc',
        'text-secondary': '#8b949e',
        accent: '#58a6ff',
        success: '#7ee787',
        error: '#f85149',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
};
```

- [ ] **Step 4: Update root .gitignore**

Append to `.gitignore`:
```
# Website
website/node_modules/
website/dist/
website/.astro/
```

- [ ] **Step 5: Verify build works**

```bash
cd /Users/suzuke/Documents/Hack/claude-channel-daemon/website
npm run build
```

Expected: Build succeeds, `website/dist/` is generated.

- [ ] **Step 6: Commit**

```bash
git add website/ .gitignore
git commit -m "feat(website): scaffold Astro project with Tailwind"
```

---

### Task 2: i18n System

**Files:**
- Create: `website/src/i18n/en.json`
- Create: `website/src/i18n/zh-tw.json`
- Create: `website/src/i18n/utils.ts`

- [ ] **Step 1: Create English translations**

`website/src/i18n/en.json`:
```json
{
  "nav": {
    "features": "Features",
    "quickstart": "Quick Start",
    "faq": "FAQ",
    "langSwitch": "中文"
  },
  "hero": {
    "headline": "Your always-on AI engineering team",
    "subheadline": "Manage multiple AI coding agents from your messaging app. Fleet mode. Scheduling. Cost guards. Always running.",
    "cta": "Get Started",
    "github": "GitHub →"
  },
  "terminal": {
    "cmd": "$ agend fleet start",
    "line1": "✓ web-app — connected via Telegram",
    "line2": "✓ api-server — connected via Telegram",
    "line3": "✓ ml-pipeline — connected via Telegram",
    "status": "Fleet running — 3 instances active"
  },
  "problem": {
    "without": "Without AgEnD",
    "withTitle": "With AgEnD",
    "pain1": "One terminal = one session",
    "pain2": "Close terminal = lost session",
    "pain3": "No scheduling",
    "pain4": "No cost control",
    "pain5": "Agents can't talk to each other",
    "gain1": "N projects in parallel",
    "gain2": "Always-on via daemon",
    "gain3": "Cron scheduling built-in",
    "gain4": "Daily cost guards",
    "gain5": "P2P agent collaboration"
  },
  "features": {
    "title": "Features",
    "fleet": { "name": "Fleet Mode", "desc": "N agents running simultaneously" },
    "schedule": { "name": "Scheduling", "desc": "Cron-based task scheduling" },
    "cost": { "name": "Cost Guard", "desc": "Daily spending limits" },
    "p2p": { "name": "P2P Collaboration", "desc": "Agents communicate with each other" },
    "rotation": { "name": "Context Rotation", "desc": "Auto-refresh stale sessions" },
    "backend": { "name": "Multi-Backend", "desc": "Not locked to one CLI" }
  },
  "quickstart": {
    "title": "Quick Start",
    "step1": { "label": "Install", "cmd": "npm i -g agend" },
    "step2": { "label": "Configure", "cmd": "agend init" },
    "step3": { "label": "Launch", "cmd": "agend fleet start" }
  },
  "architecture": {
    "title": "Architecture",
    "channel": "Telegram",
    "core": "AgEnD",
    "backend1": "Claude Code",
    "backend2": "Future CLI..."
  },
  "faq": {
    "title": "FAQ",
    "q1": "Is it free?",
    "a1": "Yes. Open source, MIT license.",
    "q2": "Which backends are supported?",
    "a2": "Claude Code today. More backends planned.",
    "q3": "Which messaging channels?",
    "a3": "Telegram today. Discord planned.",
    "q4": "Does it need a server?",
    "a4": "No. Runs on any machine with tmux."
  },
  "footer": {
    "license": "MIT License"
  }
}
```

- [ ] **Step 2: Create zh-TW translations**

`website/src/i18n/zh-tw.json`:
```json
{
  "nav": {
    "features": "功能",
    "quickstart": "快速開始",
    "faq": "常見問題",
    "langSwitch": "EN"
  },
  "hero": {
    "headline": "你的 always-on AI 工程團隊",
    "subheadline": "從通訊軟體管理多個 AI coding agent。Fleet mode、排程、花費控制，永不中斷。",
    "cta": "快速開始",
    "github": "GitHub →"
  },
  "terminal": {
    "cmd": "$ agend fleet start",
    "line1": "✓ web-app — 已透過 Telegram 連線",
    "line2": "✓ api-server — 已透過 Telegram 連線",
    "line3": "✓ ml-pipeline — 已透過 Telegram 連線",
    "status": "Fleet 運行中 — 3 個實例已啟動"
  },
  "problem": {
    "without": "沒有 AgEnD",
    "withTitle": "有了 AgEnD",
    "pain1": "一個 terminal = 一個 session",
    "pain2": "關掉 terminal = session 消失",
    "pain3": "沒有排程功能",
    "pain4": "無法控制花費",
    "pain5": "Agent 之間無法溝通",
    "gain1": "N 個專案同時運行",
    "gain2": "Daemon 常駐、永不中斷",
    "gain3": "內建 Cron 排程",
    "gain4": "每日花費上限",
    "gain5": "P2P agent 協作"
  },
  "features": {
    "title": "功能特色",
    "fleet": { "name": "Fleet Mode", "desc": "N 個 agent 同時運行" },
    "schedule": { "name": "排程系統", "desc": "Cron 定時任務" },
    "cost": { "name": "花費守衛", "desc": "每日花費上限" },
    "p2p": { "name": "P2P 協作", "desc": "Agent 互相溝通" },
    "rotation": { "name": "Context 輪替", "desc": "自動刷新過期 session" },
    "backend": { "name": "多 Backend", "desc": "不綁定單一 CLI 工具" }
  },
  "quickstart": {
    "title": "快速開始",
    "step1": { "label": "安裝", "cmd": "npm i -g agend" },
    "step2": { "label": "設定", "cmd": "agend init" },
    "step3": { "label": "啟動", "cmd": "agend fleet start" }
  },
  "architecture": {
    "title": "架構",
    "channel": "Telegram",
    "core": "AgEnD",
    "backend1": "Claude Code",
    "backend2": "未來的 CLI..."
  },
  "faq": {
    "title": "常見問題",
    "q1": "免費嗎？",
    "a1": "是的，開源專案，MIT 授權。",
    "q2": "支援哪些 backend？",
    "a2": "目前支援 Claude Code，未來會加入更多。",
    "q3": "支援哪些通訊管道？",
    "a3": "目前支援 Telegram，Discord 規劃中。",
    "q4": "需要伺服器嗎？",
    "a4": "不需要，任何有 tmux 的機器都能跑。"
  },
  "footer": {
    "license": "MIT 授權"
  }
}
```

- [ ] **Step 3: Create i18n utility**

`website/src/i18n/utils.ts`:
```ts
import en from './en.json';
import zhTw from './zh-tw.json';

const translations = { en, 'zh-tw': zhTw } as const;
export type Locale = keyof typeof translations;

export function t(locale: Locale, key: string): string {
  const keys = key.split('.');
  let val: any = translations[locale];
  for (const k of keys) {
    val = val?.[k];
  }
  return val ?? key;
}

export function langSwitchHref(locale: Locale): string {
  return locale === 'en' ? '/zh-tw/' : '/';
}
```

- [ ] **Step 4: Commit**

```bash
git add website/src/i18n/
git commit -m "feat(website): add i18n system with EN + zh-TW translations"
```

---

### Task 3: Base Layout

**Files:**
- Create: `website/src/layouts/Base.astro`

- [ ] **Step 1: Create the base layout**

`website/src/layouts/Base.astro`:
```astro
---
import type { Locale } from '../i18n/utils';
import { t, langSwitchHref } from '../i18n/utils';

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const lang = locale === 'zh-tw' ? 'zh-TW' : 'en';
---

<!doctype html>
<html lang={lang} class="scroll-smooth">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgEnD — {t(locale, 'hero.headline')}</title>
    <meta name="description" content={t(locale, 'hero.subheadline')} />
    <meta property="og:title" content={`AgEnD — ${t(locale, 'hero.headline')}`} />
    <meta property="og:description" content={t(locale, 'hero.subheadline')} />
    <meta property="og:type" content="website" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body class="bg-bg text-text-primary font-sans antialiased">
    <!-- Nav -->
    <nav class="sticky top-0 z-50 border-b border-border bg-bg/80 backdrop-blur">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <a href={locale === 'en' ? '/' : '/zh-tw/'} class="text-accent font-bold text-lg font-mono">AgEnD</a>
        <div class="flex items-center gap-6 text-sm text-text-secondary">
          <a href="#features" class="hover:text-text-primary">{t(locale, 'nav.features')}</a>
          <a href="#quickstart" class="hover:text-text-primary">{t(locale, 'nav.quickstart')}</a>
          <a href="#faq" class="hover:text-text-primary">{t(locale, 'nav.faq')}</a>
          <a href={langSwitchHref(locale)} class="border border-border rounded px-2 py-0.5 hover:text-text-primary">
            {t(locale, 'nav.langSwitch')}
          </a>
        </div>
      </div>
    </nav>

    <main class="mx-auto max-w-5xl px-6">
      <slot />
    </main>

    <!-- Footer -->
    <footer class="border-t border-border mt-24 py-8 text-center text-sm text-text-secondary">
      <div class="flex items-center justify-center gap-4">
        <a href="https://github.com/anthropics/claude-channel-daemon" class="hover:text-text-primary">GitHub</a>
        <span>·</span>
        <a href="https://www.npmjs.com/package/claude-channel-daemon" class="hover:text-text-primary">npm</a>
        <span>·</span>
        <span>{t(locale, 'footer.license')}</span>
      </div>
    </footer>
  </body>
</html>
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/suzuke/Documents/Hack/claude-channel-daemon/website
npm run build
```

Expected: Build succeeds (pages don't exist yet, but layout should compile).

- [ ] **Step 3: Commit**

```bash
git add website/src/layouts/
git commit -m "feat(website): add Base layout with nav, footer, and SEO meta"
```

---

### Task 4: Section Components

**Files:**
- Create: `website/src/components/Hero.astro`
- Create: `website/src/components/Problem.astro`
- Create: `website/src/components/Features.astro`
- Create: `website/src/components/QuickStart.astro`
- Create: `website/src/components/Architecture.astro`
- Create: `website/src/components/FAQ.astro`

- [ ] **Step 1: Hero component**

`website/src/components/Hero.astro`:
```astro
---
import type { Locale } from '../i18n/utils';
import { t } from '../i18n/utils';

interface Props { locale: Locale }
const { locale } = Astro.props;
---

<section class="py-24 text-center">
  <h1 class="text-4xl md:text-5xl font-extrabold mb-4">{t(locale, 'hero.headline')}</h1>
  <p class="text-text-secondary text-lg mb-10 max-w-2xl mx-auto">{t(locale, 'hero.subheadline')}</p>

  <!-- Terminal demo -->
  <div class="bg-surface border border-border rounded-lg p-5 max-w-lg mx-auto mb-10 text-left font-mono text-sm">
    <p class="text-success">{t(locale, 'terminal.cmd')}</p>
    <p class="text-text-secondary mt-1">{t(locale, 'terminal.line1')}</p>
    <p class="text-text-secondary">{t(locale, 'terminal.line2')}</p>
    <p class="text-text-secondary">{t(locale, 'terminal.line3')}</p>
    <p class="text-accent mt-2">{t(locale, 'terminal.status')}</p>
  </div>

  <div class="flex gap-3 justify-center">
    <a href="#quickstart" class="bg-accent text-bg font-semibold px-6 py-2.5 rounded-md hover:opacity-90">
      {t(locale, 'hero.cta')}
    </a>
    <a href="https://github.com/anthropics/claude-channel-daemon"
       class="border border-border text-text-primary px-6 py-2.5 rounded-md hover:border-text-secondary">
      {t(locale, 'hero.github')}
    </a>
  </div>
</section>
```

- [ ] **Step 2: Problem component**

`website/src/components/Problem.astro`:
```astro
---
import type { Locale } from '../i18n/utils';
import { t } from '../i18n/utils';

interface Props { locale: Locale }
const { locale } = Astro.props;

const pains = ['pain1', 'pain2', 'pain3', 'pain4', 'pain5'];
const gains = ['gain1', 'gain2', 'gain3', 'gain4', 'gain5'];
---

<section class="py-20">
  <div class="grid md:grid-cols-2 gap-6">
    <div class="bg-surface border border-border rounded-lg p-6">
      <h3 class="text-error text-lg font-semibold mb-4">✗ {t(locale, 'problem.without')}</h3>
      <ul class="space-y-2 text-text-secondary text-sm">
        {pains.map(k => <li>{t(locale, `problem.${k}`)}</li>)}
      </ul>
    </div>
    <div class="bg-surface border border-border rounded-lg p-6">
      <h3 class="text-success text-lg font-semibold mb-4">✓ {t(locale, 'problem.withTitle')}</h3>
      <ul class="space-y-2 text-text-secondary text-sm">
        {gains.map(k => <li>{t(locale, `problem.${k}`)}</li>)}
      </ul>
    </div>
  </div>
</section>
```

- [ ] **Step 3: Features component**

`website/src/components/Features.astro`:
```astro
---
import type { Locale } from '../i18n/utils';
import { t } from '../i18n/utils';

interface Props { locale: Locale }
const { locale } = Astro.props;

const features = [
  { key: 'fleet', icon: '🚢' },
  { key: 'schedule', icon: '⏰' },
  { key: 'cost', icon: '💰' },
  { key: 'p2p', icon: '🤝' },
  { key: 'rotation', icon: '🔄' },
  { key: 'backend', icon: '🔌' },
];
---

<section id="features" class="py-20">
  <h2 class="text-2xl font-bold mb-10 text-center">{t(locale, 'features.title')}</h2>
  <div class="grid md:grid-cols-3 gap-4">
    {features.map(f => (
      <div class="bg-surface border border-border rounded-lg p-5 text-center">
        <div class="text-3xl mb-3">{f.icon}</div>
        <h3 class="font-semibold mb-1">{t(locale, `features.${f.key}.name`)}</h3>
        <p class="text-text-secondary text-sm">{t(locale, `features.${f.key}.desc`)}</p>
      </div>
    ))}
  </div>
</section>
```

- [ ] **Step 4: QuickStart component**

`website/src/components/QuickStart.astro`:
```astro
---
import type { Locale } from '../i18n/utils';
import { t } from '../i18n/utils';

interface Props { locale: Locale }
const { locale } = Astro.props;

const steps = ['step1', 'step2', 'step3'];
---

<section id="quickstart" class="py-20">
  <h2 class="text-2xl font-bold mb-10 text-center">{t(locale, 'quickstart.title')}</h2>
  <div class="grid md:grid-cols-3 gap-8 text-center">
    {steps.map((s, i) => (
      <div>
        <div class="bg-accent text-bg w-8 h-8 rounded-full inline-flex items-center justify-center font-bold text-sm mb-3">
          {i + 1}
        </div>
        <h3 class="font-semibold mb-2">{t(locale, `quickstart.${s}.label`)}</h3>
        <code class="text-text-secondary text-sm bg-surface border border-border rounded px-3 py-1.5 inline-block font-mono">
          {t(locale, `quickstart.${s}.cmd`)}
        </code>
      </div>
    ))}
  </div>
</section>
```

- [ ] **Step 5: Architecture component**

`website/src/components/Architecture.astro`:
```astro
---
import type { Locale } from '../i18n/utils';
import { t } from '../i18n/utils';

interface Props { locale: Locale }
const { locale } = Astro.props;
---

<section class="py-20">
  <h2 class="text-2xl font-bold mb-10 text-center">{t(locale, 'architecture.title')}</h2>
  <div class="flex items-center justify-center gap-4 font-mono text-sm flex-wrap">
    <div class="border border-border rounded-md px-4 py-2">📱 {t(locale, 'architecture.channel')}</div>
    <span class="text-text-secondary">↔</span>
    <div class="border-2 border-accent rounded-md px-4 py-2 text-accent font-bold">{t(locale, 'architecture.core')}</div>
    <span class="text-text-secondary">↔</span>
    <div class="flex flex-col gap-1">
      <div class="border border-border rounded px-3 py-1 text-success text-xs">{t(locale, 'architecture.backend1')}</div>
      <div class="border border-border rounded px-3 py-1 text-text-secondary text-xs">{t(locale, 'architecture.backend2')}</div>
    </div>
  </div>
</section>
```

- [ ] **Step 6: FAQ component**

`website/src/components/FAQ.astro`:
```astro
---
import type { Locale } from '../i18n/utils';
import { t } from '../i18n/utils';

interface Props { locale: Locale }
const { locale } = Astro.props;

const items = ['1', '2', '3', '4'];
---

<section id="faq" class="py-20">
  <h2 class="text-2xl font-bold mb-10 text-center">{t(locale, 'faq.title')}</h2>
  <div class="max-w-2xl mx-auto divide-y divide-border">
    {items.map(i => (
      <details class="group py-4">
        <summary class="cursor-pointer font-semibold text-text-primary hover:text-accent flex items-center justify-between">
          {t(locale, `faq.q${i}`)}
          <span class="text-text-secondary group-open:rotate-45 transition-transform text-lg">+</span>
        </summary>
        <p class="mt-2 text-text-secondary text-sm">{t(locale, `faq.a${i}`)}</p>
      </details>
    ))}
  </div>
</section>
```

- [ ] **Step 7: Commit**

```bash
git add website/src/components/
git commit -m "feat(website): add all section components"
```

---

### Task 5: Pages (EN + zh-TW)

**Files:**
- Create: `website/src/pages/index.astro`
- Create: `website/src/pages/zh-tw/index.astro`

- [ ] **Step 1: English page**

`website/src/pages/index.astro`:
```astro
---
import Base from '../layouts/Base.astro';
import Hero from '../components/Hero.astro';
import Problem from '../components/Problem.astro';
import Features from '../components/Features.astro';
import QuickStart from '../components/QuickStart.astro';
import Architecture from '../components/Architecture.astro';
import FAQ from '../components/FAQ.astro';

const locale = 'en' as const;
---

<Base locale={locale}>
  <Hero locale={locale} />
  <Problem locale={locale} />
  <Features locale={locale} />
  <QuickStart locale={locale} />
  <Architecture locale={locale} />
  <FAQ locale={locale} />
</Base>
```

- [ ] **Step 2: zh-TW page**

`website/src/pages/zh-tw/index.astro`:
```astro
---
import Base from '../../layouts/Base.astro';
import Hero from '../../components/Hero.astro';
import Problem from '../../components/Problem.astro';
import Features from '../../components/Features.astro';
import QuickStart from '../../components/QuickStart.astro';
import Architecture from '../../components/Architecture.astro';
import FAQ from '../../components/FAQ.astro';

const locale = 'zh-tw' as const;
---

<Base locale={locale}>
  <Hero locale={locale} />
  <Problem locale={locale} />
  <Features locale={locale} />
  <QuickStart locale={locale} />
  <Architecture locale={locale} />
  <FAQ locale={locale} />
</Base>
```

- [ ] **Step 3: Verify dev server**

```bash
cd /Users/suzuke/Documents/Hack/claude-channel-daemon/website
npm run dev
```

Open `http://localhost:4321/` and `http://localhost:4321/zh-tw/` — verify both pages render with all sections.

- [ ] **Step 4: Verify build**

```bash
cd /Users/suzuke/Documents/Hack/claude-channel-daemon/website
npm run build
```

Expected: `dist/index.html` and `dist/zh-tw/index.html` generated.

- [ ] **Step 5: Commit**

```bash
git add website/src/pages/
git commit -m "feat(website): add EN and zh-TW pages"
```

---

### Task 6: GitHub Actions Deployment

**Files:**
- Create: `.github/workflows/deploy-website.yml`

- [ ] **Step 1: Create workflow**

`.github/workflows/deploy-website.yml`:
```yaml
name: Deploy Website

on:
  push:
    branches: [main]
    paths: ['website/**']
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install and build
        working-directory: website
        run: |
          npm ci
          npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: website/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy-website.yml
git commit -m "ci: add GitHub Actions workflow for website deployment"
```

---

### Task 7: Final Polish

**Files:**
- Create: `website/public/favicon.svg`
- Modify: `website/src/layouts/Base.astro` (add global CSS reset if needed)

- [ ] **Step 1: Create favicon**

`website/public/favicon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#0d1117"/>
  <text x="16" y="22" text-anchor="middle" font-family="monospace" font-size="14" font-weight="bold" fill="#58a6ff">A</text>
</svg>
```

- [ ] **Step 2: Verify full build one last time**

```bash
cd /Users/suzuke/Documents/Hack/claude-channel-daemon/website
npm run build
ls -la dist/
ls -la dist/zh-tw/
```

Expected: Both `dist/index.html` and `dist/zh-tw/index.html` exist.

- [ ] **Step 3: Commit**

```bash
git add website/public/
git commit -m "feat(website): add favicon"
```
