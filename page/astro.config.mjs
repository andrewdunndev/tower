import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'compile' }),
  session: false,
  security: { csp: { directives: ["default-src 'self'", "img-src 'self'"] } },
});
