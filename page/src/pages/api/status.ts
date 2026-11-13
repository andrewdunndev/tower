import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { statusResponse } from "../../server.ts";

export const GET: APIRoute = () => statusResponse(env.TOWER);
