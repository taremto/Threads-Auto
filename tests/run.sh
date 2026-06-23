#!/bin/bash
# クラウドオフロードの統合テスト実行スクリプト
# Mock GAS サーバを立てて、Web側の主要コードを実通信で検証する。
#
# 使い方:
#   npm run test:cloud
#   または直接: bash tests/run.sh

set -e
cd "$(dirname "$0")/.."

PORT=${MOCK_GAS_PORT:-5555}
TEST_TMPDIR="${TEST_TMPDIR:-/tmp}"
TEST_DB_PATH="${TEST_TMPDIR%/}/threads-auto-webapp-test-${PORT}.db"
TEST_DB="file:${TEST_DB_PATH}"
export RUST_LOG=debug
export TMPDIR="$TEST_TMPDIR"

echo "[test] cleanup..."
rm -f "$TEST_DB_PATH" "$TEST_DB_PATH-journal" "$TEST_DB_PATH-wal" "$TEST_DB_PATH-shm"

echo "[test] migrating test.db..."
RUST_LOG=debug DATABASE_URL="$TEST_DB" npx prisma migrate deploy >/dev/null

echo "[test] starting mock GAS on port $PORT..."
MOCK_GAS_PORT=$PORT node tests/mock-gas-server.mjs > /tmp/mock-gas.log 2>&1 &
MOCK_PID=$!
cleanup() {
  kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
  rm -f "$TEST_DB_PATH" "$TEST_DB_PATH-journal" "$TEST_DB_PATH-wal" "$TEST_DB_PATH-shm"
}
trap cleanup EXIT

# 起動待ち（最大5秒）
READY=0
for i in {1..50}; do
  if curl -s "http://localhost:$PORT/__state" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.1
done
if [ "$READY" -ne 1 ]; then
  echo "[test] mock GAS failed to start. Last log:"
  tail -n 30 /tmp/mock-gas.log 2>/dev/null || true
  exit 1
fi

echo "[test] running integration tests..."
DATABASE_URL="$TEST_DB" node --import tsx tests/integration.test.ts

echo "[test] done."
