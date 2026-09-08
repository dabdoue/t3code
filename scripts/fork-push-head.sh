#!/usr/bin/env bash
set -euo pipefail

# Push the current HEAD to the GitHub fork remote so remotes can build that SHA.
# Fails if the worktree is dirty or the `fork` remote is missing. Does not commit.

remote="${T3CODE_FORK_REMOTE:-fork}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git checkout" >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" == "HEAD" ]]; then
  echo "HEAD is detached; check out a branch before pushing to ${remote}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "worktree is dirty; commit or stash before installing this fork on another machine" >&2
  git status --short --untracked-files=all >&2
  exit 1
fi

if ! git remote get-url "$remote" >/dev/null 2>&1; then
  echo "missing git remote '${remote}' (expected your GitHub fork, e.g. dabdoue/t3code)" >&2
  exit 1
fi

sha="$(git rev-parse HEAD)"
git push "$remote" HEAD
echo "sha=${sha}"
