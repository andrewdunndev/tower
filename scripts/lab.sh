#!/bin/bash
# The prober and page under wrangler dev with a local D1, the example instance pointed at a target served here: a fast
# check, a check whose target never answers, and a 3-minute cron gap with jitter. Run from the repo root after npm ci.
set -euo pipefail
cd "$(dirname "$0")/.."
T=8797 P=8798 G=8799 I=8898
W=$PWD/node_modules/.bin/wrangler
for port in $T $P $G $I $((I + 1)); do
	if curl -s -o /dev/null "http://127.0.0.1:$port/"; then
		echo "port $port is taken"
		exit 1
	fi
done
work=$(mktemp -d) pids=""
export WRANGLER_SEND_METRICS=false WRANGLER_REGISTRY_PATH=$work/registry
stop() {
	for p in $pids; do kill -- -"$p" 2>/dev/null || true; done
	wait 2>/dev/null || true
	rm -rf "$work"
}
trap stop EXIT
set -m

node -e '
require("node:http")
	.createServer((req, res) => req.url === "/slow" || res.end("Example Domain"))
	.listen(Number(process.argv[1]), "127.0.0.1")' "$T" &
pids="$pids $!"

node tools/stage.ts example
node -e '
const fs = require("node:fs");
const [file, target] = process.argv.slice(1);
const c = JSON.parse(fs.readFileSync(file, "utf8"));
const web = c.checks.find((x) => x.id === "web");
c.timeout_ms = 30000;
c.checks = [
	{ ...web, url: `${target}/` },
	{ ...web, id: "slow", name: "Slow", url: `${target}/slow` },
];
fs.writeFileSync(file, JSON.stringify(c));' .tower/tower.json "http://127.0.0.1:$T"
npm run build -w page > "$work/build.log" 2>&1 || { tail -20 "$work/build.log"; exit 1; }
d1() { (cd prober && "$W" d1 "$@" --local --persist-to "$work/state" -c ../.tower/prober.wrangler.json); }
d1 migrations apply DB > "$work/migrate.log" 2>&1 || { tail -20 "$work/migrate.log"; exit 1; }

dev() {
	local dir=$1 port=$2
	shift 2
	(cd "$dir" && exec "$W" dev --ip 127.0.0.1 --port "$port" --inspector-port "$((port + I - P))" --show-interactive-dev-session=false "$@") \
		> "$work/$dir.log" 2>&1 < /dev/null &
	pids="$pids $!"
}
dev prober $P -c ../.tower/prober.wrangler.json --persist-to "$work/state"
dev page $G --persist-to "$work/page-state"
logs() {
	tail -20 "$work/prober.log" "$work/page.log"
	exit 1
}
up() {
	for _ in $(seq 60); do
		curl -s -o /dev/null "$1" && return
		sleep 1
	done
	echo "$1 did not answer"
	logs
}
up "http://127.0.0.1:$P/"
up "http://127.0.0.1:$G/favicon.svg"

fails=0
ok() {
	if [ "$2" = "$3" ]; then
		echo "PASS  $1 ($3)"
	else
		echo "FAIL  $1 (want $2, got $3)"
		fails=$((fails + 1))
	fi
}
tick() { curl -sSf -o /dev/null "http://127.0.0.1:$P/cdn-cgi/local/scheduled?time=$1" || logs; }

m=$((($(date +%s) - 213) / 60 * 60))
echo "== tick at :58 jitter, then 3m05s later; the slow target holds each run to its 20 s budget"
tick $(((m - 2) * 1000))
tick $(((m + 183) * 1000))

status=$(curl -sSf "http://127.0.0.1:$G/api/status") || logs
level() { node -e 'console.log(JSON.parse(process.argv[1]).checks.find((c) => c.name === process.argv[2])?.status)' "$status" "$1"; }
ok "fast check reads up" up "$(level Website)"
ok "slow check reads unknown, not down" unknown "$(level Slow)"

d1 execute DB --json --command \
	"SELECT (SELECT reason FROM state WHERE \"check\" = 'slow') AS reason, (SELECT count(*) FROM outbox) AS queued" \
	> "$work/state.json" 2> "$work/execute.log" || { tail -20 "$work/execute.log"; exit 1; }
row() { node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[0].results[0][process.argv[2]])' "$work/state.json" "$1"; }
ok "slow check verdict" "probe outlived the run" "$(row reason)"
ok "outbox drained" 0 "$(row queued)"

: > "$work/subjects"
for f in $(grep -ho 'Email: [^[:space:]]*\.eml' "$work/prober.log" | cut -c8- || true); do
	grep -h '^Subject:' "$f" >> "$work/subjects"
done
ok "no deploy mail" 0 "$(grep -c '^Subject: DEPLOYED' "$work/subjects" || true)"
ok "no SELF-CHECK mail for the gap" 0 "$(grep -c '^Subject: SELF-CHECK' "$work/subjects" || true)"

echo "failures: $fails"
[ "$fails" -eq 0 ]
