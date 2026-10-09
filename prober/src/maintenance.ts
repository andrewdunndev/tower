import type { Instance } from "../../tools/schema.ts";

export const inWindow = (config: Instance, id: string, t: number) =>
	config.maintenance.some((w) => w.checks.includes(id) && Date.parse(w.start) <= t && t < Date.parse(w.end));
