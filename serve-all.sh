#!/usr/bin/env bash
# Serve every build in ./build/review on its own port (3000, 3001, …) for side-by-side review.
# Usage: ./serve-all.sh [start-port]     Stop: ./serve-all.sh stop
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
REVIEW="$ROOT/build/review"
PIDFILE="$ROOT/.serve-all.pids"

if [ "${1:-}" = "stop" ]; then
  [ -f "$PIDFILE" ] && while read -r pid; do kill "$pid" 2>/dev/null; done < "$PIDFILE"
  rm -f "$PIDFILE"; echo "stopped"; exit 0
fi

PORT="${1:-3000}"
: > "$PIDFILE"
for dir in "$REVIEW"/*/; do
  [ -f "$dir/index.html" ] || continue
  # Free the port if a previous run left something on it.
  lsof -ti tcp:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null
  # A wired build ships its own server (src/behavior.ts emits it): same static serving PLUS a real
  # POST /api/submit, so the cloned forms actually submit during review. python3 is the fallback.
  if [ -f "$dir/server.mjs" ]; then
    node "$dir/server.mjs" "$PORT" >/dev/null 2>&1 &
    NOTE=" (forms live)"
  else
    python3 -m http.server "$PORT" --directory "$dir" >/dev/null 2>&1 &
    NOTE=""
  fi
  echo $! >> "$PIDFILE"
  printf '  http://localhost:%s   %s%s\n' "$PORT" "$(basename "$dir")" "$NOTE"
  PORT=$((PORT + 1))
done
echo
echo "stop with: ./serve-all.sh stop"
