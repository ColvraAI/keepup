#!/usr/bin/env bash
# Runs Claude Code on a stranger's repo without ever starting a session on this host.
# A session started inside a repo can load its hooks, MCP servers and settings, so sessions here
# happen only in a container, on a copy with those files gone. Nothing in the copy is executed.
#
#   scripts/skill-session.sh image                                  build the image, Claude Code inside it
#   scripts/skill-session.sh stage                                  copy the marketplace to tmp/, without .env or the rest of this repo
#   scripts/skill-session.sh copy <name> <git dir> <commit> [dest]  git archive of tracked files, the risky files removed
#   scripts/skill-session.sh shell <name> [dest] -- <command...>    run a command in the container, in the copy
#   scripts/skill-session.sh session <name> <label> <usd> <model> <prompt> [allowed tools] [dest]
#                                                                   a real headless session; raw events in out/<label>.jsonl
#   scripts/skill-session.sh clean                                  remove the copies, the volume and the image
#
# Mounts: the staged marketplace read-only at /market, the copy, and one output folder at /out. Home is
# a named volume, so an install persists between runs and the person's real ~/.claude is never involved.
# ANTHROPIC_API_KEY is passed by name, from the environment or .env, and never printed.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
base="${SKILL_SESSION_DIR:-$root/tmp/skill-session}"
image="keepup-skill-session"
volume="keepup-skill-home"
# Every file or folder here is something Claude Code or another tool could load from a repo.
removed=(.claude .mcp.json CLAUDE.md CLAUDE.local.md AGENTS.md .cursor .vscode .devcontainer .github)

valid_name() {
  case "$1" in
    ''|*[!a-zA-Z0-9._-]*) echo "skill-session: bad name: $1" >&2; exit 2 ;;
  esac
}

build_image() {
  docker build -q -t "$image" - <<'DOCKERFILE'
FROM node:22-bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates tmux >/dev/null && npm install -g --silent @anthropic-ai/claude-code && mkdir -p /work /out /market && chown node /work /out
USER node
ENV DISABLE_AUTOUPDATER=1 CI=
DOCKERFILE
}

# Only what a marketplace install reads, so .env can't reach a container.
stage_market() {
  local market="$base/market"
  rm -rf "$market"
  mkdir -p "$market"
  # Symlinks stay symlinks here, so a plugin that leans on files outside its folder fails here as it would for anyone.
  local paths=(.claude-plugin plugin) link
  for link in "$root"/plugin/* "$root"/plugin/data/*; do
    [ -L "$link" ] || continue
    paths+=("$(cd "$(dirname "$link")" && cd "$(dirname "$(readlink "$(basename "$link")")")" && pwd -P | sed "s|^$root/*||")/$(basename "$(readlink "$link")")")
  done
  ( cd "$root" && tar -cf - "${paths[@]#/}" ) | tar -xf - -C "$market"
  [ ! -e "$market/.env" ] || { echo "skill-session: .env reached the staged marketplace" >&2; exit 1; }
}

sanitised_copy() {
  local name="$1" gitdir="$2" commit="$3" dest="${4:-$1}"
  valid_name "$name"
  local target="$base/$name/$dest"
  rm -rf "$target"
  mkdir -p "$target" "$base/$name/out"
  git --git-dir="$gitdir" archive --format=tar "$commit" | tar -xf - -C "$target"
  local args=() item
  for item in "${removed[@]}"; do args+=(-name "$item" -o); done
  unset 'args[${#args[@]}-1]'
  find "$target" -depth \( "${args[@]}" \) -exec rm -rf {} +
  printf '%s\n' "$commit" > "$base/$name/commit"
  echo "$target"
}

load_key() {
  [ -z "${ANTHROPIC_API_KEY:-}" ] || return 0
  [ -f "$root/.env" ] || return 0
  # The same reading as lab/shared/env.ts: last one wins, one pair of quotes comes off, and the value is never echoed.
  ANTHROPIC_API_KEY="$(sed -n 's/^[[:space:]]*ANTHROPIC_API_KEY[[:space:]]*=[[:space:]]*//p' "$root/.env" | tail -n 1 | sed -e 's/[[:space:]]*$//' -e "s/^\(['\"]\)\(.*\)\1\$/\2/")"
  export ANTHROPIC_API_KEY
}

shell_in_copy() {
  local name="$1"; shift
  valid_name "$name"
  local dest="$name"
  if [ "${1:-}" != "--" ]; then dest="$1"; shift; fi
  [ "${1:-}" = "--" ] && shift
  local copy="$base/$name/$dest"
  [ -d "$copy" ] || { echo "skill-session: no copy at $copy; run copy first" >&2; exit 2; }
  [ -d "$base/market" ] || { echo "skill-session: no staged marketplace; run stage first" >&2; exit 2; }
  mkdir -p "$base/$name/out"
  load_key
  docker run --rm -i \
    --cap-drop ALL --security-opt no-new-privileges --memory 3g --pids-limit 512 \
    -e ANTHROPIC_API_KEY \
    -v "$volume:/home/node" \
    --mount "type=bind,source=$base/market,target=/market,readonly" \
    --mount "type=bind,source=$copy,target=/work/$dest" \
    --mount "type=bind,source=$base/$name/out,target=/out" \
    -w "/work/$dest" \
    "$image" "$@"
}

# Run inside the container: the copy gets its own history, so branches and commits work and nothing of the upstream's .git comes along.
init_inside='git rev-parse --git-dir >/dev/null 2>&1 || { git init -q -b main; git add -A; git -c user.name=copy -c user.email=copy@example.invalid commit -qm "sanitised copy"; }; git config user.name "keepup session"; git config user.email "session@example.invalid"'

run_session() {
  local name="$1" label="$2" usd="$3" model="$4" prompt="$5" allowed="${6:-}" dest="${7:-$1}"
  local flags=(-p "$prompt" --setting-sources user --model "$model" --max-budget-usd "$usd" --output-format stream-json --verbose)
  [ -z "$allowed" ] || flags+=(--allowedTools "$allowed")
  shell_in_copy "$name" "$dest" -- sh -c "$init_inside; exec claude \"\$@\" </dev/null > \"/out/$label.jsonl\" 2> \"/out/$label.err\"" sh "${flags[@]}"
}

command="${1:-}"
[ $# -gt 0 ] && shift
case "$command" in
  image) build_image ;;
  stage) stage_market; echo "$base/market" ;;
  copy) sanitised_copy "${1:?name}" "${2:?git dir}" "${3:?commit}" "${4:-$1}" ;;
  shell) shell_in_copy "${1:?name}" "${@:2}" ;;
  session) run_session "${1:?name}" "${2:?label}" "${3:?usd}" "${4:?model}" "${5:?prompt}" "${6:-}" "${7:-$1}" ;;
  clean)
    rm -rf "$base"
    docker volume rm -f "$volume" >/dev/null 2>&1 || true
    docker image rm -f "$image" >/dev/null 2>&1 || true
    ;;
  *) sed -n '6,13p' "$0" >&2; exit 2 ;;
esac
