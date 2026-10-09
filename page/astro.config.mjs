import cloudflare from '@astrojs/cloudflare';
import { satteri } from '@astrojs/markdown-satteri';
import { defineConfig } from 'astro/config';

const dropRawHtml = { name: 'drop-raw-html', html: (node, ctx) => ctx.removeNode(node) };

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'compile' }),
  session: false,
  markdown: { processor: satteri({ mdastPlugins: [dropRawHtml] }) },
  security: { csp: { directives: ["default-src 'self'", "img-src 'self'"] } },
});
