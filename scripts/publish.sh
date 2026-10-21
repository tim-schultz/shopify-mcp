#!/usr/bin/env bash
# Run on the host machine: push source and prepare a draft tarball release.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

for executable in git gh node; do
  command -v "$executable" >/dev/null || { echo "Required on host: $executable" >&2; exit 1; }
done

expected_remote='https://github.com/tim-schultz/shopify-mcp.git'
repository='tim-schultz/shopify-mcp'
if [[ "$(git remote get-url origin)" != "$expected_remote" ]]; then
  echo "origin must be $expected_remote" >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != 'main' ]]; then
  echo 'Run from the main branch.' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit or stash local changes before publishing.' >&2
  exit 1
fi

tag="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; console.log("v" + JSON.parse(readFileSync("package.json", "utf8")).version)')"
commit="$(git rev-parse HEAD)"
if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  if [[ "$(git rev-parse "refs/tags/$tag^{commit}")" != "$commit" ]]; then
    echo "$tag already points to another commit; refusing to move it." >&2
    exit 1
  fi
fi

# Confirm GitHub authentication before the first write. Never print credentials.
gh auth status >/dev/null 2>&1 || { echo 'Run gh auth login on the host first.' >&2; exit 1; }
git push -u origin main
if ! git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  git tag "$tag" "$commit"
fi
git push origin "refs/tags/$tag"

# GitHub may take a moment to index a workflow after the first repository push.
workflow_ready=false
for attempt in {1..10}; do
  if gh workflow view release.yml --repo "$repository" >/dev/null 2>&1; then
    workflow_ready=true
    break
  fi
  sleep 2
done
if [[ "$workflow_ready" != true ]]; then
  echo 'Source and tag pushed; workflow indexing is still pending. Start Prepare tarball release in GitHub Actions.' >&2
  exit 1
fi

gh workflow run release.yml --repo "$repository" --ref main -f "tag=$tag"
echo "Source pushed: https://github.com/$repository"
echo "Release workflow: https://github.com/$repository/actions/workflows/release.yml"
echo "After it succeeds, review and publish the draft: https://github.com/$repository/releases"
