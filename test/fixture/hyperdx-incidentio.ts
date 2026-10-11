// DEFAULT_INCIDENT_IO_WEBHOOK_BODY from hyperdxio/hyperdx main, 2026-10-10,
// packages/common-utils/src/types.ts:716-734, verbatim apart from AlertState.OK.
const TEMPLATE = `{
  "title": "{{title}}",
  "description": "{{body}}",
  "deduplication_key": "{{eventId}}",
  "status": "{{#if (eq state "OK")}}resolved{{else}}firing{{/if}}",
  "source_url": "{{link}}",
  "metadata": {
    "alert_id": "{{alertId}}",
    "hyperdx_status": "{{status}}",
    "alert_type": "{{alertType}}",
    "comparator": "{{comparator}}",
    "threshold": "{{threshold}}",
    "threshold_max": "{{thresholdMax}}",
    "value": "{{value}}",
    "group_key": "{{groupKey}}",
    "window_start": "{{startTimeISO}}",
    "window_end": "{{endTimeISO}}"
  }
}`;

export function hyperdx(state: "ALERT" | "OK", eventId = "evt-1"): string {
	const values: Record<string, string> = {
		title: "Alert for Errors - 12 exceeds 10",
		body: "12 errors in the last 5 minutes",
		eventId,
		link: "https://hyperdx.example.com/search/abc",
		alertId: "alert-1",
		status: state,
		alertType: "search",
		comparator: ">=",
		threshold: "10",
		thresholdMax: "",
		value: "12",
		groupKey: "",
		startTimeISO: "2026-10-08T11:55:00.000Z",
		endTimeISO: "2026-10-08T12:00:00.000Z",
	};
	return TEMPLATE.replace(
		/\{\{#if \(eq state "OK"\)\}\}resolved\{\{else\}\}firing\{\{\/if\}\}/,
		state === "OK" ? "resolved" : "firing",
	).replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name]);
}
