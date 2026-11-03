#!/usr/bin/env bash
# Installs keepup as a Claude Code plugin: shows the two commands, asks, then runs them.
# curl -fsSL https://raw.githubusercontent.com/ColvraAI/keepup/main/install.sh | bash
# With --codex it sets keepup up for Codex CLI instead: a clone of the engine and two skills made from the same SKILL.md files.
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

# --- Codex CLI ---
# Codex puts no plugin bin/ on PATH and gives a skill no variable, so the skills name the shim and the data folder by
# absolute path. That's why HOME must need no quoting: the paths go into Markdown, TOML, JSON and a hook command.
ROOTS_MARK='# added by keepup install.sh --codex'
SKILL_MARK='<!-- made by keepup install.sh --codex -->'

codex_paths() {
  case "$HOME" in
    '' | *[!A-Za-z0-9._/-]*) fail "your home folder ($HOME) has a character keepup would have to quote in Codex's files, so nothing was changed." ;;
  esac
  keepup_home=$HOME/.keepup
  repo=$keepup_home/repo
  data=$keepup_home/data
  shim=$repo/plugin/bin/keepup
  skills=$HOME/.agents/skills
  codex_home=${CODEX_HOME:-$HOME/.codex}
  config=$codex_home/config.toml
  hooks=$codex_home/hooks.json
  roots_line="writable_roots = [\"$data\"] $ROOTS_MARK"
  hook_command="$shim check . --weekly-state $data/weekly-check.json --hook"
}

check_codex() {
  command -v codex >/dev/null 2>&1 ||
    fail "Codex CLI isn't on your PATH (no 'codex' command). Install it with: npm install -g @openai/codex"
}

hooks_json() {
  printf '{\n  "hooks": {\n    "SessionStart": [\n      { "hooks": [{ "type": "command", "command": "%s", "timeout": 5 }] }\n    ]\n  }\n}\n' "$hook_command"
}

# The four edits and nothing else, so a test can undo them and get the source back.
generate_skill() {
  if [ -f "$skills/$2/SKILL.md" ] && ! grep -qxF "$SKILL_MARK" "$skills/$2/SKILL.md"; then
    printf '\nYou already have %s, and keepup did not make it, so it was left alone. Move it away and run the install again to get keepup'"'"'s.\n' "$skills/$2/SKILL.md"
    return 0
  fi
  mkdir -p "$skills/$2"
  sed -E \
    -e '/^allowed-tools:/d' \
    -e "s/^name: .*/name: $2/" \
    -e 's#/keepup:apply#$keepup-apply#g' \
    -e 's#/keepup#$keepup#g' \
    -e "s#^keepup (prepare|bundles|get|search|show|levers|verify|pr-body|issue-body|check|measure|run) #$shim \\1 #" \
    -e "s#\`keepup #\`$shim #g" \
    -e "s#[$][{]CLAUDE_PLUGIN_DATA[}]#$data#g" \
    "$1" >"$skills/$2/SKILL.md"
  printf '%s\n' "$SKILL_MARK" >>"$skills/$2/SKILL.md"
}

place_repo() {
  if [ -d "$source" ]; then
    [ -L "$repo" ] || [ ! -e "$repo" ] ||
      fail "$repo is already a clone, so it wasn't replaced with a link. Run ./install.sh --codex --uninstall first."
    ln -sfn "$source" "$repo"
  elif [ -e "$repo" ]; then
    printf 'keepup: %s is already there. To update it: git -C %s pull\n' "$repo" "$repo"
  else
    command -v git >/dev/null 2>&1 || fail "git isn't on your PATH, and the install clones keepup with it."
    git clone --depth 1 "https://github.com/$source.git" "$repo"
  fi
}

write_config() {
  if [ -f "$config" ] && grep -qE '^[[:space:]]*\[sandbox_workspace_write\]|^[[:space:]]*sandbox_workspace_write\.' "$config"; then
    grep -qF "\"$data\"" "$config" ||
      printf '\nYour %s already has a sandbox_workspace_write table, so it was left alone. Add this line to that table:\n\n  writable_roots = ["%s"]\n' "$config" "$data"
    return 0
  fi
  if [ -s "$config" ]; then printf '\n\n' >>"$config"; fi
  printf '[sandbox_workspace_write]\n%s\n' "$roots_line" >>"$config"
}

write_hooks() {
  if [ -e "$hooks" ]; then
    [ "$(cat "$hooks")" = "$(hooks_json)" ] ||
      printf '\nYou already have %s, so it was left alone. For the weekly line, add a SessionStart command hook, timeout 5:\n\n  %s\n' "$hooks" "$hook_command"
    return 0
  fi
  hooks_json >"$hooks"
}

codex_install() {
  if [ -d "$source" ]; then what="a link to $source"; else what="a clone of $source"; fi
  printf 'This will set keepup up for Codex CLI:\n\n'
  printf '  %s: %s\n' "$repo" "$what"
  printf '  %s/keepup and %s/keepup-apply: two skills made from the SKILL.md files Claude Code uses\n' "$skills" "$skills"
  printf '  %s: the folder keepup writes to\n' "$data"
  printf '  %s: writable_roots = ["%s"], so keepup writes there without asking, unless you have that table already\n' "$config" "$data"
  printf '  %s: a SessionStart hook for the weekly line, unless you have that file already\n\n' "$hooks"
  printf 'To undo it later: %s/install.sh --codex --uninstall\n\n' "$repo"
  ask_first
  mkdir -p "$keepup_home" "$data" "$codex_home"
  place_repo
  [ -f "$repo/skills/keepup/SKILL.md" ] || fail "$repo has no skills/keepup/SKILL.md, so it isn't a keepup checkout."
  generate_skill "$repo/skills/keepup/SKILL.md" keepup
  generate_skill "$repo/skills/apply/SKILL.md" keepup-apply
  write_config
  write_hooks
  printf '\nDone. Next, in the repo you want checked:\n\n  cd your-repo\n  codex\n\n'
  printf 'Run /hooks once to trust the weekly hook. Then type $keepup, or say "use keepup".\n'
  printf '$keepup-apply makes the change on a branch, and Codex asks before each git step.\n'
  printf 'The weekly GitHub run and /keepup:weekly are Claude Code only for now.\n'
}

# Only a SKILL.md the install made, and the folder only when nothing else is in it.
remove_skill() {
  grep -qxF "$SKILL_MARK" "$skills/$1/SKILL.md" 2>/dev/null || return 0
  rm "$skills/$1/SKILL.md"
  rmdir "$skills/$1" 2>/dev/null || true
}

# Takes out the roots line write_config appended. The header goes too only when the table holds nothing else:
# TOML tables run past blank lines, so it scans on, over blanks and comments, to the next header or the end.
remove_roots() {
  [ -f "$config" ] && grep -qxF "$roots_line" "$config" || return 1
  if awk -v roots="$roots_line" '
    { line[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        if (line[i] != roots) continue
        skip[i] = 1; found = 1
        if (line[i - 1] != "[sandbox_workspace_write]") continue
        j = i + 1
        while (j <= NR && line[j] ~ /^[ \t]*(#.*)?$/) j++
        if (j <= NR && line[j] !~ /^[ \t]*\[/) continue
        skip[i - 1] = 1
        if (line[i - 2] == "") skip[i - 2] = 1
        if (line[i - 3] == "") skip[i - 3] = 1
      }
      if (!found) exit 1
      for (i = 1; i <= NR; i++) if (!skip[i]) print line[i]
    }' "$config" >"$config.keepup"; then
    mv "$config.keepup" "$config"
  else
    rm -f "$config.keepup"
    return 1
  fi
  if [ ! -s "$config" ]; then rm -f "$config"; fi
}

remove_hooks() {
  [ -f "$hooks" ] || return 0
  if [ "$(cat "$hooks")" = "$(hooks_json)" ]; then
    rm "$hooks"
  else
    printf 'If %s has the keepup hook, take it out yourself: %s\n' "$hooks" "$hook_command"
  fi
}

codex_uninstall() {
  printf 'This will remove keepup from Codex CLI:\n\n'
  printf '  %s/keepup and %s/keepup-apply\n  %s\n' "$skills" "$skills" "$repo"
  printf '  the writable root and the hook, where the install wrote them\n\n'
  printf 'It leaves %s, which holds your briefs. To remove that too: rm -rf %s\n\n' "$data" "$data"
  ask_first
  remove_skill keepup
  remove_skill keepup-apply
  if [ -L "$repo" ]; then rm "$repo"; elif [ -d "$repo" ]; then rm -rf "$repo"; fi
  if ! remove_roots && [ -f "$config" ] && grep -qF "\"$data\"" "$config"; then
    printf 'Take this out of %s yourself: writable_roots = ["%s"]\n' "$config" "$data"
  fi
  remove_hooks
  printf '\nDone. keepup is gone from Codex.\n'
}

ask_first() {
  if [ "$yes" = no ]; then
    printf 'Go ahead? [y/N] '
    confirm
  fi
}

codex_main() {
  codex_paths
  if [ "$uninstall" = yes ]; then
    codex_uninstall
    return 0
  fi
  check_node
  check_codex
  codex_install
}

main() {
  yes=no
  codex=no
  uninstall=no
  for arg in "$@"; do
    case "$arg" in
      --yes | -y) yes=yes ;;
      --codex) codex=yes ;;
      --uninstall) uninstall=yes ;;
      *) fail "unknown option: $arg. The options are --yes, --codex and --codex --uninstall." ;;
    esac
  done

  source=${KEEPUP_SOURCE:-ColvraAI/keepup}
  if [ "$codex" = yes ]; then
    codex_main
    return 0
  fi
  [ "$uninstall" = no ] ||
    fail "--uninstall goes with --codex. For Claude Code, run: claude plugin uninstall keepup@keepup, then: claude plugin marketplace remove keepup"
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
