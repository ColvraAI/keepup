#!/usr/bin/env bash
# Runs a command for an upstream repo inside Docker, so its dependencies' install
# scripts, build scripts and tests never execute on the host (docs/contracts.md).
#
#   scripts/sandbox.sh anything-llm <worktree> <command...>
#   scripts/sandbox.sh aura         <worktree> <command...>
#
# The Docker VM here has 4 GB, so only one sandbox runs at a time. SANDBOX_NO_LOCK=1
# skips the queue for a short read-only command. Keys are passed by name with
# SANDBOX_ENV="OPENAI_API_KEY ANTHROPIC_API_KEY", so their values never reach a
# command line. A worktree's .git file points at a host path that doesn't exist in
# the container, so it's masked with /dev/null.
#
# Stopping this script stops its container: docker run is a background job, so a signal
# reaches the traps below at once, instead of after the container ends. The lock holds this
# script's pid and its container's name, so a lock whose holder has died is cleared on the
# next run, along with whatever it left running.
set -euo pipefail

kind="${1:?anything-llm or aura}"
worktree="$(cd "${2:?worktree path}" && pwd)"
shift 2
root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/tmp/.sandbox-lock"
mkdir -p "$root/tmp"

poll="${SANDBOX_LOCK_POLL:-5}"
container="keepup-sandbox-$$-$RANDOM"
holds_lock=0
docker_pid=""

release_lock() {
  if [ "$holds_lock" = 1 ]; then
    rm -f "$lock/pid" "$lock/container"
    rmdir "$lock" 2>/dev/null || true
    holds_lock=0
  fi
}

# The CLI can still be creating the container when a signal lands, so docker kill gets a few tries while it lives.
stop_container() {
  [ -n "$docker_pid" ] || return 0
  for _ in 1 2 3; do
    docker kill "$container" >/dev/null 2>&1 && break
    kill -0 "$docker_pid" 2>/dev/null || break
    sleep 1
  done
  wait "$docker_pid" 2>/dev/null || true
}

on_signal() {
  trap - INT TERM HUP
  stop_container
  release_lock
  exit "$1"
}

trap release_lock EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

# Whether the lock's holder has gone. One with no pid is an older lock, or one being taken this instant, so only age clears it.
holder_gone() {
  local pid command
  pid="$(cat "$lock/pid" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    [ -n "$(find "$lock" -maxdepth 0 -mmin +40 2>/dev/null)" ]
    return
  fi
  kill -0 "$pid" 2>/dev/null || return 0
  command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$command" in
    ""|*sandbox*) return 1 ;;
    *) return 0 ;;
  esac
}

clear_stale_lock() {
  local stale="$lock.stale.$$" old
  mv "$lock" "$stale" 2>/dev/null || return 0
  old="$(cat "$stale/container" 2>/dev/null || true)"
  echo "sandbox: the last run is gone and left its lock, so it's cleared." >&2
  if [ -n "$old" ]; then
    docker kill "$old" >/dev/null 2>&1 || true
  fi
  rm -rf "$stale"
}

if [ "${SANDBOX_NO_LOCK:-}" != 1 ]; then
  waited=0
  until mkdir "$lock" 2>/dev/null; do
    if holder_gone; then
      clear_stale_lock
      continue
    fi
    if [ $((waited % 12)) -eq 0 ]; then
      echo "sandbox: waiting for the other run (pid $(cat "$lock/pid" 2>/dev/null || echo unknown)) to finish..." >&2
    fi
    sleep "$poll"
    waited=$((waited + 1))
  done
  holds_lock=1
  echo "$$" > "$lock/pid"
  echo "$container" > "$lock/container"
fi

env_args=()
for name in ${SANDBOX_ENV:-}; do
  env_args+=(-e "$name")
done

case "$kind" in
  anything-llm)
    docker run --rm --init --name "$container" -e TINI_KILL_PROCESS_GROUP=1 --memory=3500m "${env_args[@]+"${env_args[@]}"}" \
      -v "$worktree":/repo \
      -v /dev/null:/repo/.git:ro \
      -v "$root/lab":/lab:ro \
      -v "$root/lab/.work":/lab-work \
      -v keepup-all-root-nm:/repo/node_modules \
      -v "${SANDBOX_SERVER_VOLUME:-keepup-all-server-nm}":/repo/server/node_modules \
      -v keepup-all-collector-nm:/repo/collector/node_modules \
      -v keepup-all-frontend-nm:/repo/frontend/node_modules \
      -v keepup-hf-cache:/hf-cache \
      -e PUPPETEER_SKIP_DOWNLOAD=true -e SHARP_IGNORE_GLOBAL_LIBVIPS=true -e CI=true \
      -e NODE_ENV=test \
      -w /repo node:18-bookworm bash -c "$*" &
    ;;
  aura)
    docker run --rm --init --name "$container" -e TINI_KILL_PROCESS_GROUP=1 --memory=3500m "${env_args[@]+"${env_args[@]}"}" \
      -v "$worktree":/repo \
      -v /dev/null:/repo/.git:ro \
      -v "$root/lab":/lab:ro \
      -v "$root/lab/.work":/lab-work \
      -v keepup-aura-cargo:/usr/local/cargo/registry \
      -v keepup-aura-cargo-git:/usr/local/cargo/git \
      -v keepup-aura-target:/target \
      -e CARGO_TARGET_DIR=/target -e CARGO_BUILD_JOBS=3 -e CARGO_TERM_COLOR=never \
      -w /repo rust:1.95-bookworm bash -c "$*" &
    ;;
  *)
    echo "unknown sandbox: $kind" >&2
    exit 2
    ;;
esac

docker_pid=$!
status=0
wait "$docker_pid" || status=$?
exit "$status"
