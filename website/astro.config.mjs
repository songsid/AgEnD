import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import starlight from '@astrojs/starlight';

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
  site: 'https://songsid.github.io',
  base: '/AgEnD',
  integrations: [
    starlight({
      title: 'AgEnD Docs',
      favicon: '/favicon.svg',
      logo: { src: './src/assets/logo.svg', alt: 'AgEnD' },
      head: [
        { tag: 'link', attrs: { rel: 'alternate icon', type: 'image/x-icon', href: '/AgEnD/favicon.ico' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/AgEnD/apple-touch-icon.png' } },
      ],
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-tw': { label: '繁體中文', lang: 'zh-TW' },
      },
      sidebar: [
        { label: "What's new in 2.3", translations: { 'zh-TW': '2.3 更新重點' }, slug: 'docs/whats-new' },
        { label: "What's new in 2.2", translations: { 'zh-TW': '2.2 更新重點' }, slug: 'docs/whats-new-2-2' },
        { label: 'Getting Started', slug: 'docs/getting-started' },
        { label: 'Web Guide', translations: { 'zh-TW': '網頁使用說明' }, slug: 'docs/web-guide' },
        { label: 'Use Cases', translations: { 'zh-TW': '使用情境' }, slug: 'docs/use-cases' },
        { label: 'Features', slug: 'docs/features' },
        { label: 'CLI Reference', slug: 'docs/cli' },
        { label: 'Configuration', slug: 'docs/configuration' },
      ],
      disable404Route: true,
    }),
  ],
});
