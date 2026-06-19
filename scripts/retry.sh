#!/usr/bin/env bash
set -euo pipefail

attempts="${RETRY_ATTEMPTS:-3}"

if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "RETRY_ATTEMPTS must be a positive integer." >&2
  exit 2
fi

if [ "$#" -eq 0 ]; then
  echo "usage: retry.sh <command> [args...]" >&2
  exit 2
fi

for attempt in $(seq 1 "$attempts"); do
  if "$@"; then
    exit 0
  fi

  if [ "$attempt" -eq "$attempts" ]; then
    exit 1
  fi

  sleep $((attempt * 10))
done
