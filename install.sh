#!/usr/bin/env bash
# Installs keepup as a Claude Code plugin: shows the two commands, asks, then runs them.
# curl -fsSL https://raw.githubusercontent.com/ColvraAI/keepup/main/install.sh | bash
# Everything is in main, which runs on the last line, so a cut-off download runs nothing.
set -eu

MIN_MAJOR=22
MIN_MINOR=18

fail() {
  printf 'keepup: %s\n' "$1" >&2
  exit 1
}

check_node() {
  command -v node >/dev/null 2>&1 ||
    fail "Node isn't on your PATH. keepup needs Node $MIN_MAJOR.$MIN_MINOR or later. Install it from https://nodejs.org, or run: nvm install $MIN_MAJOR"
  version=$(node --version)
  numbers=${version#v}
  major=${numbers%%.*}
  rest=${numbers#*.}
  minor=${rest%%.*}
  if [ "$major" -gt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]; }; then
    return 0
  fi
  fail "you have Node $version, and keepup needs $MIN_MAJOR.$MIN_MINOR or later, because Node runs its TypeScript directly. Install it from https://nodejs.org, or run: nvm install $MIN_MAJOR"
}

check_claude() {
  command -v claude >/dev/null 2>&1 ||
    fail "Claude Code isn't on your PATH (no 'claude' command). Install it with: npm install -g @anthropic-ai/claude-code. See https://claude.com/claude-code"
}

# Reads from the terminal, not stdin, because in curl | bash stdin is this script.
confirm() {
  answer=
  if ! { read -r answer <"${KEEPUP_TTY:-/dev/tty}"; } 2>/dev/null && [ -z "$answer" ]; then
    fail "there's no terminal to ask on, so nothing was changed. To say yes up front, run it with --yes."
  fi
  case "$answer" in
    y | Y | yes | YES) return 0 ;;
    *)
      printf 'keepup: nothing was changed.\n'
      exit 0
      ;;
  esac
}

main() {
  yes=no
  for arg in "$@"; do
    case "$arg" in
      --yes | -y) yes=yes ;;
      *) fail "unknown option: $arg. The only option is --yes." ;;
    esac
  done

  source=${KEEPUP_SOURCE:-ColvraAI/keepup}
  check_node
  check_claude

  printf 'This will run two commands:\n\n'
  printf '  claude plugin marketplace add %s\n' "$source"
  printf '  claude plugin install keepup@keepup\n\n'
  printf "They change Claude Code's settings, for your user, and touch nothing else.\n"
  printf 'To undo it later:\n\n'
  printf '  claude plugin uninstall keepup@keepup\n'
  printf '  claude plugin marketplace remove keepup\n\n'

  if [ "$yes" = no ]; then
    printf 'Go ahead? [y/N] '
    confirm
  fi

  claude plugin marketplace add "$source"
  claude plugin install keepup@keepup

  printf '\nDone. Next, in the repo you want checked:\n\n'
  printf '  cd your-repo\n  claude\n\n'
  printf 'and type /keepup\n'
}

main "$@"
