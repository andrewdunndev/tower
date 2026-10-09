import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { beat } from '../../server.ts';

export const POST: APIRoute = ({ request }) => beat(request, env);
