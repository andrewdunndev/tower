import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^\.\.\/services\.json$/, replacement: new URL('./test/services.json', import.meta.url).pathname },
      { find: 'cloudflare:email', replacement: new URL('./test/cloudflare-email.js', import.meta.url).pathname },
    ],
  },
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
