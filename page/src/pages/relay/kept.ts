import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { kept } from '../../server.ts';

export const GET: APIRoute = ({ request }) => kept(request, env);
