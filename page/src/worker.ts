import { handle } from '@astrojs/cloudflare/handler';
import page from '../../.tower/page.json';
import { cacheLatch, watch } from './server.ts';

const latch = cacheLatch();

export default {
  fetch: handle,
  scheduled: (controller, env) => watch(env, page.alert, controller.scheduledTime, latch),
} satisfies ExportedHandler<Env>;
