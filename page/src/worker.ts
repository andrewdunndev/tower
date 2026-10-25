import { handle } from '@astrojs/cloudflare/handler';

export default {
  fetch: handle,
  scheduled: (controller, env) => env.TOWER.watch(controller.scheduledTime),
} satisfies ExportedHandler<Env>;
