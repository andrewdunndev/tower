import { defineMiddleware } from 'astro:middleware';
import { cached, refuse } from './server.ts';

export const onRequest = defineMiddleware((context, next) => {
  const refusal = refuse(context.request);
  if (refusal) return refusal;
  const { pathname } = context.url;
  if (context.request.method === 'GET' && (pathname === '/' || pathname === '/api/status')) {
    return cached(context.request, next);
  }
  return next();
});
