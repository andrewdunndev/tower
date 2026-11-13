import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { healthResponse } from "../server.ts";

export const GET: APIRoute = () => healthResponse(env.TOWER);
