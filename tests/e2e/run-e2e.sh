#!/usr/bin/env bash
# Live prompt-cache regression for the persistent fallback delivery.
# Usage: tests/e2e/run-e2e.sh <repo-dir> [model]   (default model: zai/glm-5.3-flash)
# Requires pi on PATH with working auth for the chosen provider.
set -euo pipefail

REPO="$1"
MODEL="${2:-zai/glm-5.3-flash}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$(cd "$HERE/../.." && pwd)/src/index.ts"
LOG_DIR="${PROBE_DIR:-$(mktemp -d /tmp/ancestor-e2e.XXXXXX)}"
SESSIONS="$REPO/.e2e-sessions"

mkdir -p "$LOG_DIR"
cd "$REPO"
echo "logs: $LOG_DIR"

P1="Read tools/chain-solana-qa/notes.md with the read tool, then answer with only its first line."
P2="Now read tools/chain-solana-qa/goals.md with the read tool and answer with only its first line. After that, read tools/chain-solana-qa/limits.md with the read tool and answer with only its first line. Do the two reads one after another, each in its own step."
P3="Finally, read tools/chain-solana-qa/notes.md again with the read tool and answer with only its first line."
# errscan phase 1: a stripped read plus a long-running second tool call; the
# process is killed mid-turn, before pi flushes the pending fallback batch,
# so the resume must deliver it at session_start.
P_KILL="Read tools/chain-solana-qa/notes.md with the read tool. Then run the bash tool with command: sleep 30. After the sleep finishes, answer with only the first line of notes.md."

run() { # run <scenario> <phase> <prompt> [extra args...]
	local scenario="$1" phase="$2" prompt="$3"; shift 3
	PROBE_LOG="$LOG_DIR/$scenario-$phase.jsonl" pi -ne \
		-e "$EXT" -e "$HERE/probe.ts" "$@" \
		--model "$MODEL" --thinking off --session-dir "$SESSIONS/$scenario" \
		$([ "$phase" -gt 1 ] && echo -c) -p "$prompt" >/dev/null
}

for scenario in clean stripped errscan; do
	rm -rf "$SESSIONS/$scenario"; mkdir -p "$SESSIONS/$scenario"
done

for phase in 1 2 3; do
	prompt="$P1"; [ "$phase" = 2 ] && prompt="$P2"; [ "$phase" = 3 ] && prompt="$P3"
	run clean "$phase" "$prompt"
done

for phase in 1 2 3; do
	prompt="$P1"; [ "$phase" = 2 ] && prompt="$P2"; [ "$phase" = 3 ] && prompt="$P3"
	run stripped "$phase" "$prompt" -e "$HERE/stripper.ts"
done

# errscan: phase 1 dies inside the sleep, with a stripped tool result and no
# flushed batch in the session file; phases 2 and 3 resume normally.
	PROBE_LOG="$LOG_DIR/errscan-1.jsonl" timeout -s KILL 15 pi -ne \
		-e "$EXT" -e "$HERE/probe.ts" -e "$HERE/stripper.ts" \
		--model "$MODEL" --thinking off --session-dir "$SESSIONS/errscan" \
		-p "$P_KILL" >/dev/null 2>&1 || true
kill_batches=$(grep -h '"custom_message"' "$SESSIONS/errscan"/*.jsonl 2>/dev/null | grep -c ancestor-agentsmd || true)
echo "errscan: batches persisted before kill: $kill_batches (expected 0)"
[ "$kill_batches" = "0" ] || { echo "errscan setup failed: batch already flushed before kill" >&2; exit 1; }
run errscan 2 "$P2" -e "$HERE/stripper.ts"
run errscan 3 "$P3" -e "$HERE/stripper.ts"

bun "$HERE/analyze.ts" "$LOG_DIR" "$SESSIONS"
