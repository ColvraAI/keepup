#!/usr/bin/env bash
# Runs inside the aura Docker sandbox. For each line of <work>/cases.tsv it starts
# the AURA release binary that case names with that case's config, sends the one chat request to its
# OpenAI-compatible endpoint, saves what came back under <work>/raw/<case>/ and stops
# the server. Keys arrive by name through the environment, so none is ever on a
# command line, and only AURA reads them.
#
#   run-cases.sh <work dir>
set -uo pipefail

work="${1:?work dir}"
port=18080
url="http://127.0.0.1:$port"

# Trace for rig's request log, so the raw output shows what AURA really sent. None of
# these filters logs headers, so no key reaches the log; the host scrubs every file anyway.
export RUST_LOG='aura=info,aura_web_server=info,aura_config=info,rig::completions=trace,rig::providers::anthropic=trace,rig::providers::openai=trace'
export NO_COLOR=1
# Without this AURA hides the provider's error behind a generic message.
export AURA_DEBUG_PROVIDER_ERRORS=true
export HOST=127.0.0.1 PORT="$port"

wait_for_health() {
  local out="$1" pid="$2" tries=0
  until curl -sS -m 2 -o "$out/health.json" "$url/health" 2>/dev/null; do
    kill -0 "$pid" 2>/dev/null || return 1
    tries=$((tries + 1))
    [ "$tries" -ge 60 ] && return 1
    sleep 1
  done
}

send_chat() {
  local out="$1" request="$2"
  curl -sS -m 600 -o "$out/response.json" -w '%{http_code}' \
    -H 'content-type: application/json' --data-binary "@$request" \
    "$url/v1/chat/completions" > "$out/http_status.txt" 2> "$out/curl_error.txt"
}

run_case() {
  local id="$1" config="$2" request="$3" aura="$4"
  local out="$work/raw/$id"
  mkdir -p "$out"
  "$aura" --version > "$out/version.txt" 2>&1
  cp "$config" "$out/config.toml"
  cp "$request" "$out/request.json"
  CONFIG_PATH="$config" "$aura" webserver > "$out/server.log" 2>&1 &
  local pid=$!
  if wait_for_health "$out" "$pid"; then
    send_chat "$out" "$request"
  else
    echo 'server did not become healthy' > "$out/startup_failed.txt"
  fi
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

while IFS=$'\t' read -r id config request aura; do
  [ -n "$id" ] && run_case "$id" "$config" "$request" "$aura"
done < "$work/cases.tsv"
exit 0
