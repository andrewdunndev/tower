import { run } from './check.js';
import { respond } from './page.js';

export default {
  fetch(request, env) {
    return respond(request, env);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};
