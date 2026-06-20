#!/usr/bin/env bash
set -euo pipefail

attempts="${RETRY_ATTEMPTS:-3}"
retry_exit_codes="${RETRY_EXIT_CODES:-}"

if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "RETRY_ATTEMPTS must be a positive integer." >&2
  exit 2
fi

if [ "$#" -eq 0 ]; then
  echo "usage: retry.sh <command> [args...]" >&2
  exit 2
fi

if [ -n "$retry_exit_codes" ]; then
  for code in ${retry_exit_codes//,/ }; do
    if ! [[ "$code" =~ ^[0-9]+$ ]]; then
      echo "RETRY_EXIT_CODES must contain numeric exit codes." >&2
      exit 2
    fi
  done
fi

should_retry() {
  local status="$1"

  if [ -z "$retry_exit_codes" ]; then
    return 0
  fi

  for code in ${retry_exit_codes//,/ }; do
    if [ "$status" -eq "$code" ]; then
      return 0
    fi
  done

  return 1
}

for attempt in $(seq 1 "$attempts"); do
  if "$@"; then
    exit 0
  fi
  status="$?"

  if [ "$attempt" -eq "$attempts" ]; then
    exit "$status"
  fi

  if ! should_retry "$status"; then
    exit "$status"
  fi

  sleep $((attempt * 10))
done
