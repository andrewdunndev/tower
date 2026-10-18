import { handle } from '@astrojs/cloudflare/handler';
import page from '../../.tower/page.json';
import { watch } from './server.ts';

export default {
  fetch: handle,
  scheduled: (controller, env) => watch(env, page.alert, controller.scheduledTime, page.digest),
} satisfies ExportedHandler<Env>;
