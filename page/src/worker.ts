import { handle } from '@astrojs/cloudflare/handler';
import page from '../../.tower/page.json';
import { memoryLatch } from '../../prober/src/latch.ts';
import { watch } from './server.ts';

const latch = memoryLatch();

export default {
  fetch: handle,
  scheduled: (controller, env) => watch(env, page.alert, controller.scheduledTime, latch),
} satisfies ExportedHandler<Env>;
