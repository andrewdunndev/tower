import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { relay } from "../../server.ts";

export const POST: APIRoute = ({ request }) => relay(request, env);
