#!/usr/bin/env bash
# Publish a new Clipeer version with one command.
#
# Usage:   bash scripts/release.sh <version> "<description>"
# Example: bash scripts/release.sh 0.3.3 "Tray menu now shows the app version"
#
# What it does:
#   1. sets the version in package.json / package-lock.json
#   2. commits everything and pushes the current branch
#   3. creates the tag v<version> with your description as its message
#   4. pushes the tag, which starts the GitHub Actions build and release
#
# The description becomes the body of the GitHub release (multi-line text is fine).

set -euo pipefail

usage() {
  echo "Usage: bash scripts/release.sh <version> \"<description>\""
  echo "Example: bash scripts/release.sh 0.3.3 \"Tray menu now shows the app version\""
  exit 1
}

[[ $# -ge 2 ]] || usage
VERSION="${1#v}"
MESSAGE="$2"
TAG="v$VERSION"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: '$1' is not a valid version (expected something like 0.3.3)"; exit 1
fi
if [[ -z "${MESSAGE//[[:space:]]/}" ]]; then
  echo "Error: the description is empty"; exit 1
fi

cd "$(git rev-parse --show-toplevel)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "HEAD" ]] || { echo "Error: detached HEAD, checkout a branch first"; exit 1; }

# Stop if the tag already exists, locally or on GitHub
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Error: tag $TAG already exists locally. Pick another version, or delete it with: git tag -d $TAG"; exit 1
fi
git fetch -q origin
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists on GitHub. Pick another version."; exit 1
fi

# Stop if GitHub has commits we do not have yet
if git rev-parse -q --verify "origin/$BRANCH" >/dev/null; then
  BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH")"
  if [[ "$BEHIND" -gt 0 ]]; then
    echo "Error: origin/$BRANCH has $BEHIND commit(s) you do not have. Run 'git pull' first."; exit 1
  fi
fi

echo "==> Version $VERSION on branch $BRANCH"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

git add -A
SUBJECT="$(printf '%s' "$MESSAGE" | head -n 1)"
if git diff --cached --quiet; then
  echo "==> Nothing to commit, tagging the current commit"
else
  git commit -q -m "Release $TAG: $SUBJECT"
fi

git tag -a "$TAG" -m "$MESSAGE"

echo "==> Pushing $BRANCH and $TAG"
git push --atomic origin "$BRANCH" "$TAG"

REMOTE_URL="$(git remote get-url origin | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##')"
echo
echo "Done. The build is running:   $REMOTE_URL/actions"
echo "The release will appear at:   $REMOTE_URL/releases/tag/$TAG"
