import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  devToolbar: { enabled: false },
  server: { port: 4321 },
  vite: { build: { assetsInlineLimit: 0 } },
});
