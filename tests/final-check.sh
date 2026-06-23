#!/usr/bin/env bash
set -euo pipefail

PORT="${FINAL_CHECK_PORT:-3011}"
TEST_TMPDIR="${TEST_TMPDIR:-/tmp}"
DB_PATH="${TEST_TMPDIR%/}/threads-final-check-$$.db"
LOG_PATH="${TEST_TMPDIR%/}/threads-final-check-$$.log"
BASE_URL="http://127.0.0.1:${PORT}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$DB_PATH" "$DB_PATH-journal" "$DB_PATH-wal" "$DB_PATH-shm" "$LOG_PATH"
}
trap cleanup EXIT

echo "[final] migrating isolated database..."
RUST_LOG=debug DATABASE_URL="file:${DB_PATH}" npx prisma migrate deploy >/dev/null

echo "[final] building app against isolated database..."
DATABASE_URL="file:${DB_PATH}" npx next build >/dev/null

echo "[final] starting isolated Next.js server on ${BASE_URL}..."
DATABASE_URL="file:${DB_PATH}" npx next start -p "$PORT" >"$LOG_PATH" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "${BASE_URL}" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "[final] server exited early. log:"
    tail -80 "$LOG_PATH" || true
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "${BASE_URL}" >/dev/null 2>&1; then
  echo "[final] server did not become ready. log:"
  tail -120 "$LOG_PATH" || true
  exit 1
fi

echo "[final] running user-flow checks..."
DATABASE_URL="file:${DB_PATH}" BASE_URL="$BASE_URL" node --import tsx tests/final-check.test.ts
