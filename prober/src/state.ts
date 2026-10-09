export interface Track {
	avail: boolean;
	fails: number;
	passes: number;
	since: number;
}

export function step(
	s: Track,
	ok: boolean,
	now: number,
	limits: { down_after: number; up_after: number },
): { next: Track; transition: "down" | "up" | null } {
	if (ok) {
		if (s.avail) return { next: { ...s, fails: 0, passes: 0 }, transition: null };
		const passes = s.passes + 1;
		if (passes < limits.up_after) return { next: { ...s, passes }, transition: null };
		return { next: { avail: true, fails: 0, passes: 0, since: now }, transition: "up" };
	}
	if (!s.avail) return { next: { ...s, passes: 0 }, transition: null };
	const fails = s.fails + 1;
	if (fails < limits.down_after) return { next: { ...s, fails }, transition: null };
	return { next: { avail: false, fails: 0, passes: 0, since: now }, transition: "down" };
}
