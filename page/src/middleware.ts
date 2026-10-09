import { defineMiddleware } from 'astro:middleware';
import { cached, cacheKey, refuse } from './server.ts';

export const onRequest = defineMiddleware((context, next) => {
  const refusal = refuse(context.request);
  if (refusal) return refusal;
  const key = cacheKey(context.routePattern, context.url.origin);
  return key ? cached(key, next) : next();
});
