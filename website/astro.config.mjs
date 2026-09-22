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
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-tw': { label: '繁體中文', lang: 'zh-TW' },
      },
      sidebar: [
        { label: 'Getting Started', slug: 'docs/getting-started' },
        { label: 'Features', slug: 'docs/features' },
        { label: 'CLI Reference', slug: 'docs/cli' },
        { label: 'Configuration', slug: 'docs/configuration' },
      ],
      disable404Route: true,
    }),
  ],
});
