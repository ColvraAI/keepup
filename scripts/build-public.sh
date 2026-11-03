#!/usr/bin/env bash
# Rebuilds the local branch named public as one commit on top of the last public
# commit (the first build has no parent), from a commit on main, leaving out the working notes. It uses a temporary index, so the
# working tree and the real index aren't touched, and it never pushes.
#
#   scripts/build-public.sh [source-commit]    (default: main)
#
# The commit takes its dates from the source commit, so the same source on the same
# previous commit gives the same commit id, and `git push origin public:main` always fast-forwards.
set -euo pipefail

SOURCE_REF="${1:-main}"
BRANCH=public
AUTHOR_NAME=kunalbhatia18
AUTHOR_EMAIL=kunalbhatia18@users.noreply.github.com
LEFT_OUT=(
  thoughts/ docs/plan
  NOW.md
  DECISIONS.md
  docs/prompts.md
  docs/what-the-audit-found.md
  docs/reference/prototype
  .claude
  CLAUDE.md
  DEMO.md
  docs/script.md
  AGENTS.md
  .agents
  docs/commands.md
  scripts/audit-instructions.ts
  scripts/audit-instructions.test.ts
)
# A file that ships must not point at one that doesn't. These are checked in everything
# but this script, along with the committer's own email, read from git config.
PRIVATE_STRINGS=(thoughts/shared docs/plan NOW.md DECISIONS.md docs/commands.md audit-instructions)
# This repo's .agents/skills is private, but the person's own ~/.agents/skills is where the Codex install
# writes, so a path under ~, $HOME or ${HOME} is allowed and any other mention is not.
PRIVATE_PATTERN='(^|[^/])\.agents/skills|(^|[^~E}])/\.agents/skills'

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ "$(git symbolic-ref --quiet --short HEAD || true)" = "$BRANCH" ]; then
  echo "build-public: $BRANCH is checked out here; switch to another branch first" >&2
  exit 2
fi

source_commit="$(git rev-parse --verify "$SOURCE_REF^{commit}")"
source_date="$(git log -1 --format=%aI "$source_commit")"
MESSAGE="keepup: public release from ${source_commit:0:12}"

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
export GIT_INDEX_FILE="$temp_dir/index"

git read-tree "$source_commit"
git rm -r -q -f --cached --ignore-unmatch -- "${LEFT_OUT[@]}"

for path in "${LEFT_OUT[@]}"; do
  if [ -n "$(git ls-files -- "$path")" ]; then
    echo "build-public: $path is still in the tree" >&2
    exit 1
  fi
done

tree="$(git write-tree)"
unset GIT_INDEX_FILE

previous="$(git rev-parse --verify --quiet "refs/heads/$BRANCH" || true)"
if [ -n "$previous" ] && [ "$(git rev-parse "$previous^{tree}")" = "$tree" ]; then
  echo "$BRANCH is unchanged at $previous: $source_commit gives the same public tree"
  exit 0
fi

grep_args=()
for text in "${PRIVATE_STRINGS[@]}" "$(git config user.email || true)"; do
  [ -n "$text" ] && grep_args+=(-e "$text")
done
if git grep -n -I -F "${grep_args[@]}" "$tree" -- . ':(exclude)scripts/build-public.sh' >&2 ||
  git grep -n -I -E -e "$PRIVATE_PATTERN" "$tree" -- . ':(exclude)scripts/build-public.sh' >&2; then
  echo "build-public: the lines above name something private; $BRANCH was not changed" >&2
  exit 1
fi

commit="$(
  GIT_AUTHOR_NAME="$AUTHOR_NAME" GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" GIT_AUTHOR_DATE="$source_date" \
  GIT_COMMITTER_NAME="$AUTHOR_NAME" GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" GIT_COMMITTER_DATE="$source_date" \
  git commit-tree "$tree" ${previous:+-p "$previous"} -m "$MESSAGE"
)"

git update-ref "refs/heads/$BRANCH" "$commit"
echo "$BRANCH is now $commit, built from $source_commit"
