#!/usr/bin/env bash
# run_smoke.sh — submit smoke test tasks to alchemy-v2 server
set -euo pipefail

SERVER="${ALCHEMY_SERVER:-http://localhost:3002}"
TOKEN="${ALCHEMY_TOKEN:-alchemy-v2-token}"
TASKS_FILE="$(cd "$(dirname "$0")" && pwd)/tasks.json"

API_URL="$SERVER/api/tasks"

if ! command -v jq &>/dev/null; then
    echo "error: jq is required" >&2
    exit 1
fi

if ! command -v curl &>/dev/null; then
    echo "error: curl is required" >&2
    exit 1
fi

# Optional: filter by name substring
FILTER="${1:-}"

echo "=== alchemy-v2 smoke test submitter ==="
echo "server: $API_URL"
echo "tasks:  $TASKS_FILE"
[[ -n "$FILTER" ]] && echo "filter: $FILTER"
echo ""

SUBMITTED=0
SKIPPED=0

TASK_COUNT=$(jq 'length' "$TASKS_FILE")

for i in $(seq 0 $((TASK_COUNT - 1))); do
    TASK=$(jq ".[$i]" "$TASKS_FILE")
    NAME=$(echo "$TASK" | jq -r '.name')

    if [[ -n "$FILTER" && "$NAME" != *"$FILTER"* ]]; then
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    echo -n "submitting [$NAME] ... "

    RESPONSE=$(curl -s -w "\n%{http_code}" \
        -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TOKEN" \
        -d "$TASK")

    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]]; then
        TASK_ID=$(echo "$BODY" | jq -r '.id // .task.id // "?"')
        echo "OK (id=$TASK_ID, http=$HTTP_CODE)"
        SUBMITTED=$((SUBMITTED + 1))
    else
        echo "FAILED (http=$HTTP_CODE)"
        echo "  response: $BODY"
    fi
done

echo ""
echo "=== done: $SUBMITTED submitted, $SKIPPED skipped ==="
