#!/usr/bin/env bash
# Runs inside the aura sandbox, whose image has no Node. Installs the exact Node this lab
# needs, checked against nodejs.org's own checksums, and the official MCP SDK with no
# install scripts. Everything lands under <tools dir>, on /lab-work, and nothing else is
# touched. It does nothing when both are already there.
#   setup.sh <tools dir> <node version> <sdk version>
set -euo pipefail

tools="${1:?tools dir}"
node_version="${2:?node version}"
sdk_version="${3:?sdk version}"

case "$(uname -m)" in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "no Node build for $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$tools"
if [ ! -x "$tools/node/bin/node" ]; then
  name="node-v$node_version-linux-$arch.tar.gz"
  base="https://nodejs.org/dist/v$node_version"
  download="$(mktemp -d)"
  curl -fsSL "$base/$name" -o "$download/$name"
  curl -fsSL "$base/SHASUMS256.txt" -o "$download/SHASUMS256.txt"
  (cd "$download" && grep " $name\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  mkdir -p "$tools/node"
  tar -xzf "$download/$name" -C "$tools/node" --strip-components=1
  rm -rf "$download"
fi

export PATH="$tools/node/bin:$PATH"
export npm_config_cache=/tmp/npm-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

if [ ! -f "$tools/sdk/node_modules/@modelcontextprotocol/sdk/package.json" ]; then
  mkdir -p "$tools/sdk"
  npm install --prefix "$tools/sdk" --ignore-scripts --save-exact "@modelcontextprotocol/sdk@$sdk_version" >/dev/null
fi
